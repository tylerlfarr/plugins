# Coverage matrix (import-origin only)

Generated: 2026-10-04T20:05:20.803Z

## Exclusions
- Demo / fixture / injected test permits in DB after import: **0**
- Controlled change-detection flips are **not** counted as observed government transitions.

## Entity counts
| Entity | Count |
|--------|------:|
| Sections | 24 |
| Lot groups | 281 |
| Permit records | 293 |
| With official ID | 22 |
| ID-less | 271 |
| Multi-record expansions | 20 |

## Jurisdiction (suggested ≠ confirmed)
- **prince_william_county** (utility_geography_suggestion, confirmed=0): 198
- **prince_william_county** (project_code_suggestion, confirmed=0): 46
- **loudoun_county** (utility_geography_suggestion, confirmed=0): 33
- **unresolved** (unresolved, confirmed=0): 16

Utility/geography headers suggest county only; jurisdiction_confirmed=0 until operator confirms AHJ per record type.

## Workbook IDs attempted
- loudoun_county: 6 → BLDC-2026-013456, BLDC-2026-018839, BLDC-2026-029826, BLDC-2026-040694, BLDC-2026-040699, ZONC-2026-016733
- prince_william_county: 16 → BLD2025-05425, BLD2026-02569, BLD2026-02813, BLD2026-02814, BLD2026-02815, BLD2026-02989, BLD2026-02990, BLD2026-04765, BPR2025-02088, ZNA2026-02608, ZNA2026-02610, ZNA2026-02611, ZNA2026-02612, ZNA2026-02853, ZNA2026-02854, ZNA2026-04510

## Live matches (mode=live)
- Count: **0**
_None among import-origin workbook IDs (Fairfax County PLUS has no confirmed workbook rows)._

## Unsupported / unavailable
- Count: **22**
- Loudoun County, VA has no verified read-only connector in this build
- Prince William County, VA has no verified read-only connector in this build

## ID-less
- Shells: **271** · accepted automatic matches: **0** (see idless-matching.md)

## Registry snapshot
- `fairfax_county_building_records_plus` [fairfax_county] state=verified activated=0
- `pwc_gis_use_permits` [prince_william_county] state=verified activated=0
- `loudoun_res_building_permits_issued` [loudoun_county] state=needs_review activated=0
- `loudoun_issued_permit_reports` [loudoun_county] state=discovered activated=0
- `pwc_gis_planning_pending` [prince_william_county] state=discovered activated=0
- `loudoun_landmarc_guids_table` [loudoun_county] state=unsupported activated=0
- `loudoun_landmarc_portal` [loudoun_county] state=unsupported activated=0
- `pwc_eportal_energov` [prince_william_county] state=unsupported activated=0
