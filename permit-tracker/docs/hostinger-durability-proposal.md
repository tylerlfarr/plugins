# Hostinger durability proposal (approval required — do not execute yet)

**Status:** Proposal only. No Hostinger settings changes, no DB move/reset, no restart/redeploy/restore in this change set. **Ops owner must execute** after explicit approval.

**Related:** [hostinger-persistence-checklist.md](./hostinger-persistence-checklist.md), [hostinger.md](./hostinger.md), [deploy.md](./deploy.md), [cas-bump-policy.md](./cas-bump-policy.md)

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

## Exact proposed owner actions (do not run until approved)

### Prerequisites (owner confirms before any cutover)

| # | Prerequisite | Pass criteria |
|---|---|---|
| P1 | Maintenance window agreed (idle writes) | Team knows not to import/edit during cutover |
| P2 | Durable directory exists outside `hbuilds/versions/…` | Visible in File Manager; writable by Node app user |
| P3 | Off-host backup location ready | Laptop/S3/drive path recorded |
| P4 | Auth + `AUTO_SEED=0` + Tracerfy production off | Unchanged from pilot flags |
| P5 | Current `/api/health` SHA + owner `/api/health/details` `dbPath` recorded | Screenshot or note with timestamp |

**Proposed durable path (confirm in File Manager before use):**

`/home/u152631036/domains/darkgrey-gaur-146027.hostingersite.com/permit-ledger-data/permit-ledger.sqlite`

Create parent dir `permit-ledger-data/` if missing. Do **not** invent a different path without verifying Hostinger persistence docs for this plan.

### A) One-time migrate (copy, then cut over)

| Step | Exact action | Rollback if fail |
|---|---|---|
| A1 | Idle writes / short maintenance | — |
| A2 | In File Manager/SFTP: copy current version-scoped `permit-ledger.sqlite` **and** any `permit-ledger.sqlite-wal` / `-shm` to `permit-ledger-data/` | Leave originals untouched |
| A3 | Hostinger → Node.js → Environment: set `PERMIT_DB_PATH=<durable absolute path from A2>` | Unset or restore prior env value |
| A4 | Keep `AUTO_SEED=0`, auth on, Tracerfy disabled / `local_fixture` | Revert those flags only if you changed them (should not) |
| A5 | Restart the Node app **once** (no redeploy yet) | Point `PERMIT_DB_PATH` back to version-scoped path; restart once |
| A6 | Owner: `GET /api/health/details` → `dbPath` equals durable path | Same as A5 rollback |
| A7 | Spot-check: login works; user/permit counts match pre-move note from P5 | Restore pre-move copy over durable file; restart |

**Do not** delete the version-scoped DB until A6–A7 pass and an off-host backup exists.

### B) Backup procedure (daily or pre-deploy)

1. Prefer app idle or brief pause.
2. Copy `permit-ledger.sqlite` + `-wal`/`-shm` (if present) from the **durable** path to off-host storage.
3. Label archive: `YYYY-MM-DD-HHMM-<gitShaShort>.sqlite` using `/api/health` → `release.gitShaShort`.

Hostinger MySQL/Postgres “database backups” typically **do not** cover this SQLite file.

### C) Restore procedure (emergency / rehearsal)

1. Stop Node app.
2. Replace durable SQLite files with the backup set (all three siblings if WAL mode).
3. Start app; verify `/api/health`, login, and a known permit / distinctive milestone.
4. If restore target was a **copy** path for rehearsal, do not overwrite production durable file until counts match.

### D) Disposable verification plan (sanitized only — after approval)

Use `server/fixtures/sanitized-source-workbook.xlsx` only. **No** employer/gospel workbook. **No** paid Tracerfy.

| Step | Action | Pass criteria | Local ≠ hosted |
|---|---|---|---|
| 0 | Record `/api/health` release SHA + owner `dbPath` | Tip SHA + durable path after cutover | Hosted only |
| 1 | Import sanitized fixture; set distinctive next_action e.g. `HOSTINGER-DURABILITY-CHECK` | Counts + value persisted | Hosted |
| 2 | **Restart** once (no redeploy) | Same counts + milestone + logins | Hosted |
| 3 | Off-host backup of SQLite files | Files in hand with SHA label | Hosted |
| 4 | **Redeploy** authorized branch | New release SHA; `dbPath` still durable; data from step 1 survives | Hosted |
| 5 | Restore rehearsal into a **separate copy** file (or after intentional swap on disposable DB) | Restored milestone returns; counts match backup | Hosted |

If step 4 loses data: restore from step 3; **do not** import real data until path + procedure pass.

### Rollback summary

| Failure point | Owner action |
|---|---|
| Wrong `dbPath` after restart | Set `PERMIT_DB_PATH` back to previous path; restart once |
| Durable file corrupt/empty | Copy pre-move version-scoped DB (kept until verified) over durable path; restart |
| Redeploy wiped data (path still version-scoped) | Treat as failed cutover; fix path; restore from off-host backup; do not import gospel |

## Out of scope for agents / this PR

- Changing Hostinger settings
- Moving/resetting hosted data
- Restart, redeploy, or restore execution
- Purchases, employer workbook upload, QuickFixFarr changes

## Recommendation

Approve **Prerequisites → A → B → C → D** as a separate ops task before any real workbook import. Until then, treat hosted SQLite as **non-durable** and keep hosted evaluation empty or sanitized-only under supervision.
