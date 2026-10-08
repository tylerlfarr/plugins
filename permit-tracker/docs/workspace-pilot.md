# Workspace model (Phase 2 pilot)

## Contract

| Rule | Detail |
|---|---|
| Isolation unit | **One SQLite database file = one business** |
| Membership | `workspaces` + `workspace_members` — every authenticated user is enrolled in the default workspace (`org_key = default`) |
| Visibility | Any authenticated **owner** or **operator** in that DB sees the full workbook (permits, exports, sync, import, Attention) |
| Not yet | Soft multi-tenant row filters (`workspace_id` on every domain table) |

Do **not** add a second customer’s data to the same DB path. Prefer a new DB file (and Hostinger env) per business when that day comes.

## What shipped

- Tables: `workspaces`, `workspace_members`
- Auto-create default workspace; backfill existing users on migrate / auth ensure
- Enroll on owner bootstrap, invite accept, and direct operator create
- `GET /api/workspace` and `authUser.workspace` / `meta.workspace` expose the pilot workspace
- Owner-only: `PUT /api/readiness/rules`, `POST /api/readiness/rebuild` (operators keep daily permit/export/sync)

## Backfill before a second tenant

1. Add nullable/non-null `workspace_id` (default = current default workspace id) to domain tables (`community_sections`, `lot_groups`, `permit_records`, …).
2. Backfill every existing row to that id in one transaction.
3. Scope list/detail/export/sync/import queries with `workspace_id = req.workspace.id`.
4. Stop auto-enrolling every user into a single default; invite into a specific workspace instead.
5. Keep **DB-per-customer** as the supported Hostinger path until (3) is proven with isolation tests.

Until then, leakage prevention is operational: never share `PERMIT_DB_PATH` across businesses.

## Lot groups vs official records

- Lot groups are **containers** (community + lot label + housetype), not property identity.
- Empty workbook lot cells import as lot label `(no lot)` — still a lot_group row so no orphan FK.
- Multiple official IDs on one workbook row create **multiple** `permit_records` sharing one lot group.
- Blank trailing section headers with zero data rows are **not** promoted as projects on commit.
