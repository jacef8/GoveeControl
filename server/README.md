# Govee Control — proxy

Small Node/Express service that holds the secrets and does the work the browser can't:

- **Govee control** — `/govee/devices`, `/govee/state`, `/govee/control`, `/govee/scene`, `/govee/stop`
- **AI** — `/ai/scene`, `/ai/schedule` (Anthropic Messages API, `claude-opus-4-8`, structured JSON)
- **Automations** — `/automations` CRUD, run on a cron (and at sunset/sunrise) even when the app is closed

The PWA only ever talks to this service; the Govee + Anthropic keys never reach the browser.

## Run locally

```bash
cd server
cp .env.example .env      # fill in GOVEE_API_KEY, ANTHROPIC_API_KEY, PASSCODE
npm install
npm start                 # http://localhost:4319/health
```

## Deploy to Railway

This is a **single service**: the Express server serves the PWA front-end
(`index.html` / `scenes.html` at the repo root) *and* the API, from one URL.

1. New project → deploy from repo. Leave **Root Directory** at the repo root
   (blank) — the root `package.json` runs `node server/server.js`.
2. Set Variables: `GOVEE_API_KEY`, `ANTHROPIC_API_KEY`, `PASSCODE`, and optionally `LAT`/`LON`.
3. Add a **Volume** mounted at `/data` and set `DATA_DIR=/data` so automations + triggers survive redeploys.
4. Railway provides `PORT` and runs `npm start` (see `railway.json`). Open `https://<your-app>.up.railway.app/` (the app) and `/health` (the API) to confirm.
5. In the app, tap ⚙ Settings — the URL is pre-filled to the current site, so just enter your `PASSCODE` → Test → Save. (Stored in `localStorage`; the app stays in demo mode until you save.)

## Notes

- All `/govee`, `/ai`, `/automations` routes require the `X-Passcode` header (skipped if `PASSCODE` is blank).
- Moving scenes animate server-side at a floor of 800 ms/step to stay under Govee's rate limit; for smooth/fast motion use a device built-in scene or the LAN API (future).
- Automations + triggers persist as JSON under `DATA_DIR`. Point it at a mounted Railway Volume so they survive redeploys (the container's own disk is ephemeral).
