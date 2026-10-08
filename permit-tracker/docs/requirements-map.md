# Permit Ledger — Requirements Map (Workbook-Native)

**Source workbook evidence:** `/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx` (inspected Oct 2026).  
Observations below are from that file. Assumptions are labeled.

---

## Workbook structure (observed)

| Sheet | Rows (approx) | Role in V1 |
|-------|---------------|------------|
| **Permit Tracker** | 353 · **24** repeating `Proj ID` header blocks | Primary — section-aware import |
| **Permit Revisions** | sparse (~2 active rows in sample: CAM2 lots 7, 17) | Import + lot-readiness revision impact |
| **Masterfile Plan Tracker** | plan readiness by product/county | Import (shared-plan reference) |
| **MST's** | county masterfile reference IDs (LoCo / PWC / Fairfax / misc) | Import IDs as references |
| Indirect Cost | fee rollups | **Ignore/archive** |
| 2018 IRC Tracker | legacy code-mod schedule | **Ignore/archive** |
| Corewall Alternative Tracker | UL alternatives | **Ignore/archive** |
| WHSD Masterfile | deep WHSD comment cycles | **Ignore/archive** |

### Permit Tracker section pattern (observed)

Each community block is a **2-row header**:

1. Row N: `Proj ID | Lot | Housetype | Permit…` plus variable milestone columns; col **S** often `Permit time: …`
2. Row N+1: **project code** in A (e.g. `BSO1`, `CAM2`, `IN1 sec. 4`), sub-labels (`Release`, `Ordered`, `Received`, `ZONING applied`…)
3. Data rows: community name may repeat in A; **lot ranges** in B (`96-100`, `1-8 (M1)`, `lots 1 & 2`); housetype in C; milestone cells mix **dates**, **status text** (`APPLY`, `na`, `rqst`, `john/bk`), and free notes.

**Official IDs live in column S notes** (not a dedicated ID column).

**High-frequency milestones (observed filled counts):** Target Start Date (~256), Permit Release (~258), Permit Ordered (~179), StartSheet Distributed (~117), Permit Received (~106), deck zoning/permit columns, PW/LoCo water-sewer requested/paid.

---

## Field classification

| Concept | Class | Notes |
|---------|-------|-------|
| Project code / community section | Internal structural | Header block identity |
| Lot label (incl. ranges) | Internal structural | LotGroup; range allowed |
| Housetype | Internal | |
| Milestone columns (ordered/received/zoning/water/deck/…) | **InternalMilestone** | Schema varies by section; never overwritten by connectors |
| Target Start Date | Internal schedule | Informational for readiness; drives approaching-start Attention |
| Col S notes / permit time | Internal + ID source | Preserve raw; extract IDs |
| Official IDs (0..n) | Official | Structured `official_ids`; primary = first extracted |
| Source-native / normalized status | Official / derived | From connector when live |
| Official snapshot dates | Official | Separate `official_*` milestone keys from connector |
| Permit Revisions | Shared revision | Linked to lots by project code + lot; open = needs review |
| Next action / owner / internal status | Internal | Attention drivers |
| Lot readiness (Ready / Blocked / Needs verification) | **Derived operational** | Under configurable workbook rules — not silent issuance |

**Lifecycle distinction (preserved):** submission / approval / issuance / revision / construction start remain separate milestone keys — not collapsed into one status.

---

## Current implementation vs workbook

| Capability | Origin | Impl | Notes |
|------------|--------|------|-------|
| CommunitySection + LotGroup + PermitRecord | Workbook headers | **Functional** | 24 sections; lot ranges preserved |
| Internal milestones + re-import conflicts | Workbook cells | **Functional** | Blanks do not wipe; 3-way conflicts |
| Official ID extract from notes | Col S | **Functional** | Multi-record siblings supported |
| Fairfax live sync | Gov GIS | **Partial** | Issued-heavy; pending/comments/holds unavailable |
| PWC / Loudoun live sync | Gov portals | **Missing / blocked** | Honest `unavailable`; no synthetic fallback |
| Source registry + Connect a Location | Product | **Functional** | Review-before-activate |
| **Lot-readiness rules** | Workbook prereqs | **Functional (this slice)** | Configurable; section-header-aware blanks |
| Ready / Blocked / Needs verification | Derived | **Functional** | Missing evidence ≠ Ready |
| Approaching starts Attention | Target Start | **Functional** | Default 21-day window |
| Revision impact on lots | Permit Revisions | **Functional** | Flags review; does not auto-invalidate |
| Masterfile ↔ lot auto-link | Masterfile sheet | **Partial** | Imported; not auto-joined to lots yet |
| Document upload / mailbox | Assumed ops | **Missing** | Deferred |
| Excel coexistence export | Product | **Functional** | Structured (not original layout); includes readiness |

---

## Ambiguities → operator questions

| Ambiguity | Handling now | Ask operator |
|-----------|--------------|--------------|
| Multi-row headers differing per community | Named section-aware importer | Confirm any community that should use a non-default prereq template |
| Lot ranges vs single lots | Keep grouped | When to explode ranges? |
| Deck / shed / sprinkler columns | Optional (not default Ready gates) | Which communities require deck path before start? |
| `na` in utility/permit cells | Treated as waived | Confirm `na` always means not applicable |
| APPLY / can apply / rqst | Blocked (in progress) | Any status text that should mean Ready? |
| Open revisions | Needs verification / Attention | Who owns revision follow-up by default? |
| BLDC-* jurisdiction | Unconfirmed / unavailable | Fairfax vs Loudoun mapping per ID |
| Masterfile plans vs lot housetype | Not auto-linked | Confirm join key (product + county + housetype?) |

---

## Jurisdiction matrix

| Jurisdiction | In workbook? | Access | Prototype mode |
|--------------|--------------|--------|----------------|
| Prince William (PWC) | Heavy | ePortal HTML; GIS SUP/NCU only | **Unavailable** (no live→synthetic) |
| Loudoun (LoCo) | Cascades, Tuscarora, BLDC/MASTR* | LandMARC + issued apps | **Unavailable** |
| Fairfax County | Fewer rows; Fairfax-shaped IDs | Building Records PLUS FeatureServer | **Live** read-only |
| City of Fairfax | Distinct | Accela | Unsupported |
| Houston / Harris | Not in source workbook | — | Demo adapters only (labeled) |

---

## Lot-readiness rules (default_workbook_v1)

Assessed per import-origin permit/lot from **section headers + lot milestone values**:

1. **Permit Release**, **Permit Ordered** / utility ordered-requested, **Permit Received** / utility received, **Water/Sewer Paid**, **StartSheet Distributed** — required **if present** on the community section (blank lot cell = outstanding).
2. **Target Start Date** — informational; Attention when within approaching window and not Ready.
3. Value classes: ISO date = satisfied; `na` = waived; `APPLY`/`rqst`/… = in progress (Blocked); other text = Needs verification; empty = Blocked when column present.
4. Open **Permit Revisions** matching project + lot → gap for review (not silent invalidation).
5. Official ID with never/failed/unavailable AHJ check → automation gap (Needs verification), never invent Ready.
6. States: **Ready** / **Blocked** / **Needs verification** — labeled as operational assessment under configured rules.

Configurable via `GET/PUT /api/readiness/rules` (stored in settings).

---

## Phase conclusions

**Smallest useful product now:** Workbook import → lot-readiness under rules → Attention (starts/blockers/changes/revisions) → Fairfax live where verified → coexistence export.

**Automation partial:** Fairfax only. PWC/Loudoun remain honest gaps; readiness still works from workbook evidence.

**Genuine blockers:** None for local prototype. Paid pilot needs auth, tenant isolation, ToS review for GIS redistribution.
