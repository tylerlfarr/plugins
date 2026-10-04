# Coverage matrix (import-origin only)

Generated: 2026-10-04T19:54:55.644Z

Workbook: `/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx`

## Exclusions
- Demo/fixture permits excluded: **0**
- Counts below are `record_origin = import` only.

## Entity counts
| Entity | Count | Meaning |
|--------|------:|---------|
| Community sections | 24 | Header blocks on Permit Tracker |
| Lot groups | 281 | Stable lot identity (ranges kept) |
| Permit records | 293 | Official-record shells |
| With official ID | 22 | |
| Without official ID | 271 | Human review / address match later |
| Official ID links | 22 | |
| Permit Revisions | 2 | |
| Masterfile Plan Tracker | 18 | |
| MST reference IDs | 52 | Reference only — no auto-link |
| Archived sheet rows | 135 | Stored, not wiped |

## Jurisdiction (permits)
- **prince_william_county** (confirmed_mapping, confirmed=1): 244
- **loudoun_county** (confirmed_mapping, confirmed=1): 33
- **unresolved** (unresolved, confirmed=0): 16

## IDs by prefix
- BLD: 8
- BLDC: 5
- BPR: 1
- ZNA: 7
- ZONC: 1

## Live Fairfax checks (confirmed Fairfax Permit Tracker rows)
- Attempted: 0
- Matched: 0
- Note: Confirmed Fairfax County Permit Tracker rows only (this workbook has none)

_None — this source workbook’s Permit Tracker rows are Loudoun/PWC/unresolved only._

## MST Fairfax reference live checks
- Attempted: 0 · Matched: 0


## BLDC + confirmed Loudoun guard
- `BLDC-2026-013456` → unavailable (none)
- `BLDC-2026-040694` → unavailable (none)
- `BLDC-2026-040699` → unavailable (none)

## Unsupported AHJ checks (no synthetic fallback)
- `BLD2026-04765` [prince_william_county] → unavailable
- `ZNA2026-04510` [prince_william_county] → unavailable
- `BLDC-2026-013456` [loudoun_county] → unavailable
- `ZONC-2026-016733` [loudoun_county] → unavailable
- `BLDC-2026-040694` [loudoun_county] → unavailable
- `BLDC-2026-040699` [loudoun_county] → unavailable
- `BLDC-2026-029826` [loudoun_county] → unavailable
- `BLD2025-05425` [prince_william_county] → unavailable

## Limits
- Address/parcel matching for ID-less rows: **not implemented** (review required).
- MST linking: reference storage only; no evidence-free auto-link.
- Fairfax PLUS: pending/comments/holds/inspections **unavailable** on this layer.
