# Hands-on private trial script (owner)

Disposable / trial data only. Production Tracerfy stays **off**.  
Do **not** import the employer production workbook until Hostinger/local persistence is proven on this checklist.

## Preconditions

- App running with `PILOT_AUTH=1`, `AUTO_SEED=0`, owner credentials set (first boot) or existing users in DB
- Bundled fixture available: `server/fixtures/sanitized-source-workbook.xlsx`
- Browser against the same origin as the API (Hostinger URL or `http://127.0.0.1:PORT` after `npm run build && npm start`)

## Script

1. **Open site** — Sign-in page loads (not “Frontend assets missing”).
2. **Owner login** — Use owner email/password.
3. **Health / release** — `GET /api/health` shows `{ ok, ready, service, release }`. Note `release.gitShaShort`. Owner `/api/health/details` adds full release + `frontendBuilt` / db path.
4. **Invite operator** — Create invite (owner-only). Deliver token out-of-band. Accept invite in a private window; confirm operator cannot invite others.
5. **Import** — Import → upload sanitized fixture → preview sections → commit. Empty Permits tab should prompt Import; table search only filters saved rows.
6. **Edit + re-import** — Open a permit, edit an internal milestone value, re-import the same fixture. Confirm the edit remains (or a conflict is shown — not silent loss).
7. **Use filters** — Filter Residential / Commercial / Unknown; list updates honestly.
8. **Permit check** — Run check on a row. Expect a real outcome (`updated` / `no_change` / `not_found` / `unavailable` / `failed`) — never a fake success.
9. **Contacts demo** — Create invented demo property → **Find contact information** → Accept or Reject labeled demo contacts.
10. **Export** — Structured export. Confirm demo/fixture/rejected contacts are not treated as operational rows.
11. **Attention** — Open Attention; acknowledge one item if present.
12. **Restart** — Stop/restart (or redeploy) **same DB path**. Confirm sections, milestone edit, users, and attention history remain.

## Local command (disposable)

```bash
cd permit-tracker
npm ci && npm run build
node server/scripts/private-trial-e2e.js   # automated HTTP rehearsal
# or interactive:
PERMIT_DB_PATH=./data/trial.sqlite AUTO_SEED=0 PILOT_AUTH=1 COOKIE_SECURE=0 \
  OWNER_EMAIL=owner@example.com OWNER_PASSWORD='change-me-now-10+' \
  LISTEN_HOST=127.0.0.1 PORT=4173 npm start
```

Hostinger field values: [`docs/hostinger.md`](hostinger.md).  
**Hostinger deploy/persistence is not claimed verified until owner runs step 12 on that host.**
