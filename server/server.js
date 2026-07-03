import express from "express";
import cron from "node-cron";
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

/* ============================================================
   CONFIG (from environment — never hardcode keys)
   ============================================================ */
const PORT          = process.env.PORT || 4319;
const GOVEE_KEY     = process.env.GOVEE_API_KEY || "";
const PASSCODE      = process.env.PASSCODE || "";            // shared secret the PWA sends
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";   // for /ai/* (SDK reads it too)
const LAT           = process.env.LAT ? Number(process.env.LAT) : null;  // for "sunset" schedules
const LON           = process.env.LON ? Number(process.env.LON) : null;
const MODEL         = "claude-opus-4-8";

// Where the JSON stores live. Railway's container disk is EPHEMERAL — set
// DATA_DIR to a mounted Railway Volume (e.g. /data) so automations + triggers
// survive redeploys. Defaults to this folder for local runs.
const DATA_DIR      = process.env.DATA_DIR || fileURLToPath(new URL(".", import.meta.url));
try { mkdirSync(DATA_DIR, { recursive: true }); } catch { /* already exists */ }
const STORE_PATH    = join(DATA_DIR, "automations.json");

const GOVEE_BASE = "https://openapi.api.govee.com/router/api/v1";
const anthropic  = new Anthropic();   // reads ANTHROPIC_API_KEY

// Keep the proxy alive: a stray rejected promise or thrown error (a Govee API
// hiccup, a disk write, a bad cron callback) should be LOGGED, never exit the
// process — otherwise Railway reports a crash and restarts the whole service.
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", (e && e.message) || e));
process.on("uncaughtException",  (e) => console.error("uncaughtException:",  (e && e.message) || e));
// Railway sends SIGTERM to stop the OLD container on every redeploy — that's
// expected, not a crash. Exit 0 explicitly so it's reported as a clean stop.
process.on("SIGTERM", () => { console.log("SIGTERM received — shutting down cleanly"); process.exit(0); });
process.on("SIGINT",  () => { console.log("SIGINT received — shutting down cleanly");  process.exit(0); });

const app = express();
app.use(express.json({ limit: "256kb" }));

/* ---------- CORS + passcode gate ---------- */
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, X-Passcode");
  res.set("Access-Control-Allow-Methods", "GET, POST, DELETE, PATCH, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

/* ---------- serve the PWA front-end from this same service ----------
   One Railway URL serves both the app (index.html/scenes.html at repo root)
   and the API routes below. Static files are matched first; anything that
   isn't a file (e.g. /health, /govee/*) falls through to the routes. */
const STATIC_DIR = fileURLToPath(new URL("..", import.meta.url));
app.use(express.static(STATIC_DIR));

const gate = (req, res, next) => {
  if (!PASSCODE) return next();                       // no passcode configured = open
  if (req.get("X-Passcode") === PASSCODE) return next();
  return res.status(401).json({ error: "bad passcode" });
};

app.get("/health", (_req, res) =>
  res.json({ ok: true, govee: !!GOVEE_KEY, ai: !!ANTHROPIC_KEY, automations: store.length, dataDir: DATA_DIR }));

/* ============================================================
   GOVEE CLOUD API
   ============================================================ */
async function govee(path, body) {
  const res = await fetch(GOVEE_BASE + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "Govee-API-Key": GOVEE_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`govee ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}

let deviceMap = {};   // device id -> { sku, deviceName, capabilities }
async function listDevices() {
  const j = await govee("/user/devices");
  const devices = (j.data || []).map((d) => ({
    sku: d.sku, device: d.device, deviceName: d.deviceName,
    type: d.type, capabilities: d.capabilities,
  }));
  deviceMap = Object.fromEntries(devices.map((d) => [d.device, d]));
  return devices;
}
async function resolveSku(deviceId) {
  if (deviceMap[deviceId]) return deviceMap[deviceId].sku;
  await listDevices();
  if (!deviceMap[deviceId]) throw new Error("unknown device " + deviceId);
  return deviceMap[deviceId].sku;
}
function normalizeState(payload) {
  const caps = payload?.capabilities || [];
  const get = (inst) => caps.find((c) => c.instance === inst)?.state?.value;
  const online = get("online");
  return {
    online: online === undefined ? true : !!online,
    on: get("powerSwitch") === 1,
    brightness: get("brightness") ?? 100,
    color: get("colorRgb") ?? (255 << 16) | (255 << 8) | 255,
  };
}
async function control(deviceId, type, instance, value) {
  const sku = await resolveSku(deviceId);
  return govee("/device/control", {
    requestId: randomUUID(),
    payload: { sku, device: deviceId, capability: { type, instance, value } },
  });
}
// thin wrappers used by the scene engine + automations
const setPower  = (id, on)  => control(id, "devices.capabilities.on_off",        "powerSwitch", on ? 1 : 0);
const setBright = (id, v)   => control(id, "devices.capabilities.range",         "brightness",  v);
const setColor  = (id, rgb) => control(id, "devices.capabilities.color_setting", "colorRgb",    rgb);

app.get("/govee/devices", gate, async (_req, res) => {
  try { res.json({ data: await listDevices() }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.post("/govee/state", gate, async (req, res) => {
  try {
    const sku = await resolveSku(req.body.device);
    const j = await govee("/device/state", {
      requestId: randomUUID(), payload: { sku, device: req.body.device },
    });
    res.json({ data: normalizeState(j.payload) });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post("/govee/control", gate, async (req, res) => {
  try {
    const { device, capability, instance, value } = req.body;
    await control(device, capability, instance, value);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ============================================================
   SCENE ENGINE  (static apply or gentle server-side animation)
   scene = { name, motion, step(ms), targets:[deviceName], cols:[[r,g,b]] }
   ============================================================ */
const rgbInt = ([r, g, b]) => (r << 16) | (g << 8) | b;
let animTimer = null;

function nameToDevice(name) {
  const d = Object.values(deviceMap).find((x) => x.deviceName === name);
  return d ? d.device : null;
}
async function applyScene(scene) {
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  if (!Object.keys(deviceMap).length) await listDevices();
  const ids = (scene.targets || []).map(nameToDevice).filter(Boolean);
  const cols = (scene.cols || []).map(rgbInt);
  if (!ids.length || !cols.length) return;

  await Promise.allSettled(ids.map((id) => setPower(id, true)));
  const paint = (offset) =>
    Promise.allSettled(ids.map((id, i) => setColor(id, cols[(i + offset) % cols.length])));
  await paint(0);

  if (scene.motion) {
    const step = Math.max(800, scene.step || 1500);   // floor protects the rate limit
    let off = 0;
    animTimer = setInterval(() => { off = (off + 1) % cols.length; paint(off); }, step);
  }
}

app.post("/govee/scene", gate, async (req, res) => {
  try { await applyScene(req.body); res.json({ ok: true }); }
  catch (e) { res.status(502).json({ error: e.message }); }
});
app.post("/govee/stop", gate, (_req, res) => {
  if (animTimer) { clearInterval(animTimer); animTimer = null; }
  Object.keys(segAnimTimers).forEach(stopSegAnim);
  res.json({ ok: true });
});

/* ============================================================
   SEGMENT SCENES  ("movement up and down the strand")
   Only runs on devices that report segment_color_setting (RGBIC
   strips). Two patterns:
   - "chase": a lit band of `bandWidth` segments sweeps back and
     forth (ping-pong), like a Knight Rider / comet effect.
   - "wave": segments are bucketed into `cols.length` color groups
     that rotate position each tick — a flowing barber-pole.
   Each tick sends only 1-2 control calls per device regardless of
   segment count, to stay rate-limit friendly.
   ============================================================ */
let segAnimTimers = {};   // deviceId -> interval handle, independent per device
function stopSegAnim(id) { if (segAnimTimers[id]) { clearInterval(segAnimTimers[id]); delete segAnimTimers[id]; } }
function deviceSegCount(id) {
  const d = deviceMap[id]; if (!d) return 0;
  const cap = (d.capabilities || []).find((c) => c.type === "devices.capabilities.segment_color_setting");
  if (!cap) return 0;
  const f = (cap.parameters?.fields || []).find((x) => /segment/i.test(x.fieldName || ""));
  return (f?.size?.max) || (f?.elementRange?.max != null ? f.elementRange.max + 1 : 0) || 15;
}
async function segControl(id, segs, rgb) {
  const sku = await resolveSku(id);
  return govee("/device/control", {
    requestId: randomUUID(),
    payload: { sku, device: id, capability: { type: "devices.capabilities.segment_color_setting", instance: "segmentedColorRgb", value: { segment: segs, rgb } } },
  });
}
async function runChase(id, count, cols, bandWidth, stepMs) {
  stopSegAnim(id); await setPower(id, true).catch(() => {});
  const rgbs = cols.map(rgbInt);
  let on = new Set(), pos = 0, dir = 1, colorIdx = 0;
  const width = Math.max(1, Math.min(bandWidth || 3, count));
  const tick = async () => {
    const next = new Set();
    for (let i = 0; i < width; i++) { const idx = pos - Math.floor(width / 2) + i; if (idx >= 0 && idx < count) next.add(idx); }
    const toLight = [...next].filter((i) => !on.has(i));
    const toDim = [...on].filter((i) => !next.has(i));
    on = next;
    if (toLight.length) await segControl(id, toLight, rgbs[colorIdx % rgbs.length]).catch(() => {});
    if (toDim.length) await segControl(id, toDim, 0).catch(() => {});
    pos += dir;
    if (pos >= count - 1) { dir = -1; colorIdx++; } else if (pos <= 0) { dir = 1; colorIdx++; }
  };
  await tick();
  segAnimTimers[id] = setInterval(() => tick().catch(() => {}), Math.max(250, stepMs || 350));
}
async function runWave(id, count, cols, stepMs) {
  stopSegAnim(id); await setPower(id, true).catch(() => {});
  const rgbs = cols.map(rgbInt);
  let phase = 0;
  const tick = async () => {
    const groups = rgbs.map(() => []);
    for (let i = 0; i < count; i++) groups[(i + phase) % rgbs.length].push(i);
    await Promise.allSettled(groups.map((segs, i) => (segs.length ? segControl(id, segs, rgbs[i]) : null)));
    phase = (phase + 1) % rgbs.length;
  };
  await tick();
  segAnimTimers[id] = setInterval(() => tick().catch(() => {}), Math.max(400, stepMs || 700));
}
app.post("/govee/segscene", gate, async (req, res) => {
  try {
    if (!Object.keys(deviceMap).length) await listDevices();
    const ids = req.body.devices || [];
    const targets = ids.filter((id) => deviceSegCount(id) > 0);
    if (!targets.length) return res.status(400).json({ error: "no segment-capable devices in the target list" });
    const cols = (req.body.cols && req.body.cols.length) ? req.body.cols : [[255, 0, 140], [0, 200, 255], [120, 255, 80]];
    await Promise.all(targets.map((id) => {
      const count = deviceSegCount(id);
      return req.body.pattern === "wave"
        ? runWave(id, count, cols, req.body.step)
        : runChase(id, count, cols, req.body.bandWidth, req.body.step);
    }));
    res.json({ ok: true, targets });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post("/govee/segscene/stop", gate, (req, res) => {
  (req.body.devices || Object.keys(segAnimTimers)).forEach(stopSegAnim);
  res.json({ ok: true });
});

// Flash a light (or all) N times in a color, then restore. Reuses flash() below.
app.post("/govee/flash", gate, async (req, res) => {
  try {
    await flash({ cols: req.body.cols, times: req.body.times, hold: req.body.hold,
      _ids: req.body.device ? [req.body.device] : (req.body.devices || null) });
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ---------- built-in (hardware) dynamic scenes ---------- */
// List a device's built-in light scenes + DIY scenes. These run smoothly on the
// bulb itself (no animator, no rate-limit cost) — the "real" pre-animated scenes.
function sceneOptions(payload) {
  const caps = payload?.capabilities || [];
  const opts = [];
  for (const c of caps) {
    for (const o of c?.parameters?.options || [])
      opts.push({ name: o.name, value: o.value, instance: c.instance });
  }
  return opts;
}
app.post("/govee/scenes", gate, async (req, res) => {
  try {
    const sku = await resolveSku(req.body.device);
    const body = { requestId: randomUUID(), payload: { sku, device: req.body.device } };
    const [light, diy] = await Promise.allSettled([
      govee("/device/scenes", body),
      govee("/device/diy-scenes", body),
    ]);
    const scenes = [];
    if (light.status === "fulfilled") scenes.push(...sceneOptions(light.value.payload));
    if (diy.status === "fulfilled")   scenes.push(...sceneOptions(diy.value.payload));
    res.json({ data: scenes });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
// Activate one built-in scene (value comes straight from /govee/scenes).
app.post("/govee/scene/builtin", gate, async (req, res) => {
  try {
    const { device, value, instance } = req.body;
    await control(device, "devices.capabilities.dynamic_scene", instance || "lightScene", value);
    res.json({ ok: true });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* (built-in scene endpoints: see /govee/scenes and /govee/scene/builtin above) */

/* ============================================================
   AI  (Anthropic Messages API, structured JSON via output_config.format)
   ============================================================ */
async function claudeJSON({ system, prompt, schema, max_tokens }) {
  const msg = await anthropic.messages.create({
    model: MODEL,
    max_tokens,
    system,
    messages: [{ role: "user", content: prompt }],
    output_config: { format: { type: "json_schema", schema } },
  });
  const text = msg.content.find((b) => b.type === "text")?.text || "{}";
  return JSON.parse(text);
}

const SCENE_SCHEMA = {
  type: "object",
  properties: {
    name:    { type: "string" },
    motion:  { type: "boolean" },
    step:    { type: "integer" },                                  // ms per frame
    via:     { type: "string" },                                   // short note, e.g. "custom animator"
    targets: { type: "array", items: { type: "string" } },         // device names
    cols:    { type: "array", items: { type: "array", items: { type: "integer" } } }, // [r,g,b]
  },
  required: ["name", "motion", "step", "via", "targets", "cols"],
  additionalProperties: false,
};
const SCHEDULE_SCHEMA = {
  type: "object",
  properties: {
    label: { type: "string" },
    when:  { type: "string" },                                     // human readable
    cron:  { type: "string" },                                     // 5-field cron, or "sunset" / "sunrise"
    action: {
      type: "object",
      properties: {
        kind:       { type: "string", enum: ["allOn", "allOff", "scene"] },
        scene:      { type: "string" },                            // scene name when kind == scene
        brightness: { type: "integer" },
      },
      required: ["kind"],
      additionalProperties: false,
    },
  },
  required: ["label", "when", "cron", "action"],
  additionalProperties: false,
};

app.post("/ai/scene", gate, async (req, res) => {
  try {
    if (!Object.keys(deviceMap).length) await listDevices().catch(() => {});
    const names = Object.values(deviceMap).map((d) => d.deviceName);
    const scene = await claudeJSON({
      max_tokens: 2000,
      schema: SCENE_SCHEMA,
      system:
        "You design Govee light scenes. Output a Scene JSON. " +
        "cols is a palette of [r,g,b] triples (0-255). " +
        "Set motion=true for moving/animated looks (color cycles across lights every `step` ms; use 800-3000ms). " +
        "Set motion=false for a static look (step=0). " +
        "targets must be chosen from these device names: " + JSON.stringify(names) + ". " +
        "If unsure, target all of them. `via` is a 2-4 word note on how it renders.",
      prompt: String(req.body.prompt || "a multicolored moving scene"),
    });
    res.json({ scene });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

app.post("/ai/schedule", gate, async (req, res) => {
  try {
    const schedule = await claudeJSON({
      max_tokens: 600,
      schema: SCHEDULE_SCHEMA,
      system:
        "Convert a natural-language lighting automation into a Schedule JSON. " +
        "cron is a standard 5-field cron expression (minute hour day-of-month month day-of-week), " +
        "OR the literal string 'sunset' or 'sunrise'. " +
        "'every night at 11pm' -> '0 23 * * *'. 'weekday mornings at 6:30' -> '30 6 * * 1-5'. " +
        "action.kind is allOff, allOn, or scene. `when` is a short human-readable summary. " +
        "`label` is a short title.",
      prompt: String(req.body.text || ""),
    });
    res.json({ schedule });
  } catch (e) { res.status(502).json({ error: e.message }); }
});

/* ============================================================
   AUTOMATIONS  (persisted, run on a cron even when the app is closed)
   record = { id, label, when, cron, action, enabled }
   ============================================================ */
let store = [];
const jobs = new Map();   // id -> cron task or timeout handle

function loadStore() {
  try { store = existsSync(STORE_PATH) ? JSON.parse(readFileSync(STORE_PATH, "utf8")) : []; }
  catch { store = []; }
}
function saveStore() { try { writeFileSync(STORE_PATH, JSON.stringify(store, null, 2)); } catch (e) { console.error("saveStore:", e.message); } }

async function runAction(action) {
  if (!Object.keys(deviceMap).length) await listDevices().catch(() => {});
  // Target a group's devices if action.groupId is set, else every device.
  let ids = Object.keys(deviceMap);
  if (action.groupId) {
    const g = groups.find((x) => x.id === action.groupId);
    ids = g ? g.devices.filter((id) => deviceMap[id]) : ids;
  }
  if (action.kind === "allOff") return Promise.allSettled(ids.map((id) => setPower(id, false)));
  if (action.kind === "allOn") {
    await Promise.allSettled(ids.map((id) => setPower(id, true)));
    if (action.brightness != null) await Promise.allSettled(ids.map((id) => setBright(id, action.brightness)));
    if (action.color != null)      await Promise.allSettled(ids.map((id) => setColor(id, action.color)));
    return;
  }
  if (action.kind === "scene" && action.scene) {
    const s = store.find((a) => a.action?.kind === "scene" && a.label === action.scene);
    if (s?.action?.scene && typeof s.action.scene === "object") return applyScene(s.action.scene);
  }
}

async function sunTime(which) {                       // returns a Date for today's sunset/sunrise
  if (LAT == null || LON == null) throw new Error("LAT/LON not configured for sun-based schedules");
  const r = await fetch(`https://api.sunrise-sunset.org/json?lat=${LAT}&lng=${LON}&formatted=0`);
  const j = await r.json();
  return new Date(which === "sunrise" ? j.results.sunrise : j.results.sunset);
}
function clearJob(id) {
  const j = jobs.get(id);
  if (j) { if (typeof j.stop === "function") j.stop(); else clearTimeout(j); jobs.delete(id); }
}
async function scheduleOne(a) {
  clearJob(a.id);
  if (!a.enabled) return;
  if (a.cron === "sunset" || a.cron === "sunrise") {
    try {
      const t = await sunTime(a.cron);
      const ms = t.getTime() - Date.now();
      if (ms > 0) jobs.set(a.id, setTimeout(() => runAction(a.action).catch(() => {}), ms));
    } catch { /* no lat/lon — skip until configured */ }
    return;
  }
  if (cron.validate(a.cron)) {
    jobs.set(a.id, cron.schedule(a.cron, () => runAction(a.action).catch(() => {})));
  }
}
function rescheduleAll() { store.forEach(scheduleOne); }

// Re-arm sun-based one-shots every day just after midnight.
cron.schedule("10 0 * * *", () => {
  store.filter((a) => a.cron === "sunset" || a.cron === "sunrise").forEach(scheduleOne);
});

app.get("/automations", gate, (_req, res) => res.json({ data: store }));
app.post("/automations", gate, async (req, res) => {
  const a = { id: randomUUID(), enabled: true, ...req.body };
  store.unshift(a); saveStore(); await scheduleOne(a);
  res.json({ data: a });
});
app.patch("/automations/:id", gate, async (req, res) => {
  const a = store.find((x) => x.id === req.params.id);
  if (!a) return res.status(404).json({ error: "not found" });
  Object.assign(a, req.body); saveStore(); await scheduleOne(a);
  res.json({ data: a });
});
app.delete("/automations/:id", gate, (req, res) => {
  clearJob(req.params.id);
  store = store.filter((x) => x.id !== req.params.id); saveStore();
  res.json({ ok: true });
});

/* ============================================================
   GROUPS  (named device groups for bulk control + group timers)
   record = { id, name, devices:[deviceId,...] }
   Persisted under DATA_DIR so they sync across every device.
   ============================================================ */
const GROUP_PATH = join(DATA_DIR, "groups.json");
let groups = [];
function loadGroups() {
  try { groups = existsSync(GROUP_PATH) ? JSON.parse(readFileSync(GROUP_PATH, "utf8")) : []; }
  catch { groups = []; }
}
function saveGroups() { try { writeFileSync(GROUP_PATH, JSON.stringify(groups, null, 2)); } catch (e) { console.error("saveGroups:", e.message); } }

app.get("/groups", gate, (_req, res) => res.json({ data: groups }));
app.post("/groups", gate, (req, res) => {
  const g = { id: randomUUID(), name: req.body.name || "Group", devices: req.body.devices || [] };
  groups.push(g); saveGroups(); res.json({ data: g });
});
app.patch("/groups/:id", gate, (req, res) => {
  const g = groups.find((x) => x.id === req.params.id);
  if (!g) return res.status(404).json({ error: "not found" });
  Object.assign(g, req.body); saveGroups(); res.json({ data: g });
});
app.delete("/groups/:id", gate, (req, res) => {
  groups = groups.filter((x) => x.id !== req.params.id); saveGroups(); res.json({ ok: true });
});

/* ============================================================
   EVENT TRIGGERS  (IFTTT inbound webhooks)
   IFTTT applet:  IF <event> THEN Webhooks → request {PROXY}/hook/<token>/<event>
   A trigger maps an event name to a light action (flash / scene / all on-off).
   ============================================================ */
const WEBHOOK_TOKEN = process.env.WEBHOOK_TOKEN || PASSCODE;   // gates the public /hook URL
const TRIG_PATH = join(DATA_DIR, "triggers.json");
let triggers = [];
function loadTriggers() {
  try { triggers = existsSync(TRIG_PATH) ? JSON.parse(readFileSync(TRIG_PATH, "utf8")) : []; }
  catch { triggers = []; }
}
function saveTriggers() { try { writeFileSync(TRIG_PATH, JSON.stringify(triggers, null, 2)); } catch (e) { console.error("saveTriggers:", e.message); } }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Flash a color (or color sequence) N times, then restore each light's prior state.
async function flash(action) {
  if (!Object.keys(deviceMap).length) await listDevices().catch(() => {});
  const ids = (action._ids && action._ids.length)
    ? action._ids.filter((id) => deviceMap[id]) : Object.keys(deviceMap);
  const cols = (action.cols || [[255, 0, 0]]).map(rgbInt);
  const times = Math.min(action.times || 3, 6);
  const hold = Math.max(250, action.hold || 400);
  const prev = {};
  await Promise.allSettled(ids.map(async (id) => {
    try {
      const sku = await resolveSku(id);
      const j = await govee("/device/state", { requestId: randomUUID(), payload: { sku, device: id } });
      prev[id] = normalizeState(j.payload);
    } catch { /* best effort */ }
  }));
  await Promise.allSettled(ids.map((id) => setPower(id, true)));
  for (let t = 0; t < times; t++) {
    await Promise.allSettled(ids.map((id) => setColor(id, cols[t % cols.length])));
    await wait(hold);
  }
  await Promise.allSettled(ids.map((id) => {
    const p = prev[id]; if (!p) return;
    return setColor(id, p.color).then(() => (p.on ? null : setPower(id, false)));
  }));
}
async function runTriggerAction(action) {
  if (!action) return;
  if (action.kind === "flash") return flash(action);
  if (action.kind === "scene" && action.scene) return applyScene(action.scene);
  return runAction(action);   // allOn / allOff
}

// Public webhook IFTTT calls. Token is in the URL (IFTTT can't easily set headers).
app.all("/hook/:token/:event", async (req, res) => {
  if (WEBHOOK_TOKEN && req.params.token !== WEBHOOK_TOKEN) return res.status(401).send("bad token");
  const ev = String(req.params.event || "").toLowerCase();
  const rule = triggers.find((t) => t.enabled !== false && String(t.event || "").toLowerCase() === ev);
  if (!rule) return res.status(404).send("no trigger for " + ev);
  runTriggerAction(rule.action).catch(() => {});
  res.send("ok: " + ev);
});

app.get("/triggers", gate, (_req, res) => res.json({ data: triggers }));
app.post("/triggers", gate, (req, res) => {
  const t = { id: randomUUID(), enabled: true, ...req.body };
  triggers.unshift(t); saveTriggers(); res.json({ data: t });
});
app.patch("/triggers/:id", gate, (req, res) => {
  const t = triggers.find((x) => x.id === req.params.id);
  if (!t) return res.status(404).json({ error: "not found" });
  Object.assign(t, req.body); saveTriggers(); res.json({ data: t });
});
app.delete("/triggers/:id", gate, (req, res) => {
  triggers = triggers.filter((x) => x.id !== req.params.id); saveTriggers(); res.json({ ok: true });
});

/* ---------- boot ---------- */
loadStore();
loadTriggers();
loadGroups();
listDevices().then(rescheduleAll).catch(() => rescheduleAll());
app.listen(PORT, () => console.log(`Govee proxy on :${PORT}`));
