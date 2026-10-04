# Permit Ledger — Requirements Map (Workbook-Native)

**Source workbook evidence:** `/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx` (inspected Oct 2026).  
Observations below are from that file. Assumptions are labeled.

---

## Workbook structure (observed)

| Sheet | Rows (approx) | Role in V1 |
|-------|---------------|------------|
| **Permit Tracker** | 353 · **24** repeating `Proj ID` header blocks | Primary — section-aware import |
| **Permit Revisions** | sparse (~2 active rows in sample) | Import |
| **Masterfile Plan Tracker** | plan readiness by product/county | Import |
| **MST's** | county masterfile reference IDs (LoCo / PWC / Fairfax / misc) | Import IDs as references |
| Indirect Cost | fee rollups | **Ignore/archive** this milestone |
| 2018 IRC Tracker | legacy code-mod schedule | **Ignore/archive** |
| Corewall Alternative Tracker | UL alternatives | **Ignore/archive** |
| WHSD Masterfile | deep WHSD comment cycles | **Ignore/archive** |

### Permit Tracker section pattern (observed)

Each community block is a **2-row header**:

1. Row N: `Proj ID | Lot | Housetype | Permit…` plus variable milestone columns; col **S** often `Permit time: …`
2. Row N+1: **project code** in A (e.g. `BSO1`, `CAM2`, `IN1 sec. 4`), sub-labels (`Release`, `Ordered`, `Received`, `ZONING applied`…)
3. Data rows: community name may repeat in A; **lot ranges** in B (`96-100`, `1-8 (M1)`, `lots 1 & 2`); housetype in C; milestone cells mix **dates**, **status text** (`APPLY`, `na`, `rqst`, `john/bk`), and free notes.

**Official IDs live in column S notes** (not a dedicated ID column), e.g.  
`ZNA2026-04510 / BLD2026-04765`, `BLDC-2026-040694 / BLDC-2026-040699`.

Prefixes observed: `ZNA*`, `BLD*`, `BLDC*`, `ZONC*`, `BPR*`, plus MST sheet `MST*`, `MASTR*`, `MASTRR*`, `MASTC*`.

---

## Field classification

| Concept | Class | Notes |
|---------|-------|-------|
| Project code / community section | Internal structural | Header block identity |
| Lot label (incl. ranges) | Internal structural | LotGroup; range allowed |
| Housetype | Internal | |
| Milestone columns (ordered/received/zoning/water/deck/…) | **InternalMilestone** | Schema varies by section; never overwritten by connectors |
| Col S notes / permit time | Internal + ID source | Preserve raw; extract IDs |
| Official IDs (0..n) | Official | Structured `official_ids`; primary = first extracted |
| Source-native / normalized status | Official / derived | From connector when live |
| Official snapshot dates | Official | Separate `official_*` milestone keys from connector |
| Next action / owner / internal status | Internal | Attention drivers |
| Predicted timing | Derived | Not inferred from blanks |

**Lifecycle distinction (preserved):** submission / approval / issuance / revision / construction start remain separate milestone keys — not collapsed into one status. Revision sheet is first-class.

---

## Ambiguities

| Ambiguity | Handling |
|-----------|----------|
| Multi-row headers differing per community | Named section-aware importer; store `header_json` per section |
| Lot ranges vs single lots | `lot_label` free text; no forced explode in V1 |
| IDs embedded in notes | Regex extract; keep `notes_raw` intact |
| Mixed jurisdiction IDs in one cell | Review queue |
| Date vs status text in same column | `value_kind` date\|text\|empty |
| BLDC-* looks Fairfax-shaped but often Loudoun LandMARC | Ambiguous without confirmed mapping → `unavailable` / review; **no** live→synthetic fallback |
| Duplicate key | `community + lot-group + housetype + primary official ID` |

---

## Functionality ↔ evidence

| Capability | Evidence | V1 |
|------------|----------|----|
| CommunitySection + LotGroup + PermitRecord | 24 header blocks, lot ranges | Yes |
| 0..n official IDs from notes | Col S patterns | Yes |
| InternalMilestone non-overwrite | Spreadsheet is source of truth for ops columns | Yes |
| Import Permit Tracker + Revisions + Masterfile + MST IDs | Sheet presence | Yes |
| Fairfax live sync on Fairfax-shaped IDs | FeatureServer verified | Partial automation (issued-heavy) |
| Loudoun / PWC connectors | LandMARC / ePortal observed; no verified per-permit API | Unsupported → `unavailable` |
| Attention before morning meeting | Product promise | Yes |
| Coexistence Excel export | Teams still live in workbook | Yes |

---

## Competitor stress (pricing-aware)

| Player | Positioning | Pricing signal (primary sources) | Implication |
|--------|-------------|-----------------------------------|-------------|
| PermitFlow | AI filing / AHJ automation | Custom / enterprise | Not the cheap tracker; don't compete on filing |
| PermitDesk / PermitTracker-class tools | Cheap dashboards | Affordable SaaS | **Do not** win as “another cheaper dashboard” |
| Procore | Full PM | Enterprise volume pricing | Overkill for permit ops spreadsheet |
| Excel status quo | Free | Zero | Must coexist via import/export |

**Differentiation hypothesis:** Automatically run the *specific* checks builders already track in this workbook, preserve internal milestones, and surface **what changed overnight** — not a generic kanban.

---

## Jurisdiction matrix (workbook-native)

| Jurisdiction | In workbook? | Access | Prototype mode |
|--------------|--------------|--------|----------------|
| Prince William (PWC) | Heavy (Bradley, Innovation, Potomac Shores, Quartz…) | ePortal HTML | Synthetic |
| Loudoun (LoCo) | Cascades, Tuscarora, BLDC/MASTR* IDs | LandMARC + annual issued apps | Synthetic |
| Fairfax County | MST Fairfax column; fewer Permit Tracker rows | **Live** Building Records PLUS FeatureServer | Live read-only |
| City of Fairfax | Distinct from county | Accela portal | Synthetic |
| Houston / Harris | Not in source workbook (kept for prior demo adapters) | — | Synthetic labeled |

---

## Phase conclusions

**Smallest useful product:** Source workbook import → Fairfax live checks where the layer returns data → preserve internals → attention list → coexistence export.

**Automation partial:** Fairfax layer exposes status + submit/accept/approve/issue/close dates + links; **pending / comments / holds / inspections = unavailable**. Revision workflow stays manual/import.

**Genuine blockers:** None for local prototype. Loudoun/PWC live APIs unverified. Paid pilot needs auth, tenant isolation, ToS review for GIS redistribution.
