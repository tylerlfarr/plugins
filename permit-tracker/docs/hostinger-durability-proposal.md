# Hostinger durability proposal (approval required — do not execute yet)

**Status:** Proposal only. No Hostinger settings changes, no DB move/reset, no restart/redeploy/restore in this change set.

**Related:** [hostinger-persistence-checklist.md](./hostinger-persistence-checklist.md), [hostinger.md](./hostinger.md), [deploy.md](./deploy.md)

Live site: https://darkgrey-gaur-146027.hostingersite.com/

## Problem

Observed SQLite path on Hostinger (owner health / runtime logs):

`/home/u152631036/domains/darkgrey-gaur-146027.hostingersite.com/hbuilds/versions/<deployment-id>/nodejs/data/permit-ledger.sqlite`

That path is **release-scoped** under `hbuilds/versions/…`. A new Node deploy can create a new version directory; the prior SQLite file does not automatically follow. XLSX exports are not a full database backup.

## Goal

Before importing real operational data:

1. Point `PERMIT_DB_PATH` at a **durable** absolute path outside `hbuilds/versions/…`.
2. Confirm a consistent SQLite backup + restore procedure (file copy of `.sqlite` + `-wal`/`-shm` if present).
3. Pass a **disposable** restart → redeploy → restore rehearsal with sanitized data only.

## Proposed Hostinger actions (for later approval)

### A) Choose durable path (owner / Hostinger admin)

1. In hPanel, identify a path Hostinger documents as persistent for this Node app (examples to verify against current Hostinger docs — do not invent):
   - Domain-level data directory outside `hbuilds/versions/…` (e.g. under the domain home, not under a single build id), or
   - A mounted volume / “persistent storage” feature if enabled for this plan.
2. Create directory if needed, e.g.  
   `/home/u152631036/domains/darkgrey-gaur-146027.hostingersite.com/permit-ledger-data/`  
   (exact path must be confirmed in File Manager before use).
3. Set environment variable on the Node app (Hostinger → Node.js → Environment):
   - `PERMIT_DB_PATH=/home/u152631036/domains/.../permit-ledger-data/permit-ledger.sqlite`
4. Keep existing trial flags unchanged unless separately approved:
   - `AUTO_SEED=0`
   - Auth enabled (`PILOT_AUTH=1` / current invite-only settings)
   - Paid Tracerfy disabled / local_fixture

**Do not** delete or truncate the current version-scoped DB as part of this move until a verified copy exists.

### B) One-time migrate (copy, then cut over)

1. Stop or idle writes (short maintenance window).
2. Copy current SQLite (+ `-wal` / `-shm` if present) from the version-scoped path to the durable path via File Manager / SFTP.
3. Set `PERMIT_DB_PATH` to the durable file.
4. Restart the Node app **once**.
5. Owner: `GET /api/health/details` → confirm `dbPath` equals the durable path.
6. Spot-check users still login; counts match pre-move snapshot.

**Rollback:** Point `PERMIT_DB_PATH` back to the previous path (or restore the pre-move copy), restart once, re-check `dbPath`.

### C) Backup / restore procedure (document & practice)

**Backup (daily or pre-deploy):**

1. Prefer app idle or brief pause.
2. Copy `permit-ledger.sqlite` and any `permit-ledger.sqlite-wal` / `-shm` to an off-host location (download + local archive).
3. Label with date + `release.gitShaShort` from `/api/health`.

**Restore:**

1. Stop Node app.
2. Replace durable SQLite files with the backup set.
3. Start app; verify health + spot-check a known permit / user.

Hostinger “database backups” for MySQL/Postgres typically **do not** cover this SQLite file — do not rely on them unless File Manager coverage of the durable path is confirmed.

## Disposable verification plan (sanitized only — after approval)

Use `server/fixtures/sanitized-source-workbook.xlsx` only. No employer workbook.

| Step | Action | Pass criteria |
|---|---|---|
| 0 | Record `/api/health` release SHA + `dbPath` | Matches expected tip + durable path after cutover |
| 1 | Import sanitized fixture; set distinctive milestone e.g. `HOSTINGER-DURABILITY-CHECK` | Counts + value recorded |
| 2 | **Restart** (no redeploy) | Same counts + milestone + logins |
| 3 | Off-host backup of SQLite files | Files in hand |
| 4 | **Redeploy** authorized branch | New release SHA; `dbPath` still durable; data survives |
| 5 | (Optional) Restore rehearsal on a **copy** path or after intentional swap | Restored milestone returns |

If step 4 loses data: restore from step 3; **do not** import real data until path + procedure pass.

## Prerequisites

- Owner approval for env change + single restart/redeploy window
- Confirmed durable directory on this Hostinger plan
- Off-host place to store SQLite backups
- Auth + `AUTO_SEED=0` + Tracerfy production remains off

## Out of scope for this proposal

- Changing Hostinger settings in this PR
- Moving/resetting hosted data now
- Purchases, employer workbook import, QuickFixFarr changes

## Recommendation

Approve **A → B → C → verification table** as a separate ops task before any real workbook import. Until then, treat hosted SQLite as **non-durable** and keep hosted evaluation empty or sanitized-only under supervision.
