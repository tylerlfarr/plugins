# Permit Ledger (local prototype)

Builder permit-tracking prototype: community → project → lot → multi-permit inventory, Excel import/export, attention view, change history, and a reusable jurisdiction connector interface.

## Quick start

```bash
cd permit-tracker
npm install
npm run seed
npm run dev
```

- API: `http://localhost:4173`
- UI (Vite): `http://localhost:5173` (proxies `/api`)

Production-ish local serve (API + built UI on one port):

```bash
npm run build
npm start
```

## Tests

```bash
npm test
```

## What is live vs synthetic

| Jurisdiction | Mode |
|--------------|------|
| Fairfax County, VA | **Live** read-only ArcGIS FeatureServer query |
| City of Fairfax, VA | Synthetic (portal exists; API not verified) |
| City of Houston, TX | Synthetic |
| Harris County, TX | Synthetic |

Never treat synthetic connector results as live AHJ data.

## Safety rules baked in

- Official vs internal status are separate
- Source-native status stored alongside normalized status
- Connectors/imports do not clear blank-overwritten notes/milestones
- Match on jurisdiction + official ID
- Check outcomes: `updated` / `no_change` / `not_found` / `unavailable` / `failed`
- Predicted issue dates are labeled non-official

## Data

SQLite file: `data/permit-tracker.sqlite` (gitignored). Demo seed only — no employer records.
