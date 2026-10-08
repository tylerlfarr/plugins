# Operator timed trial — 5–10 selected records

Disposable / trial data. Production Tracerfy **off**. Demo contacts are **labeled** (invented / local_fixture) — never treat as operational.

**Fairfax:** live retrieve supported with **limited** field coverage (status + milestone dates + links; pending/comments/holds/inspections often unavailable).  
**Other jurisdictions** (Loudoun, PWC, etc.): expect honest **`unavailable` / unsupported** — not fake success.

## Setup

1. Confirm release: `GET /api/health` → note `release.gitShaShort`.
2. Sign in with the **operator** account the owner created (Sources → Create trial user). Operators cannot activate sources or change Tracerfy/provider settings — owner does that first.
3. Use sanitized fixture (or owner-approved disposable extract) — not production employer workbook until persistence gate passes ([hostinger-persistence-checklist.md](hostinger-persistence-checklist.md)).
4. Pick **5–10** lot/permit rows the operator would normally touch this week.

## Per-record stopwatch

For each selected record, time two paths (minutes):

| Step | Manual (spreadsheet / portal) | In Permit Ledger |
|------|-------------------------------|------------------|
| Find row / open lot | | |
| Check official status / dates | | |
| Update internal milestone / note | | |
| Property / contact chase (if any) | | |
| Flag for morning Attention | | |

**Rules for Ledger timing**

- Run **Permit check** and record the returned outcome (`updated` / `no_change` / `not_found` / `unavailable` / `failed`).
- If jurisdiction is unsupported, stop after recording `unavailable` — do not invent portal data.
- For contact demo only: use **Create invented demo property** → **Find contact information**; label times as **demo**, not production enrichment.

## Roll-up

| Metric | Value |
|--------|-------|
| Records timed (n) | |
| Median manual minutes / record | |
| Median Ledger minutes / record | |
| Estimated minutes saved / record | |
| Fairfax checks that returned usable fields (count) | |
| Unsupported / unavailable outcomes (count) | |
| Demo-only contact lookups (count) | |
| Remaining purely manual steps (list) | |

## Pass criteria for “worth continuing”

- Operator can complete the 5–10 rows without losing edits on re-import.
- Outcomes stay honest (no silent fake Fairfax/Loudoun success).
- Export matches filtered/selected operational rows; demo/rejected contacts excluded from operational export.
- Attention list usable for the morning meeting subset.
