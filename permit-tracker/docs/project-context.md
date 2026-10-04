# Permit App — Project Context (Workbook-Native)

## Product promise
Automatically run specific permit checks for communities/lots, **preserve the internal spreadsheet workflow**, and show **what changed before the morning meeting**.  
Not “another cheaper dashboard” (PermitDesk/PermitTracker-class tools already occupy cheap tracking).

## Source workbook
`/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx` — Northern Virginia open starts & permit tracker (8 tabs; Permit Tracker has 24 repeating header blocks).

## Six-risk guardrails

| # | Risk | Mitigation in prototype |
|---|------|-------------------------|
| 1 | Overwrite internal milestones with AHJ/sync/import blanks | Blanks don’t wipe; 3-way conflict on app edits |
| 2 | Present synthetic as live | Synthetic blocked for import records; demo/fixture isolated |
| 3 | Wrong jurisdiction for lookalike IDs (BLDC Loudoun vs Fairfax) | Confirmed mapping wins; BLDC unresolved → unavailable; no live→synthetic fallback |
| 4 | Infer issuance/approval from missing fields | Never; blanks stay blanks; readiness requires evidence |
| 5 | Duplicate / ambiguous matches | Stable lot key; multi-record per ID; match review queue |
| 6 | Connector fragility nights/weekends | Outcomes + check_runs + schedule preview; attention on failures |

## Competitor pricing posture
- **PermitFlow:** custom/enterprise filing automation — different job-to-be-done.
- **Cheap dashboards:** race-to-bottom on UI; we win on **workbook-native automation + morning delta**.
- **Excel:** free; structured coexistence export is mandatory.
- **Procore/PM suites:** expensive; permit ops is a side feature.

## Stack decisions
- Vite React + Express + SQLite under `permit-tracker/`
- Section-aware importer (`workbookImport.js`) + import profile (`importProfile.js`)
- Fairfax County FeatureServer = only live adapter
- Loudoun, PWC, Houston, Harris, City of Fairfax = unsupported (`unavailable`)

## Durable principles
1. Spreadsheet columns are InternalMilestones until a connector proves an official field.
2. Official IDs are structured, but notes remain the human audit trail.
3. Attention is the product surface for morning meetings.
4. Tenant isolation + auth required before any paid multi-customer pilot.

## Open questions
1. Operator confirmation of BLDC Cascades → Loudoun forever (current: confirmed LoCo headers).
2. Address/parcel strategy for 271 ID-less Permit Tracker shells.
3. Whether MST Fairfax-column IDs should ever auto-link (currently reference-only).
