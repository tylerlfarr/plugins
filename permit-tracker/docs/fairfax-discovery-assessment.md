# Fairfax permit discovery vs ID check (assessment)

## What the app does today

| Action | Behavior |
|--------|----------|
| **Import workbook** | Creates saved permit rows (sections, lots, official IDs). |
| **Table search / filters** | Narrows **already imported** rows only. Typing “fairfax” does **not** call Fairfax GIS. |
| **Run Fairfax checks** | For each imported row with `jurisdiction_code = fairfax_county` and a non-empty official ID, queries Building Records PLUS by **`RECORDID`**. Returns `updated` / `no_change` / `not_found` / `unavailable` / `failed`. |
| **Empty DB** | Stats show 0 permits; Fairfax sync reports **0 checks** (correct — nothing to re-check). |

Checking imported IDs ≠ discovering new permits.

## Official Fairfax source (Building Records PLUS)

- Endpoint: `…/Building_Records_PLUS/FeatureServer/0` (public, no auth)
- Layer size (sampled): ~141k features; `maxRecordCount` 2000
- **Live for known ID:** `RECORDID` equality (app path today). Confirmed prefixes for live path: ALTC / ALTR / BLDR; BLDC only when jurisdiction is confirmed Fairfax.
- **Without known IDs (layer capability — not wired in app):**
  - Query by date window works with ArcGIS `DATE` / `TIMESTAMP` literals on `ISSUED_DATE` (and similar date fields). Raw epoch comparisons can error.
  - Query by building-use **label** works via `APPTYPEALIAS LIKE '%Residential%'` / `'%Commercial%'` (and related aliases). This is an official type string, not our internal use-classification enum.
  - Query by status (`RECORD_STATUS`) and address text fields also possible.
  - Results are **issued-heavy**; pending / reviewer comments / holds / inspections are **unavailable** on this layer (same limits as ID checks).
  - City of Fairfax is a **separate** AHJ — not this county PLUS layer.

## Demo-only / unsupported

| Capability | Status |
|------------|--------|
| Live Fairfax status + milestone dates for known county IDs | **Real** (PLUS layer) |
| Loudoun / PWC / other AHJ live retrieve by workbook ID | **Unsupported** → honest `unavailable` |
| Invented demo property + Find contacts (`local_fixture`) | **Demo-only** (labeled; excluded from operational export) |
| Production Tracerfy enrichment | **Off** by design until approved |
| Countywide “find all new Fairfax permits this week” in UI | **Not implemented** (layer can be queried by date/use; app does not) |

## Discovery without known IDs (feasibility)

Verified against the live PLUS layer (read-only):

| Capability | Result |
|------------|--------|
| Countywide count | ~141k features; `maxRecordCount` 2000 |
| Pagination | Layer supports result paging; app must page + dedupe by `RECORDID` |
| Date window | Works with ArcGIS `DATE` / `TIMESTAMP` on `ISSUED_DATE` (and similar). Raw epoch comparisons can error. |
| Building-use field | `APPTYPEALIAS` (e.g. Residential / Commercial strings) — not our internal use enum |
| Deduping | Use `RECORDID` as stable key across pages |
| Coverage limits | Issued-heavy; pending/comments/holds/inspections **unavailable**; City of Fairfax separate |

This is **not** implemented in the product UI. Feasibility only.

## Narrow next step (recommendation)

**Do not** treat search-as-discovery. Next scoped step:

> Add an **optional, owner-gated “Fairfax GIS browse”** that queries PLUS with a **date window + optional APPTYPEALIAS use filter**, lists candidate `RECORDID`s (read-only, paginated ≤50), and lets the operator **attach selected IDs** to an existing imported lot — or reject. Cap page size, no auto-import of the whole county, no Tracerfy, no other AHJs.

That keeps discovery separate from “Run Fairfax checks” and from table search.
