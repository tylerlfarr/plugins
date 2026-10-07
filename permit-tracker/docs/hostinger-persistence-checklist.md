# Hostinger persistence checklist (do not redeploy yet)

Live site (sign-in observed): https://darkgrey-gaur-146027.hostingersite.com/

**Goal:** Prove the SQLite file survives process restart **and** a later redeploy **before** importing any real employer workbook.

**Do not** reset/replace the hosted DB. **Do not** redeploy until DB path + backup/recovery are confirmed below.

## 0) Confirm running release

```bash
curl -sS https://darkgrey-gaur-146027.hostingersite.com/api/health
```

Expect `release.gitShaShort` (and `version`). Compare to GitHub tip on `cursor/permit-tracker-prototype-6ca0`.  
If Hostinger still shows an older short SHA (e.g. `f574bf8` while tip is newer), the site has not picked up the latest commit — note that before interpreting behavior.

Owner login → `GET /api/health/details` also returns full `release` + `dbPath`.

## 1) Record DB location (no write destructive)

1. Owner sign-in on Hostinger.
2. Open `/api/health/details` (or owner diagnostics).
3. Record **`dbPath`** exactly (absolute or relative).
4. In hPanel / File Manager, locate that file if visible. Note whether it sits under a deploy-managed tree (`hbuilds/…`, `nodejs/…`) that is overwritten on deploy.

If the path is inside a build output directory that Hostinger replaces on each deploy, **stop** — set `PERMIT_DB_PATH` to a durable location Hostinger documents as persistent, then restart **once**, and re-check `dbPath` before any import.

## 2) Backup / recovery method (confirm before redeploy)

Document how you would restore if a deploy wipes data:

- [ ] File Manager / FTP copy of the `.sqlite` (+ `-wal`/`-shm` if present) to a safe off-host location
- [ ] Or Hostinger backup feature covering that path
- [ ] Recovery steps written down (who restores, where from)

**Do not redeploy** until at least one backup method is confirmed.

## 3) Sanitized fixture baseline (disposable only)

1. Import `server/fixtures/sanitized-source-workbook.xlsx` (not the employer production workbook).
2. Note counts: sections, permits (from UI stats or list).
3. Open one permit; set a **distinctive** internal milestone value, e.g. `HOSTINGER-PERSIST-CHECK-2026`.
4. Write down: permit id / lot label, milestone key, exact value, timestamp.

## 4) Restart test (no redeploy)

1. Restart the Node app from Hostinger controls (or wait for process recycle) **without** changing git / redeploying.
2. Sign in again.
3. Confirm: same permit count, distinctive milestone value still present, users still login.

Pass/fail: ___________

## 5) Redeploy test (only after §1–§2 pass)

1. Take a fresh off-host copy of the DB file(s).
2. Redeploy the authorized branch.
3. Confirm `GET /api/health` `release.gitShaShort` matches the intended tip.
4. Confirm `dbPath` unchanged (or still the durable path).
5. Confirm distinctive milestone + counts survived.

If data is gone: restore from backup; **do not** import real workbook until path is fixed.

## 6) Gate for real workbook

Only after restart **and** redeploy persistence both pass:

- [ ] Real workbook import authorized by owner  
- [ ] Production Tracerfy still off unless separately approved  
