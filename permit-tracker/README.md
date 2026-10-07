# Permit Ledger (workbook-native prototype)

Automatically run specific permit checks for communities/lots, preserve the internal spreadsheet workflow, and show what changed before the morning meeting.

## Quick start

```bash
cd permit-tracker
npm install
npm run seed    # imports source workbook from Project store when present
npm run dev     # API :4173 + UI :5173
npm test
```

Single port: `npm run build && npm start`

Docs: [`docs/setup.md`](docs/setup.md) · [`docs/hostinger.md`](docs/hostinger.md) · [`docs/hostinger-persistence-checklist.md`](docs/hostinger-persistence-checklist.md) · [`docs/operator-trial-script.md`](docs/operator-trial-script.md) · [`docs/hands-on-private-trial.md`](docs/hands-on-private-trial.md) · [`docs/fairfax-discovery-assessment.md`](docs/fairfax-discovery-assessment.md) · [`docs/deploy.md`](docs/deploy.md) · [`docs/pwc-loudoun-source-evidence.md`](docs/pwc-loudoun-source-evidence.md) · [`docs/coverage-matrix.md`](docs/coverage-matrix.md) · [`docs/workbook-workflow-map.md`](docs/workbook-workflow-map.md)

## Source workbook

Default seed path:

`/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx`

- **Active:** Permit Tracker (24 section headers), Permit Revisions, Masterfile Plan Tracker, MST references  
- **Archived (stored):** Indirect Cost, 2018 IRC, Corewall, WHSD  

Import profile (employer mappings) is separate from reusable core — see `server/importProfile.js`.

## Live vs unsupported

| Jurisdiction | Mode |
|--------------|------|
| Fairfax County | **Live** Building Records PLUS FeatureServer |
| Loudoun, PWC, City of Fairfax, Houston, Harris | **Unsupported** → `unavailable` |

Failed live lookups **never** fall back to synthetic updates on imported records. Synthetic fixtures are demo/test-only (`record_origin` / `PERMIT_DEMO`).

Fairfax layer: status + milestone dates + links are live; pending/comments/holds/inspections are **unavailable**.

## Safety

- Internal milestones never cleared by blank import/sync cells  
- 3-way conflict detection on re-import (prev import / app / incoming)  
- Connectors write official fields only; snapshots name the ID queried  
- Check outcomes: `updated` / `no_change` / `not_found` / `unavailable` / `failed`  
- Structured export excludes demo/fixture rows  
