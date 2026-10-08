# Pilot Pack — Permit Ledger

## 1) Security one-pager

| Topic | Stance for pilot |
|-------|------------------|
| Data classes | Community/lot schedules, internal milestones, public AHJ IDs/status |
| Forbidden in V1 cloud | Real credentials to AHJ portals, payment data, PII beyond work emails/names already in tracker |
| Auth (before paid pilot) | SSO or magic-link; no shared “demo.user” in production |
| Tenant isolation | Separate DB schema or DB per builder org; no cross-tenant queries |
| Secrets | Env vars / secret manager; never commit |
| AHJ access | Prefer published open GIS/APIs; scrapes only with written ToS OK |
| Logging | No paste of full workbook dumps to third-party AI without agreement |
| Backup / retention | Daily encrypted backups; retention per customer contract |
| Export | Customer can export coexistence Excel anytime |

**Prototype today:** local SQLite, no auth, single tenant — **not** pilot-ready for customer data hosting.

---

## 2) Supported jurisdictions & fields matrix

| Jurisdiction | Connector | Official ID patterns | Status | Submit/Approve/Issue dates | Pending / comments / holds / inspections | Notes |
|--------------|-----------|----------------------|--------|----------------------------|------------------------------------------|-------|
| Fairfax County, VA | **Live** FeatureServer | `ALTC/ALTR/BLDC/BLDR-YYYY-…` | Live when found | Live when present | **Unavailable** on layer | Issued-heavy; workbook BLDC often Loudoun |
| Loudoun County, VA | Synthetic | `BLDC/ZONC/MASTR*/MASTC-…` | Synthetic fixtures | Synthetic | Manual / import | LandMARC portal; annual issued apps ≠ live sync |
| Prince William County, VA | Synthetic | `BLD/ZNA/BPR/MST…` | Synthetic fixtures | Synthetic | Manual / import | ePortal HTML |
| City of Fairfax, VA | Synthetic | demo | Synthetic | Synthetic | — | ≠ Fairfax County |
| City of Houston, TX | Synthetic | demo | Synthetic | Synthetic | — | Not in source workbook |
| Harris County, TX | Synthetic | demo | Synthetic | Synthetic | — | ≠ Houston |

**Internal (all jurisdictions):** section headers, lot ranges, housetype, milestone columns, col-S notes, owner, next action — import/export; never overwritten by connectors.

---

## 3) Demo script (operator)

**Setup:** `npm run seed && npm start` → http://localhost:4173

1. **Attention (1 min)** — Open Attention. Call out status changes and overdue actions as the morning list.  
2. **Community truth (2 min)** — Permits → search `Cascades` or `Bradley`. Show lot ranges + housetypes matching the spreadsheet mental model.  
3. **ID extraction (1 min)** — Open a sales-office row with notes containing `ZNA`/`BLD`/`BLDC`. Show structured IDs + raw notes preserved.  
4. **Live vs synthetic (2 min)** — Filter Fairfax-shaped → sync. Show live `ALTC-2026-00970` vs BLDC `not_found`/synthetic. Open Connectors field matrix.  
5. **Non-destructive import (1 min)** — Re-import store source workbook; confirm counts; show internal milestone still present.  
6. **Coexistence (1 min)** — Export Excel; open Attention + Permit Tracker Export sheets for spreadsheet users.

**Say explicitly:** “We are not replacing your workbook overnight — we run the checks and hand you the delta.”

---

## 4) Success criteria for a 2-week paid pilot

- Source workbook (or customer copy) imports without destroying notes  
- ≥1 live jurisdiction returning useful status for pilot communities **or** documented partial automation accepted  
- Morning Attention used in ≥3 standups  
- Export reconciles with spreadsheet for sampled rows  
- Zero incidents of synthetic labeled as live  

---

## 5) Links

- Requirements: `docs/requirements-map.md`  
- Context / risks: `docs/project-context.md`  
- Verification: `docs/prototype-report.md`  
- PR: https://github.com/tylerlfarr/plugins/pull/1  
