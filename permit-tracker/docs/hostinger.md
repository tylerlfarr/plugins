# Permit Ledger — Hostinger Node.js (Business / Cloud) deploy guide

Temporary product name: **Permit Ledger**. App directory in the monorepo: `permit-tracker`.

**Do not** purchase Hostinger services or deploy externally without owner authorization.  
**Never** commit passwords, API tokens, or invite tokens to git / PR bodies.

Official Hostinger docs (verify in dashboard if UI labels drift):

- [How to add a Node.js web app](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/)
- [Node.js GitHub integration](https://docs.hostinger.com/node.js/github) — install → build → start on each push
- Supported Node versions include **22.x** (also 18 / 20 / 24)

## Exact Hostinger field values

Set these when connecting the GitHub repo (PR #1 branch `cursor/permit-tracker-prototype-6ca0` or the branch you authorize):

| Field | Value |
|-------|--------|
| **Root directory** | `permit-tracker` |
| **Framework preset** | **Express.js** (if auto-detect fails: **Other**) |
| **Node.js version** | **22** |
| **Package manager** | **npm** (lockfile present) |
| **Install command** | platform default (`npm install` / lockfile-aware). Do **not** force omit-dev if the UI offers it — Vite/React are in `dependencies` so production install still builds. |
| **Build command** | `npm run build` |
| **Entry file** | `server/index.js` |
| **Output directory** | `client/dist` |
| **Start** | Prefer `npm start` if the UI exposes a start command; otherwise entry file above. `start` sets `NODE_ENV=production` and runs `node server/index.js`. |

Pipeline expectation: Hostinger pulls code → installs deps → runs build (writes `client/dist`) → starts Express, which serves API **and** static files from `client/dist`.

Wrong root (e.g. `orchestrate/...` or repo root) will miss `package.json` / build scripts.

## Why packaging changed

Hostinger-shaped installs that set `NODE_ENV=production` during `npm ci` / `npm install` **omit `devDependencies`**. Previously Vite/React lived only in `devDependencies`, so `npm run build` failed with `vite: not found`.

Build tools required for production packaging (`vite`, `@vitejs/plugin-react`, `react`, `react-dom`) are now in **`dependencies`**. `concurrently` stays in `devDependencies` (local dual-process only).

## Environment variable **names** (set in Hostinger dashboard — no secrets in git)

| Name | Required | Safe placeholder / note |
|------|----------|-------------------------|
| `PILOT_AUTH` | yes | `1` |
| `AUTO_SEED` | yes | `0` |
| `COOKIE_SECURE` | yes (HTTPS) | `1` |
| `PORT` | usually set by host | leave to Hostinger if injected; otherwise match their docs |
| `LISTEN_HOST` | recommended | `0.0.0.0` |
| `PERMIT_DB_PATH` | recommended | writable path under the app, e.g. `data/permit-ledger.sqlite` (relative to app root) or an absolute path Hostinger documents as persistent |
| `OWNER_EMAIL` | yes (first boot) | `you@your-company.com` |
| `OWNER_PASSWORD` | yes (first boot) | strong password ≥10 chars — set only in dashboard |
| `OWNER_DISPLAY_NAME` | optional | `Owner` |
| `BUSINESS_NAME` | recommended | your company label |
| `SESSION_SECRET` | recommended | long random string |

**Do not set** until owner approves production enrichment: `TRACERFY_API_TOKEN` / production Tracerfy gates. Find-contacts **demo** works without them.

Never put secrets in Vite `VITE_*` frontend vars.

## SQLite / better-sqlite3 / persistence

- Native addon **`better-sqlite3`** installs and starts under **Node 22** in clean CI locally. That proves Node 22 compatibility, **not** that Hostinger’s shared filesystem persists across redeploys.
- Default DB path: `data/permit-tracker.sqlite` under the app root (directory is created if missing).
- Prefer setting `PERMIT_DB_PATH` to a path you control and can re-check after restart.
- **Before importing a real workbook on Hostinger:** create a tiny record (or import the bundled sanitized fixture), note a value, restart/redeploy the app, confirm the value remains. If the DB resets, Hostinger is not giving durable storage for that path — stop and choose a persistent location or another host (see `docs/deploy.md` for Fly volume prep). Files under Hostinger’s managed build trees may be replaced on deploy; env vars are the durable config channel.

## Multer

Upload routes use `multer` memory storage (`upload.single('file')`). Dependency is on supported **2.x** (not the deprecated 1.4.5-lts line). npm’s old “upgrade multer” / `prebuild-install` notices are **not** themselves proof of a Hostinger deploy failure.

## Verification checklist (after a successful Hostinger deploy)

1. Open the Hostinger URL → login page (not the “Frontend assets missing” 503 HTML).
2. `GET /api/health` → `ok: true`, `frontendBuilt: true`, `auth: true`.
3. Sign in with `OWNER_EMAIL` / `OWNER_PASSWORD`.
4. Import → upload `server/fixtures/sanitized-source-workbook.xlsx` (or trial workbook).
5. Export structured workbook; spot-check sheets.
6. Run a Fairfax-linked permit check if data allows.
7. Open a permit → **Create invented demo property** → **Find contact information** → Accept/Reject labeled demo contacts.
8. Restart/redeploy → confirm DB still has imported sections (persistence test).

## If deploy still fails after a clean local Node 22 build

Local reproduction:

```bash
cd permit-tracker
rm -rf node_modules
NODE_ENV=production npm ci
NODE_ENV=production npm run build
test -f client/dist/index.html
AUTO_SEED=0 PILOT_AUTH=1 COOKIE_SECURE=0 \
  OWNER_EMAIL=owner@example.com OWNER_PASSWORD='change-me-now-10+' \
  PERMIT_DB_PATH=./data/pilot.sqlite LISTEN_HOST=127.0.0.1 PORT=4173 \
  npm start
```

If that passes and Hostinger still fails, **paste the raw Hostinger deployment log** (install + build + start). Do not invent a Hostinger-specific diagnosis without that log.
