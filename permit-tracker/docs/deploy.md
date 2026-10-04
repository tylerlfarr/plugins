# Permit Ledger — private hosted trial (Fly.io)

Temporary product name: **Permit Ledger**. Single-business invite-only trial.

**Do not** purchase services or deploy externally without owner authorization.  
**Never** commit passwords, API tokens, or invite tokens to git / PR bodies.

Pinned code tip verified for this guide: see PR #1 tip (deploy config dry-run matched `6960933…` + follow-up config doc commits).

## Why Fly.io

One recommended host for this stack (Express + React static + SQLite):

| Need | Fly support |
|------|-------------|
| HTTPS URL | Edge TLS + `force_https` |
| Persistent SQLite | Volume mount at `/data` |
| Single always-on instance | `min_machines_running = 1`, `auto_stop_machines = off` |
| Secrets outside git | `fly secrets set` |
| Existing packaging | `Dockerfile` + `fly.toml` in this repo |

Alternatives (Railway/Render) are possible but would need a new volume + Dockerfile wiring; Fly is already sketched and remains the recommended path.

## Current expected monthly cost (confirm before purchase)

Rates from [Fly.io pricing](https://fly.io/docs/about/pricing/) (usage-based; no platform fee). Always-on single-region trial matching `fly.toml`:

| Item | Spec | Approx monthly |
|------|------|----------------|
| Machine | `shared-cpu-1x` · 512MB RAM · always on | **~$3.69** |
| Volume | 1 GB provisioned (`$0.15/GB`) | **~$0.15** |
| Dedicated IPv4 (if allocated) | optional / sometimes needed | **~$2.00** |
| Outbound bandwidth | low trial traffic (NA/EU ~`$0.02/GB`) | usually **&lt;$1** |
| **Baseline estimate** | machine + 1GB volume | **~$4–7 / month** |
| **With dedicated IPv4** | | **~$6–9 / month** |

Fly requires a payment method after the short trial window. Confirm live prices on the pricing page before authorizing spend — regional compute can vary slightly.

## Account / payment setup (owner)

1. Create a Fly.io account at https://fly.io and an organization.
2. Add a payment method in the Fly dashboard (required for sustained Machines/volumes).
3. Install CLI: https://fly.io/docs/hands-on/install-flyctl/ then `fly auth login`.
4. Optional but recommended: create a dedicated org for this single-business pilot (not multi-tenant SaaS).

## Hosted configuration checklist (verified dry-run)

| Requirement | How it is set | Status |
|-------------|---------------|--------|
| Auth required | `PILOT_AUTH=1` in Dockerfile + `fly.toml` | Verified |
| Secure cookies over HTTPS | `COOKIE_SECURE=1` + Fly `force_https` | Verified |
| SQLite persists across restarts | Volume `permit_ledger_data` → `/data`, `PERMIT_DB_PATH=/data/permit-ledger.sqlite` | Configured |
| No auto-import of employer workbook | `AUTO_SEED=0`; empty DB starts with 0 sections; no `/cursor/stores` dependency | Verified |
| Sanitized start data | Bundled `server/fixtures/sanitized-source-workbook.xlsx` in image; import via UI after login | Available |
| Production Tracerfy disabled | No token / gates in image env; `productionEnabled=false` until secrets set | Verified |
| Find contacts demo visible | UI + `POST /api/properties/demo-sandbox` + `local_fixture` labeled contacts; excluded from operational export | Verified |

## Environment / secrets (names only — no values in git)

Set via `fly secrets set` (never commit):

| Secret / env | Required | Purpose |
|--------------|----------|---------|
| `OWNER_EMAIL` | yes (first boot) | Bootstrap owner account if users table empty |
| `OWNER_PASSWORD` | yes (first boot) | Bootstrap owner password (≥10 chars) |
| `OWNER_DISPLAY_NAME` | optional | Owner display name |
| `BUSINESS_NAME` | recommended | Single-business label |
| `SESSION_SECRET` | recommended | Opaque random string for production session hygiene |

Already baked into image / `fly.toml` `[env]` (non-secret):

- `PILOT_AUTH=1`, `COOKIE_SECURE=1`, `AUTO_SEED=0`, `PERMIT_DB_PATH=/data/permit-ledger.sqlite`, `PORT=8080`, `LISTEN_HOST=0.0.0.0`, `NODE_ENV=production`

**Do not set** until owner explicitly approves production enrichment: `TRACERFY_API_TOKEN`, `tracerfy_production_enabled`, commercial/spend gates. Missing Tracerfy does **not** block workbook + Find-contact **demo** (invented `sandbox_demo` properties).

## Exact Fly steps (owner-authorized only — do not run without approval)

From the `permit-tracker/` directory on the pinned tip:

```bash
# 1) App + volume (once)
fly apps create permit-ledger-pilot          # name must be unique; edit fly.toml app= if changed
fly volumes create permit_ledger_data --size 1 --region iad

# 2) Secrets (use real values locally; do not paste into chat/PR)
fly secrets set \
  OWNER_EMAIL='you@your-company.com' \
  OWNER_PASSWORD='choose-a-strong-password-10+' \
  OWNER_DISPLAY_NAME='Owner' \
  BUSINESS_NAME='Your Company' \
  SESSION_SECRET="$(openssl rand -hex 32)"

# 3) Deploy
fly deploy

# 4) Open HTTPS URL
fly apps open
# or: https://permit-ledger-pilot.fly.dev  (hostname depends on app name)
```

After first deploy:

1. Sign in with the owner email/password you set as secrets.
2. **Import** → upload `server/fixtures/sanitized-source-workbook.xlsx` (or your trial workbook) — not Cursor store paths.
3. Open a permit → **Create invented demo property** → **Find contact information** → Accept/Reject labeled demo contacts.
4. Confirm Structured export Contacts sheet has no sandbox/fixture rows.
5. Restart Machine (`fly machines restart`) and confirm data still present (volume persistence).

Invite operators (owner session): `POST /api/auth/invite` with `{ "email", "role": "operator" }` — deliver `invite_token` out-of-band.

## Local dry-run of hosted flags (no Fly purchase)

```bash
cd permit-tracker
npm install && npm run build
mkdir -p /tmp/permit-data
PERMIT_DB_PATH=/tmp/permit-data/pilot.sqlite \
  AUTO_SEED=0 PILOT_AUTH=1 COOKIE_SECURE=0 \
  OWNER_EMAIL=owner@example.com OWNER_PASSWORD='change-me-now-10+' \
  LISTEN_HOST=127.0.0.1 PORT=4173 npm start
```

Open `http://localhost:4173` → sign-in → import bundled sanitized fixture → invented demo property → Find contact information.

## Auth model

- Roles: `owner` (settings, provider mode, reconcile, seed/invite) · `operator` (daily workbook)
- Sessions: HttpOnly cookie, scrypt passwords, SHA-256 token hashes
- State-changing JSON needs `X-Requested-With: PermitLedger` (or same-origin)

## Boundaries

- One business per DB — not multi-tenant SaaS this milestone.
- PWC / Loudoun unsupported for live retrieve until demonstrated.
- Production Tracerfy stays off until token + spend cap + commercial confirmation + legal OK.
