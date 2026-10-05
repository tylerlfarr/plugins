# Permit Ledger — Hostinger Node.js setup (single guide)

Temporary product name: **Permit Ledger**. Monorepo app directory: **`permit-tracker`**.

**Do not** purchase Hostinger services or deploy externally without owner authorization.  
**Never** commit passwords, API tokens, or invite tokens to git / PR bodies.

This guide is checked against Hostinger’s current Node.js GitHub docs (install → build → start; Node **18/20/22/24**; Express supported; root directory for monorepos; entry file + output directory for Other/Express). Confirm labels in your hPanel if the UI drifts.

Official references:

- [How to add a Node.js web app](https://www.hostinger.com/support/how-to-deploy-a-nodejs-website-in-hostinger/)
- [Node.js GitHub integration](https://docs.hostinger.com/node.js/github)

**Hostinger deploy and DB persistence are not verified in this repository work.** After a successful local Node 22 build, if Hostinger fails, paste the **raw deployment log** — do not invent a diagnosis.

## Exact field values

| Field | Value |
|-------|--------|
| **Root directory** | `permit-tracker` |
| **Framework preset** | **Express.js** (fallback: **Other**) |
| **Node.js version** | **22** |
| **Package manager** | **npm** (committed `package-lock.json`) |
| **Install** | Platform default (`npm install` / lockfile-aware). Do **not** omit-dev if optional — Vite/React are in `dependencies` so production install can still `npm run build`. |
| **Build command** | `npm run build` |
| **Entry file** | `server/index.js` |
| **Output directory** | `client/dist` |
| **Start** | `npm start` if offered; else entry file. `start` runs `NODE_ENV=production node server/index.js`. |

Wrong root (repo root or another folder) misses this app’s `package.json`.

Pipeline: pull → install → build (`client/dist`) → start Express (API + static `client/dist`).

## Environment variable **names** (dashboard only)

| Name | Required | Placeholder / note |
|------|----------|--------------------|
| `PILOT_AUTH` | yes | `1` |
| `AUTO_SEED` | yes | `0` |
| `COOKIE_SECURE` | yes on HTTPS | `1` |
| `LISTEN_HOST` | recommended | `0.0.0.0` |
| `PORT` | usually host-injected | leave to Hostinger if set |
| `PERMIT_DB_PATH` | recommended | writable path, e.g. `data/permit-ledger.sqlite` |
| `OWNER_EMAIL` | first boot only | `you@your-company.com` |
| `OWNER_PASSWORD` | first boot only | ≥10 chars — dashboard secret |
| `OWNER_DISPLAY_NAME` | optional | `Owner` |
| `BUSINESS_NAME` | recommended | company label |
| `SESSION_SECRET` | recommended | long random string |

After the first successful boot with users in the DB, restart does **not** require `OWNER_*` again.

**Do not set** Tracerfy production token/gates until explicitly approved. Find-contacts **demo** works without them. Never put secrets in `VITE_*` frontend vars.

## Packaging notes

- Vite/React build tools are in **`dependencies`** so Hostinger-shaped `NODE_ENV=production` installs can still build.
- Public `GET /api/health` returns only `{ ok, ready, service }`. Owner `GET /api/health/details` includes `frontendBuilt`, db path, diagnostics.
- Unwritable `PERMIT_DB_PATH` parent → clear startup error (no silent DB switch).
- Auth is fail-closed when `PILOT_AUTH=1` or `NODE_ENV=production` (unless `PILOT_AUTH=0` for local demo/tests).
- Same-origin FE/API: cross-origin state changes rejected even if `X-Requested-With` is set. Login attempts are throttled.

## SQLite / better-sqlite3

- Installs and starts under **Node 22** in local clean CI. That is **not** Hostinger persistence proof.
- Before a real workbook: import sanitized fixture → restart/redeploy → confirm data remains. If the DB resets, stop and fix the path/host (see also `docs/deploy.md` for Fly volume prep).

## Local Node 22 clean check (before trusting Hostinger)

```bash
cd permit-tracker
rm -rf node_modules client/dist
NODE_ENV=production npm ci
NODE_ENV=production npm run build
test -f client/dist/index.html
AUTO_SEED=0 PILOT_AUTH=1 COOKIE_SECURE=0 \
  OWNER_EMAIL=owner@example.com OWNER_PASSWORD='change-me-now-10+' \
  PERMIT_DB_PATH=./data/pilot.sqlite LISTEN_HOST=127.0.0.1 PORT=4173 \
  npm start
```

Automated disposable rehearsal: `node server/scripts/private-trial-e2e.js`  
Owner checklist: [`docs/hands-on-private-trial.md`](hands-on-private-trial.md)

## After deploy (owner)

1. Login UI loads; `/api/health` → `ready: true`
2. Owner login → import sanitized fixture → milestone edit + re-import
3. Use filters, permit check, Find contact **demo**, export, Attention
4. Restart/redeploy → data still present (**persistence gate** — not yet claimed for Hostinger)
