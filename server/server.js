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
// Railway's containers run in UTC by default — without an explicit timezone,
// every clock-time automation ("off at 11pm") fires 4-5 hours off from a US
// Eastern user's actual local time, which reads as "timers aren't followed."
const TZ            = process.env.TZ_NAME || "America/New_York";
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
// Never let the browser (or an intermediate proxy/CDN) cache the service
// worker or the HTML shell — otherwise a deploy can go live but the app
// keeps serving a stale cached page even after the user refreshes.
app.use((req, res, next) => {
  if (/^\/(sw\.js|index\.html|scenes\.html|manifest\.json)?$/.test(req.path)) {
    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
  }
  next();
});
app.use(express.static(STATIC_DIR));

const gate = (req, res, next) => {
  if (!PASSCODE) return next();                       // no passcode configured = open
  if (req.get("X-Passcode") === PASSCODE) return next();
  return res.status(401).json({ error: "bad passcode" });
};

app.get("/health", (_req, res) =>
  res.json({ ok: true, govee: !!GOVEE_KEY, ai: !!ANTHROPIC_KEY, automations: store.length, dataDir: DATA_DIR,
    tz: TZ, serverTime: new Date().toISOString(), serverLocalTime: new Date().toLocaleString("en-US", { timeZone: TZ }),
    goveeRateLimit: lastRateLimit }));

/* ============================================================
   GOVEE CLOUD API
   ============================================================ */
// Govee's Cloud API is free but quota-limited (a daily request cap); it reports
// remaining quota via X-RateLimit-* response headers. Capture whatever it sends
// so /health can show real quota state instead of guessing whether the animation
// loops (which call this on every tick) have burned through the day's allowance.
let lastRateLimit = null;
async function govee(path, body) {
  const res = await fetch(GOVEE_BASE + path, {
    method: body ? "POST" : "GET",
    headers: { "Content-Type": "application/json", "Govee-API-Key": GOVEE_KEY },
    body: body ? JSON.stringify(body) : undefined,
  });
  const rl = {};
  res.headers.forEach((v, k) => { if (/rate.?limit/i.test(k)) rl[k] = v; });
  if (Object.keys(rl).length) lastRateLimit = { ...rl, path, status: res.status, at: new Date().toISOString() };
  if (!res.ok) throw new Error(`govee ${res.status}: ${await res.text().catch(() => "")}`);
  return res.json();
}
// RATE LIMITER 2026-07-22 (jford screenshotted a real "govee 429" toast +
// reported recurring "big sections of no lights" across MULTIPLE zones —
// pool, and two other segments at the house). Root cause, confirmed against
// Govee's actual published Cloud API limits: /device/control allows only
// 120 req/min PER DEVICE (2/sec sustained, 6 burst) and 720 req/min PER
// ACCOUNT (12/sec sustained, 80 burst). Every segment-animation tick fires
// 1-6 concurrent control calls (one per lit color group / dim group), every
// 110-460ms — 2 to 10x over the per-device budget. The first tick or two
// gets through on burst capacity, then Govee starts rejecting with 429 and
// those segments just never receive their color: the "dead sections" bug.
// This queues EVERY /device/control call through a token bucket per device
// (and a shared account-wide bucket) instead of firing them immediately —
// calls that would exceed budget wait their turn rather than getting
// dropped. Slightly under Govee's real numbers on purpose, for headroom.
function makeBucket(capacity, refillPerSec) { return { tokens: capacity, capacity, refillPerSec, last: Date.now() }; }
function refillBucket(b) {
  const now = Date.now();
  b.tokens = Math.min(b.capacity, b.tokens + ((now - b.last) / 1000) * b.refillPerSec);
  b.last = now;
}
const acctBucket = makeBucket(70, 10);     // Govee: 80 burst / 12 per sec
const deviceBuckets = {};                  // deviceId -> bucket, Govee: 6 burst / 2 per sec
function deviceBucket(id) { return deviceBuckets[id] || (deviceBuckets[id] = makeBucket(5, 1.8)); }
let ctlQueue = [];   // {id, fn, resolve, reject}
let pumping = false;
function queueControl(id, fn) {
  return new Promise((resolve, reject) => {
    ctlQueue.push({ id, fn, resolve, reject });
    pump();
  });
}
function pump() {
  if (pumping) return;
  pumping = true;
  const step = () => {
    refillBucket(acctBucket);
    for (let i = 0; i < ctlQueue.length; i++) {
      const item = ctlQueue[i];
      const db = deviceBucket(item.id);
      refillBucket(db);
      if (acctBucket.tokens >= 1 && db.tokens >= 1) {
        acctBucket.tokens -= 1; db.tokens -= 1;
        ctlQueue.splice(i, 1);
        item.fn().then(item.resolve, item.reject);
        i--;
      }
    }
    if (ctlQueue.length) setTimeout(step, 60);
    else pumping = false;
  };
  step();
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
  return queueControl(deviceId, () => govee("/device/control", {
    requestId: randomUUID(),
    payload: { sku, device: deviceId, capability: { type, instance, value } },
  }));
}
// thin wrappers used by the scene engine + automations
const setPower  = (id, on)  => control(id, "devices.capabilities.on_off",        "powerSwitch", on ? 1 : 0);
const setBright = (id, v)   => control(id, "devices.capabilities.range",         "brightness",  v);
const setColor  = (id, rgb) => control(id, "devices.capabilities.color_setting", "colorRgb",    rgb);

app.get("/govee/devices", gate, async (_req, res) => {
  // internal capability-resolution (resolveSku etc.) still sees the FULL raw
  // list via listDevices()/deviceMap — only what the CLIENT displays is
  // filtered, so a hidden device is invisible in the app but a stray
  // leftover group/automation referencing its id doesn't start throwing.
  try { const devices = await listDevices(); res.json({ data: devices.filter((d) => !hiddenDevices.includes(d.device)) }); }
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
app.post("/govee/stop", gate, (req, res) => {
  // Scoped stop when the caller names specific devices — e.g. the client
  // calling this to stop ONE light's built-in-scene tag must NOT also kill
  // every OTHER light's unrelated running twinkle/chase/wave animation. Bug
  // found 2026-07-08: this used to always clear ALL segAnimTimers/
  // breatheTimers regardless of which device the caller meant, so a manual
  // tweak to light A could silently freeze a twinkle scene mid-animation on
  // light B anywhere else in the house — looking exactly like "it just
  // stopped twinkling" with the light stuck on whatever partial colors its
  // last successful tick had painted.
  const only = Array.isArray(req.body?.devices) ? req.body.devices : null;
  if (only && only.length) {
    only.forEach((id) => { stopSegAnim(id); stopBreathe(id); });
  } else {
    if (animTimer) { clearInterval(animTimer); animTimer = null; }
    Object.keys(segAnimTimers).forEach(stopSegAnim);
    Object.keys(breatheTimers).forEach(stopBreathe);
  }
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
// SAFETY AUTO-STOP 2026-07-21 (jford: "what happens if I have a scene
// selected in both the Govee app and our app?" + reports of commands not
// taking / sections of the strip stuck) — these animations previously ran
// FOREVER once started, with zero awareness of anything happening outside
// this app. If you start Twinkle and never explicitly hit Stop (close the
// tab, switch to the Govee app, whatever), the server keeps sending updates
// indefinitely and will keep overriding ANY other change to that device —
// Govee Home, another session, anything — since it has no way to know you
// touched the light elsewhere. That's very likely why things looked "stuck."
// Every segment animation now auto-stops after 30 minutes as a safety net,
// so a forgotten scene can't fight you forever.
const MAX_ANIM_MS = 30 * 60 * 1000;
let segAutoStop = {};   // deviceId -> the auto-stop timeout, cleared alongside the interval
function armSegTimer(id, handle) {
  segAnimTimers[id] = handle;
  clearTimeout(segAutoStop[id]);
  segAutoStop[id] = setTimeout(() => stopSegAnim(id), MAX_ANIM_MS);
}
function stopSegAnim(id) {
  if (segAnimTimers[id]) { clearInterval(segAnimTimers[id]); delete segAnimTimers[id]; }
  if (segAutoStop[id]) { clearTimeout(segAutoStop[id]); delete segAutoStop[id]; }
  if (showTimers[id]) { clearTimeout(showTimers[id]); delete showTimers[id]; }
  if (showAutoStop[id]) { clearTimeout(showAutoStop[id]); delete showAutoStop[id]; }
}
// SHOW 2026-07-21 (jford: "do we have any preset dancing scenes that arent
// just a single movement in one direction... like a true production?") —
// a Show is a scripted sequence of steps, each its own {pattern,cols,step,
// duration}, that plays one after another and loops. It's built ON TOP of
// the existing pattern functions (each step just calls dispatchSegPattern),
// with its own outer "advance to next step" timer. showTimers/showAutoStop
// are cleared by stopSegAnim above so any existing stop path (Stop button,
// applying a different scene, the segAutoStop 30-min net) cancels a show
// cleanly instead of leaving a zombie timer that restarts the next step.
let showTimers = {};     // deviceId -> the "advance to next step" timeout
let showAutoStop = {};   // deviceId -> ABSOLUTE 30-min cap for the whole show (not reset per-step)
function stopShow(id) {
  if (showTimers[id]) { clearTimeout(showTimers[id]); delete showTimers[id]; }
  if (showAutoStop[id]) { clearTimeout(showAutoStop[id]); delete showAutoStop[id]; }
}
function runShow(id, count, steps) {
  let stepIndex = 0;
  const advance = () => {
    const s = steps[stepIndex % steps.length];
    stepIndex++;
    dispatchSegPattern(id, count, s.cols, s.pattern, s.bandWidth, s.bandCount, s.step);
    showTimers[id] = setTimeout(advance, s.duration || 4000);
  };
  advance();
  showAutoStop[id] = setTimeout(() => stopSegAnim(id), MAX_ANIM_MS);
}
function deviceSegCount(id) {
  const d = deviceMap[id]; if (!d) return 0;
  const cap = (d.capabilities || []).find((c) => c.type === "devices.capabilities.segment_color_setting");
  if (!cap) return 0;
  const f = (cap.parameters?.fields || []).find((x) => /segment/i.test(x.fieldName || ""));
  return (f?.size?.max) || (f?.elementRange?.max != null ? f.elementRange.max + 1 : 0) || 15;
}
async function segControl(id, segs, rgb) {
  const sku = await resolveSku(id);
  return queueControl(id, () => govee("/device/control", {
    requestId: randomUUID(),
    payload: { sku, device: id, capability: { type: "devices.capabilities.segment_color_setting", instance: "segmentedColorRgb", value: { segment: segs, rgb } } },
  }));
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
  armSegTimer(id, setInterval(() => tick().catch(() => {}), Math.max(180, stepMs || 300)));
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
  armSegTimer(id, setInterval(() => tick().catch(() => {}), Math.max(280, stepMs || 550)));
}
// STROBE: the whole strip hard-flashes between palette colors with a dark beat
// in between (color -> off -> next color -> off...) — a real concert-style flash,
// not a gentle fade. Cheap (1 call/tick) so it can run fast.
async function runStrobe(id, count, cols, stepMs) {
  stopSegAnim(id); await setPower(id, true).catch(() => {});
  const rgbs = cols.map(rgbInt);
  const all = Array.from({ length: count }, (_, i) => i);
  let beat = 0, colorIdx = 0;
  const tick = async () => {
    if (beat % 2 === 0) { await segControl(id, all, rgbs[colorIdx % rgbs.length]).catch(() => {}); colorIdx++; }
    else { await segControl(id, all, 0).catch(() => {}); }
    beat++;
  };
  await tick();
  armSegTimer(id, setInterval(() => tick().catch(() => {}), Math.max(110, stepMs || 150)));
}
// BOUNCE: several comet bands (bandCount) run at once, evenly spaced, each its
// own color, all ping-ponging together — a much busier, livelier chase.
async function runBounce(id, count, cols, bandWidth, bandCount, stepMs) {
  stopSegAnim(id); await setPower(id, true).catch(() => {});
  const rgbs = cols.map(rgbInt);
  const bands = Math.max(2, Math.min(bandCount || 3, Math.max(2, Math.floor(count / 3))));
  const width = Math.max(1, Math.min(bandWidth || 3, Math.floor(count / bands)));
  const spacing = count / bands;
  let on = new Set(), pos = 0, dir = 1, roundIdx = 0;
  const tick = async () => {
    const next = new Set();
    const litColor = {};
    for (let b = 0; b < bands; b++) {
      const center = Math.round((pos + b * spacing) % count);
      const color = rgbs[(roundIdx + b) % rgbs.length];
      for (let i = 0; i < width; i++) {
        const idx = center - Math.floor(width / 2) + i;
        if (idx >= 0 && idx < count) { next.add(idx); litColor[idx] = color; }
      }
    }
    const toDim = [...on].filter((i) => !next.has(i));
    on = next;
    // group newly/still-lit segments by color so each color needs just one call
    const byColor = {};
    next.forEach((i) => { (byColor[litColor[i]] ||= []).push(i); });
    const calls = Object.entries(byColor).map(([c, segs]) => segControl(id, segs, +c).catch(() => {}));
    if (toDim.length) calls.push(segControl(id, toDim, 0).catch(() => {}));
    await Promise.allSettled(calls);
    pos += dir;
    if (pos >= count - 1) { dir = -1; roundIdx++; } else if (pos <= 0) { dir = 1; roundIdx++; }
  };
  await tick();
  armSegTimer(id, setInterval(() => tick().catch(() => {}), Math.max(220, stepMs || 280)));
}
// TWINKLE: a genuine slow brightness FADE (not a hard on/off cut) — the strip
// is split into a handful of zones, each holding a fixed color from the
// palette but breathing its own brightness up/down on a staggered phase
// (cosine ramp, floored so it glows rather than blinking off) so zones drift
// in and out of sync, like fairy lights, instead of a uniform strobe/cycle.
async function runTwinkle(id, count, cols, stepMs) {
  stopSegAnim(id);
  await setPower(id, true);   // let a real failure (offline device, bad id, etc.) throw here — the FIRST call must surface errors, not swallow them
  const floor = 0.12;      // never fully dark — a glow, not an off
  const cycleSteps = 4;    // phase steps per fade — see 2026-07-12 note on why this is low
  // TRUE SINGLE-SEGMENT POINTS 2026-07-21 (jford: "it's twinkling small groups
  // of lights instead of single random lights throughout the strand" — a real
  // regression from the 2026-07-20 "randomize" pass). That pass scattered
  // segments across the strip correctly, but grouped them into up to 8
  // "points" — for a typical 15-segment strip that meant most points still
  // contained 2 segments, so a single update visibly moved a PAIR of lights,
  // not one. Fixed properly this time: one point per PHYSICAL segment, full
  // stop — `points = count`, each point is exactly one segment, no grouping
  // at all. Genuinely single, independent, randomly-timed lights.
  const points = count;
  const pointPhase = Array.from({ length: points }, () => Math.floor(Math.random() * cycleSteps));   // randomized start, not evenly staggered
  // Dialed back 3→2 calls/tick alongside this fix (jford also reported
  // commands not taking / sections of the strip going unresponsive — could be
  // this animation pushing too close to Govee's real rate limit with MORE,
  // smaller points now needing MORE total updates to cover the whole strip).
  // Also see armSegTimer above: a 30-min safety auto-stop now protects
  // against a forgotten-but-still-running twinkle fighting other changes.
  const UPDATES_PER_TICK = Math.min(2, points);
  let busy = false;
  const tickMs = Math.max(250, stepMs || 500);
  const phaseStep = (stepMs && stepMs < 250) ? Math.min(4, Math.max(1, Math.round(250 / stepMs))) : 1;
  const colorFor = (p) => {
    const t = pointPhase[p] / cycleSteps;
    const factor = floor + (1 - floor) * (1 - Math.cos(t * 2 * Math.PI)) / 2;
    const base = cols[p % cols.length];
    return rgbInt(base.map((c) => Math.round(c * factor)));
  };
  // strict=true (only on the very first application) lets a genuine API error
  // propagate out to the caller instead of being silently swallowed — that's
  // what made past failures look like "nothing happened" with no diagnostic.
  // Ongoing ticks inside setInterval stay resilient (strict=false) so one
  // transient hiccup doesn't kill the whole animation loop.
  const tick = async (strict) => {
    if (busy) return; busy = true;
    try {
      const picked = new Set();
      while (picked.size < Math.min(UPDATES_PER_TICK, points)) picked.add(Math.floor(Math.random() * points));
      const calls = [...picked].map((p) => {
        pointPhase[p] = (pointPhase[p] + phaseStep) % cycleSteps;
        const call = segControl(id, [p], colorFor(p));
        return strict ? call : call.catch(() => {});
      });
      await (strict ? Promise.all(calls) : Promise.allSettled(calls));
    } finally { busy = false; }
  };
  await tick(true);
  armSegTimer(id, setInterval(() => tick(false).catch(() => {}), tickMs));
}
// Whole-device twinkle/breathe fallback for lights that AREN'T addressable
// (no segments): fades the actual brightness capability slowly up and down
// via a cosine ramp, instead of the color-cycle used by other patterns —
// this is the real fix for "sharp brightness change, not a slow glowing fade."
let breatheTimers = {};   // deviceId -> interval handle, independent per device
let breatheAutoStop = {};   // same 30-min safety net as segAnimTimers — see armSegTimer's comment
function armBreatheTimer(id, handle) {
  breatheTimers[id] = handle;
  clearTimeout(breatheAutoStop[id]);
  breatheAutoStop[id] = setTimeout(() => stopBreathe(id), MAX_ANIM_MS);
}
function stopBreathe(id) {
  if (breatheTimers[id]) { clearInterval(breatheTimers[id]); delete breatheTimers[id]; }
  if (breatheAutoStop[id]) { clearTimeout(breatheAutoStop[id]); delete breatheAutoStop[id]; }
}
async function runBreatheWhole(id, rgb, stepMs) {
  stopBreathe(id);
  await setPower(id, true);          // first calls throw on real failure — see runTwinkle's comment
  await setColor(id, rgbInt(rgb));
  // cut 18→8 2026-07-12 alongside runTwinkle's same change ("a twinkle should
  // be just a second or two") — no round-robin here (every tick services the
  // whole device directly), so cycle time is just cycleSteps × tickMs; 8
  // steps at the 150ms floor lands at 1.2s.
  const floorB = 10, cycleSteps = 8;
  // same floor as runTwinkle, lowered 2026-07-12 for the same reason (see its
  // comment) — a brightness-only call is at least as light as a segment
  // color call, so there's no reason to hold it to a stricter floor.
  const step = Math.max(150, stepMs || 500);
  const phaseStep = (stepMs && stepMs < 150) ? Math.min(4, Math.max(1, Math.round(150 / stepMs))) : 1;
  let phase = 0, busy = false;
  const tick = async (strict) => {
    if (busy) return; busy = true;
    try {
      phase = (phase + phaseStep) % cycleSteps;
      const t = phase / cycleSteps;
      const b = Math.round(floorB + (100 - floorB) * (1 - Math.cos(t * 2 * Math.PI)) / 2);
      const call = setBright(id, b);
      await (strict ? call : call.catch(() => {}));
    } finally { busy = false; }
  };
  await tick(true);
  armBreatheTimer(id, setInterval(() => tick(false).catch(() => {}), step));
}
// Shared by the live /govee/segscene route AND scheduled/triggered scenes
// (runAction, IFTTT) so a segment pattern behaves identically either way.
function dispatchSegPattern(id, count, cols, pattern, bandWidth, bandCount, step) {
  if (pattern === "wave")    return runWave(id, count, cols, step);
  if (pattern === "strobe")  return runStrobe(id, count, cols, step);
  if (pattern === "bounce")  return runBounce(id, count, cols, bandWidth, bandCount, step);
  if (pattern === "twinkle") return runTwinkle(id, count, cols, step);
  return runChase(id, count, cols, bandWidth, step);
}
// Apply a full scene object (as designed/saved in the app) to a set of device
// ids: segment-capable ones get the real chase/wave/strobe/bounce/twinkle
// pattern, the rest fall back to a whole-device color cycle (or, for
// twinkle, a whole-device brightness breathe) — same split the Scenes page's
// apply picker does, but driven server-side (for cron/IFTTT firing).
async function applySceneToIds(scene, ids) {
  if (!ids.length) return;
  if (scene.show && scene.show.length) {
    const capable = ids.filter((id) => deviceSegCount(id) > 0);
    if (capable.length) await Promise.allSettled(capable.map((id) => runShow(id, deviceSegCount(id), scene.show)));
    return;
  }
  if (scene.pattern) {
    const capable = ids.filter((id) => deviceSegCount(id) > 0);
    const plain = ids.filter((id) => !capable.includes(id));
    const tasks = capable.map((id) => dispatchSegPattern(id, deviceSegCount(id), scene.cols, scene.pattern, scene.bandWidth, scene.bandCount, scene.step));
    if (plain.length) {
      if (scene.pattern === "twinkle") tasks.push(...plain.map((id) => runBreatheWhole(id, scene.cols[0], scene.step)));
      else tasks.push(applyScene({ ...scene, targets: plain.map((id) => deviceMap[id]?.deviceName).filter(Boolean) }));
    }
    await Promise.allSettled(tasks);
  } else {
    await applyScene({ ...scene, targets: ids.map((id) => deviceMap[id]?.deviceName).filter(Boolean) });
  }
}
app.post("/govee/segscene", gate, async (req, res) => {
  try {
    if (!Object.keys(deviceMap).length) await listDevices();
    const ids = req.body.devices || [];
    const cols = (req.body.cols && req.body.cols.length) ? req.body.cols : [[255, 0, 140], [0, 200, 255], [120, 255, 80]];
    const { pattern, bandWidth, bandCount, step } = req.body;
    // twinkle is the one pattern that ALSO works on non-addressable lights (a
    // whole-device brightness breathe), so it doesn't require segment support.
    if (pattern === "twinkle") {
      const capable = ids.filter((id) => deviceSegCount(id) > 0);
      const plain = ids.filter((id) => !capable.includes(id));
      if (!capable.length && !plain.length) return res.status(400).json({ error: "no target devices" });
      await Promise.all([
        ...capable.map((id) => runTwinkle(id, deviceSegCount(id), cols, step)),
        ...plain.map((id) => runBreatheWhole(id, cols[0], step)),
      ]);
      return res.json({ ok: true, targets: ids, capable, plain });
    }
    const targets = ids.filter((id) => deviceSegCount(id) > 0);
    if (!targets.length) return res.status(400).json({ error: "no segment-capable devices in the target list" });
    await Promise.all(targets.map((id) => dispatchSegPattern(id, deviceSegCount(id), cols, pattern, bandWidth, bandCount, step)));
    res.json({ ok: true, targets });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post("/govee/segscene/stop", gate, (req, res) => {
  const ids = req.body.devices || [...new Set([...Object.keys(segAnimTimers), ...Object.keys(breatheTimers), ...Object.keys(showTimers)])];
  ids.forEach(stopSegAnim);
  ids.forEach(stopBreathe);
  res.json({ ok: true });
});
// A "Show" is a scripted sequence of pattern steps (chase for a bit, then
// bounce, then a strobe burst, then wave...) instead of one static pattern
// for the whole scene — see runShow() above. Segment-capable devices only;
// there's no meaningful whole-device fallback for a multi-step sequence.
app.post("/govee/show", gate, async (req, res) => {
  try {
    if (!Object.keys(deviceMap).length) await listDevices();
    const ids = req.body.devices || [];
    const steps = req.body.steps || [];
    if (!steps.length) return res.status(400).json({ error: "no show steps given" });
    const targets = ids.filter((id) => deviceSegCount(id) > 0);
    if (!targets.length) return res.status(400).json({ error: "no segment-capable devices in the target list" });
    targets.forEach((id) => runShow(id, deviceSegCount(id), steps));
    res.json({ ok: true, targets });
  } catch (e) { res.status(502).json({ error: e.message }); }
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
  if (action.kind === "scene" && action.scene && typeof action.scene === "object") {
    return applySceneToIds(action.scene, ids);
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
    jobs.set(a.id, cron.schedule(a.cron, () => runAction(a.action).catch(() => {}), { timezone: TZ }));
  }
}
function rescheduleAll() { store.forEach(scheduleOne); }

// Re-arm sun-based one-shots every day just after midnight (local time).
cron.schedule("10 0 * * *", () => {
  store.filter((a) => a.cron === "sunset" || a.cron === "sunrise").forEach(scheduleOne);
}, { timezone: TZ });

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

/* ============================================================
   HIDDEN DEVICES  (jford: "how do I delete these ungrouped lights that
   show up in our app but not in the Govee manufacturer app?" — the Cloud
   API returns a raw flat device list that can include entries Govee Home
   hides/merges on its end; we have no way to actually delete a device from
   the account, so instead: let the user hide it from OUR app specifically.
   Persisted under DATA_DIR like groups/automations so it's consistent
   across every device, not just one browser's localStorage.)
   ============================================================ */
const HIDDEN_PATH = join(DATA_DIR, "hidden.json");
let hiddenDevices = [];
function loadHidden() {
  try { hiddenDevices = existsSync(HIDDEN_PATH) ? JSON.parse(readFileSync(HIDDEN_PATH, "utf8")) : []; }
  catch { hiddenDevices = []; }
}
function saveHidden() { try { writeFileSync(HIDDEN_PATH, JSON.stringify(hiddenDevices, null, 2)); } catch (e) { console.error("saveHidden:", e.message); } }

app.get("/hidden", gate, (_req, res) => res.json({ data: hiddenDevices }));
app.post("/hidden", gate, (req, res) => {
  const id = req.body.device;
  if (!id) return res.status(400).json({ error: "device id required" });
  if (!hiddenDevices.includes(id)) { hiddenDevices.push(id); saveHidden(); }
  res.json({ data: hiddenDevices });
});
app.delete("/hidden/:id", gate, (req, res) => {
  hiddenDevices = hiddenDevices.filter((x) => x !== req.params.id); saveHidden();
  res.json({ data: hiddenDevices });
});

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
loadHidden();
listDevices().then(rescheduleAll).catch(() => rescheduleAll());
app.listen(PORT, () => console.log(`Govee proxy on :${PORT}`));
