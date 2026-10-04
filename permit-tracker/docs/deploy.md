# Permit Ledger — protected pilot deploy

Temporary product name: **Permit Ledger**. Single-business invite-only trial.

## Hosting choice

**Fly.io** (Docker + persistent volume) — matches Express/SQLite, HTTPS at the edge, one machine.

| Item | Notes |
|------|--------|
| Recurring cost | Shared-cpu-1x + ~1GB volume — typically low tens of USD/month; confirm current Fly pricing |
| Account setup | Fly.org account, payment method, `flyctl` CLI |
| HTTPS | Provided by Fly (`force_https`) |
| Persistence | Volume mounted at `/data` → `PERMIT_DB_PATH=/data/permit-ledger.sqlite` |

**Do not** purchase services or deploy externally without owner authorization.

## Environment (no credentials in repo)

| Variable | Required | Purpose |
|----------|----------|---------|
| `PERMIT_DB_PATH` | yes (prod) | Absolute SQLite path on persistent volume |
| `PILOT_AUTH` | `1` for pilot | Invite-only sessions |
| `OWNER_EMAIL` / `OWNER_PASSWORD` | bootstrap | Creates first owner if users table empty |
| `OWNER_DISPLAY_NAME` | optional | Owner display name |
| `BUSINESS_NAME` | optional | Single-business label |
| `SESSION_SECRET` | recommended | Marks production auth intent with `NODE_ENV=production` |
| `COOKIE_SECURE` | `1` behind HTTPS | Secure cookie flag |
| `AUTO_SEED` | `0` for clean deploy | Prevents auto-import; **no `/cursor/stores` dependency** |
| `SOURCE_WORKBOOK_XLSX` | optional | Only if you intentionally auto-import a mounted workbook |
| `PORT` | `8080` on Fly | HTTP listen port |
| `TRACERFY_*` | optional | Keep production enrichment off until owner approves |

## Local verify (no external deploy)

```bash
cd permit-tracker
npm install
npm run build
mkdir -p /tmp/permit-data
PERMIT_DB_PATH=/tmp/permit-data/pilot.sqlite \
  AUTO_SEED=0 PILOT_AUTH=1 \
  OWNER_EMAIL=owner@example.com OWNER_PASSWORD='change-me-now-10+' \
  COOKIE_SECURE=0 NODE_ENV=production \
  PORT=4173 npm start
```

1. Open `http://localhost:4173` → sign-in gate.
2. Sign in as owner → Import a workbook from the UI (upload), not from Cursor store paths.
3. Restart the process → data under `PERMIT_DB_PATH` persists.
4. Backup: `cp "$PERMIT_DB_PATH" /tmp/permit-backup.sqlite`
5. Restore: stop app, replace DB file, start app.

## Fly sketch (owner-authorized only)

```bash
fly apps create permit-ledger-pilot   # if needed
fly volumes create permit_ledger_data --size 1 --region iad
fly secrets set OWNER_EMAIL=... OWNER_PASSWORD=... BUSINESS_NAME='...'
fly deploy
```

## Auth model

- Roles: `owner` (settings, provider mode, reconcile, seed/invite) · `operator` (daily workbook)
- Sessions: HttpOnly cookie, scrypt passwords, SHA-256 token hashes
- State-changing JSON requests need `X-Requested-With: PermitLedger` (or same-origin)

## Boundaries

- Missing Tracerfy does **not** block workbook + permit workflow.
- PWC / Loudoun unsupported until demonstrated.
- One business per DB — not multi-tenant SaaS this milestone.
