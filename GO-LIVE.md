# GoveeControl — Go Live (the 2 steps only you can do)

Everything in the code is done and verified. The app runs in demo (mock) mode until
you connect it to a deployed proxy. Two account-gated steps remain:

## 1. Get your Govee API key  (~2 min, then wait for email)
- Open the **Govee Home** app → **Profile** → **Apply for API Key**.
- Fill the short form; the key arrives by email (usually minutes).
- Your paired lights auto-appear via the Cloud API — no in-app pairing needed.

## 2. Deploy the proxy to Railway  (~5 min)
1. Push this repo to GitHub (or use Railway's CLI).
2. railway.app → **New Project** → deploy the repo → set service **Root Directory** = `server`.
3. **Variables** (Settings → Variables):
   - `GOVEE_API_KEY`     = the key from step 1
   - `ANTHROPIC_API_KEY` = your Anthropic key (for AI scenes/schedules)
   - `PASSCODE`          = any shared secret you choose (you'll type it into the app)
   - `LAT` / `LON`       = optional, only for sunset/sunrise automations
4. **Volume**: add one mounted at `/data`, then set `DATA_DIR=/data`
   (so automations + triggers survive redeploys — the container disk is ephemeral).
5. Wait for deploy, then open `https://<your-app>.up.railway.app/health`.
   You want: `{"ok":true,"govee":true,"ai":true,...}`.

## 3. Connect the app  (no code edit)
- Open the PWA → tap **⚙ Settings** (top right).
- Paste the Railway URL + the same `PASSCODE` → **Test** (should say "Connected ✓") → **Save**.
- The app reloads live. The "MOCK DATA" badge disappears and real lights show up.
- Settings are stored on-device (localStorage `gv_cfg`); do it once per device/browser.

## IFTTT event triggers (optional)
- Webhook URL is `https://<your-app>.up.railway.app/hook/<WEBHOOK_TOKEN>/<event>`
  (`WEBHOOK_TOKEN` defaults to `PASSCODE`). The Scenes page → "Event triggers" shows it.
