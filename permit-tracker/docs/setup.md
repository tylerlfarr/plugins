# Setup

## Requirements

- Node.js 20+
- npm

## Install & run

```bash
cd permit-tracker
npm install
npm run seed          # imports source workbook from Project store when present
npm run seed:demo     # same + isolated Fairfax probe (record_origin=demo)
npm run dev           # API :4173 + Vite :5173
npm run build && npm start   # single-port production-ish
```

## Source workbook path

Default candidates (first hit wins):

1. `$SOURCE_WORKBOOK_XLSX` or `$GOSPEL_XLSX`
2. `/cursor/stores/self/internal/Permit_Tracker_9.1.2026.xlsx`
3. Agent-store / uploads mirrors

## Tests

```bash
npm test                 # offline integrity + discovery + optional live workbook
npm run test:live        # Fairfax controlled demo + coverage (network)
npm run coverage:report  # import-origin coverage only (excludes demo/fixtures/injected)
npm run investigate:idless
npm run demo:fairfax-attention   # labeled "live lookup + controlled change-detection test"
npm run fixture:build
```

Offline tests never require the private workbook, Cursor-only paths, or network.  
Optional workbook tests skip cleanly when the source xlsx is absent.

UI: Permits · Attention · Import · **Sources** (Connect a location + registry + ArcGIS inspect) · Connectors.

## Environment

| Variable | Purpose |
|----------|---------|
| `PERMIT_DB_PATH` | SQLite file path |
| `PORT` | API port (default 4173) |
| `PERMIT_DEMO=1` | Allow demo probe + synthetic for demo/fixture origins only |
| `SOURCE_WORKBOOK_XLSX` | Override workbook path |

## Integrity notes

- Failed live lookups **never** fall back to synthetic updates on import records.
- Demo/fixture rows are excluded from stats, attention, exports, and coverage.
- Structured export is coexistence-oriented — not a proven round-trip.
