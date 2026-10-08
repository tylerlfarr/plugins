# Full workbook workflow & source map

Source workbook: `Permit_Tracker_9.1.2026.xlsx` (8 sheets).  
Import profile (`server/importProfile.js`) is separate from reusable core.

## Sheet inventory

| Sheet | Business purpose | Import stage | Automation candidate | Verification |
|-------|------------------|--------------|----------------------|--------------|
| **Permit Tracker** | Day-to-day community/lot permit coordination; milestones; notes with official IDs | **Active** — section-aware | Fairfax County PLUS for confirmed Fairfax IDs | Live connector verified for ALTC/ALTR/BLDR (+ BLDC only with confirmed Fairfax mapping) |
| **Permit Revisions** | Track revised start sheets / resubmittals | **Active** | Manual + future portal comments (unavailable on Fairfax PLUS) | Imported as structured rows |
| **Masterfile Plan Tracker** | Product/plan readiness across counties | **Active** | Plan status portals (unsupported) | Imported; IDs extracted from notes |
| **MST's** | Masterfile / masterplan reference IDs by county columns | **Active** — reference only | Link to lots only with evidence | Stored; **no auto-link** without evidence |
| Indirect Cost | Fee rollups | **Archived** (stored, not wiped) | Accounting systems | Deferred |
| 2018 IRC Tracker | Legacy code-mod schedule | **Archived** | Internal | Deferred |
| Corewall Alternative Tracker | UL alternatives | **Archived** | Vendor/engineering | Deferred |
| WHSD Masterfile | Deep WHSD comment cycles | **Archived** | Portal comments | Deferred |

## Permit Tracker field map

| Field / concept | Sheet provenance | Relationship | Original source class | Human decision remaining |
|-----------------|------------------|--------------|----------------------|--------------------------|
| Project code | Header row N+1 col A | CommunitySection | Internal | Confirm community naming |
| Community name | Data col A | CommunitySection | Internal | |
| Lot label (incl. ranges) | Col B | LotGroup stable key | Internal | Keep ranges; no auto-explode |
| Housetype | Col C | LotGroup | Internal / product | |
| Milestone columns | Header rows N/N+1 cols D+ | InternalMilestone | Internal / AHJ / vendor | Blanks do not wipe; conflicts previewed |
| Col S notes / permit time | Col S / header | notes_raw + ID extract | Mixed | Preserve raw text |
| Official IDs (0..n) | Embedded in col S | official_ids + PermitRecord per ID | Gov portal | Ambiguous jurisdiction → review |
| Jurisdiction | Headers (LoCo/PW/…) + import profile | confirmed_mapping wins | Gov / mapping table | Prefixes suggest only |
| Next action / owner / internal status | App (not always in sheet) | PermitRecord | Human | Attention drivers |
| Official status / dates | Connector snapshot | official_* fields | Gov API/GIS | Missing evidence ≠ ready |

## Source classes

| Class | Examples in this workbook |
|-------|---------------------------|
| Gov API / GIS | Fairfax Building Records PLUS FeatureServer |
| Gov portal (no verified API) | Loudoun LandMARC, PWC ePortal, City of Fairfax Accela |
| Internal spreadsheet | Milestone columns, lot ranges, owners |
| Vendor / engineering | Corewall (archived), plan products |
| Accounting | Indirect Cost (archived) |
| Email / docs | Not connected — interface only |
| Human | Match reviews, conflict resolution, ID-less address matching |

## Staged omissions (this milestone)

- No address/parcel auto-match for ID-less rows (review required).
- No MST→lot auto-link without evidence.
- No Loudoun/PWC live connectors (return `unavailable`).
- No email/Slack digest send (local schedule preview only).
- Archived sheets stored as payloads; no workflow UI yet.
- No billing / multi-tenant auth (pre-hosting requirements documented in pilot pack).

## Identity rules (implemented)

1. Stable key = project + community + lot + housetype (not first ID).
2. Multiple official IDs on one lot → multiple PermitRecords.
3. ID reorder/correction updates association; does not invent a new project.
4. Confirmed jurisdiction mapping beats ID heuristics; BLDC alone is ambiguous.
