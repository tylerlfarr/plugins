# Report a problem + rollback notes (RC)

## Report a problem

Capture enough to reproduce without pasting secrets or gospel data:

1. **Release** — `GET /api/health` → `release.gitShaShort` (owner: `/api/health/details` for full SHA + db path).
2. **Role** — owner vs operator; approximate time (UTC).
3. **Gate ID** if known — e.g. DI-01/02/03, AI-*, EX-*, CT-*, or checklist H1–H12.
4. **Steps** — what you clicked; sanitized fixture vs other disposable data.
5. **Expected vs actual** — include HTTP status / on-screen message; no passwords, tokens, or real borrower PII.
6. **Screenshots** — optional; redact emails/phones if needed.

File defects against the draft PR or the project tracker — do not enable spend unlock or gospel upload as a “workaround.”

## Rollback (owner)

1. **Stop the app** on the host.
2. **Restore SQLite** from the last known-good backup of `PERMIT_DB_PATH` (copy main file plus `-wal`/`-shm` if present, app stopped).
3. **Redeploy prior tip** (previous git SHA) with the same env flags (`PILOT_AUTH=1`, spend lock on, no gospel path).
4. **Health check** — `GET /api/health` ready; confirm `release.gitShaShort` matches the rolled-back tip.
5. **Spot-check** — owner login + one operator login + list permits; do not re-import gospel.

## What not to do during an incident

- Do not set `tracerfy_production_enabled=1` or raise spend limits.
- Do not set `AUTO_SEED=1` on a durable DB with pilot data.
- Do not wipe `PERMIT_DB_PATH` without an explicit restore plan.
- Do not merge to `main` to “fix” a host issue.

Persistence / Hostinger field notes: [`hostinger-persistence-checklist.md`](./hostinger-persistence-checklist.md), [`hostinger.md`](./hostinger.md).
