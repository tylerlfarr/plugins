# Prince William & Loudoun — machine-readable source evidence

Verified: 2026-10-04 (read-only public probes).  
Workbook IDs used: `BLD2026-*`, `ZNA2026-*`, `BPR2025-*`, `BLDC-2026-*`, `ZONC-2026-*`.

## Prince William County

### Authoritative portal
| Item | Value |
|------|-------|
| Portal | [ePortal / Energov SelfService](https://egcss.pwcgov.org/SelfService#/home) |
| Agency page | https://www.pwcva.gov/department/development-services/eportal-access |
| Platform | Tyler Energov HTML |
| Active workflow | Apply, plans, inspections, pay — account for write paths |
| Public search | HTML search available; **no verified per-permit JSON/API** for `BLD*`/`ZNA*` |

### GIS / open data investigated
| Source | Endpoint | Result vs workbook |
|--------|----------|--------------------|
| Use Permits (SUP/NCU) | `…/Planning/Zoning/MapServer/6` | **Verified RO.** Fields: ZoningCaseNumber, UsePermitStatus, DateApproved, EGOV_CaseID. Case numbers are `PLN*` — **0** matches for `ZNA%`/`BLD%`. |
| Planning Pending Cases | `…/Planning/Land_Development/MapServer/4` | **Discovered.** `PLN*`/`PFR*` planning cases + staff report PDFs — not building permits. |
| EGov_ePortal MapServer | `…/EGov/EGov_ePortal/MapServer` | Basemap/parcels/addresses only — **no permit attribute layer**. |
| GIS Hub | https://gisdata-pwcgov.opendata.arcgis.com/ | Parcels, zoning overlays, footprints — no active building-permit FeatureServer found for workbook ID shapes. |

### Exact blocker (practical)
**No public machine-readable service exposes workbook building/zoning IDs (`BLD2026-04765`, `ZNA2026-04510`, …) with status + milestone dates.**  
Portal is HTML/Energov; GIS layers that do exist are zoning/planning case numbers, not Development Services permit numbers. This is investigated + blocked — not “not yet looked at.”

### Notification alternative
Customer-authorized ePortal account notifications / email alerts — **interface only** this milestone (no private email/company auth).

---

## Loudoun County

### Authoritative portal
| Item | Value |
|------|-------|
| Portal | [LandMARC](https://www.loudoun.gov/landmarc) |
| Platform | LandMARC HTML land-management |
| Active workflow | Permits, plans, inspections, fees |
| Public search | Documented HTML public records search; **no verified per-permit API** for `BLDC-*` / `ZONC-*` |

### GIS / open data investigated
| Source | Endpoint | Result vs workbook |
|--------|----------|--------------------|
| ResBuildingPermits | `…/Projects/ResBuildingPermits/MapServer/0` | **RO works.** Issued residential; `PERMIT_NUMBER` like `B80…` (legacy LMIS). Count 3916; `LIKE 'BLDC%'` → **0**. Latest sampled issue dates ~2018–2019. **Issued-only, wrong ID scheme, stale for active 2026 LandMARC IDs.** |
| PermitDashboard | same schema | Same issued residential layer. |
| ResBuildingPermits_Historic | historic twin | Same ID scheme; planning analytics. |
| Landmarc_GUIDs table | `…/Landmarc_GUIDs/FeatureServer/1` | Metadata lists `PlanNumber`, `PlanStatus`, `PlanGuid`. **All queries fail (HTTP 400)** — practical access blocker. |
| Issued Building Permit Reports | https://www.loudoun.gov/1164/Issued-Building-Permit-Reports | Monthly Excel/PDF **issued-only** downloads (since mid-2023 halves). Not active status. |
| GeoHub | https://geohub-loudoungis.opendata.arcgis.com/ | Parcels, zoning, annual issued apps — not active per-permit tracker. |

### Exact blocker (practical)
1. Active LandMARC IDs in the workbook (`BLDC-2026-*`, `ZONC-*`) are **not** in the public ResBuildingPermits GIS (different numbering era/scheme).  
2. Landmarc_GUIDs tables that look promising **cannot be queried** publicly.  
3. Authoritative active status remains HTML LandMARC — do not bypass login/CAPTCHA.

### Town vs county
Loudoun notes incorporated towns may require separate approvals by record type. Utility headers (LoCo Water) **suggest** county geography only — not confirmed AHJ for every building/zoning record.

---

## What we ship instead of fake connectors
- Source **registry** with verified vs unsupported clearly labeled  
- Reusable **ArcGIS discovery/inspection**  
- **Connect a Location** workflow (review before activate)  
- Fairfax County PLUS remains the only **verified active** building connector  
- PWC Use Permits verified for **zoning SUP/NCU only** (not workbook building coverage)

Do **not** inflate operational coverage: fixtures, demo/test records, and injected change-detection flips are excluded from coverage counts.
