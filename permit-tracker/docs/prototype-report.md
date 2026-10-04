# Prototype Report — Workbook-Native Permit Ledger

**Status:** Local prototype (not production-ready).  
**PR:** https://github.com/tylerlfarr/plugins/pull/1 · branch `cursor/permit-tracker-prototype-6ca0`  
**Code:** `/workspace/permit-tracker`

---

## What changed (this milestone)

- Source registry + ArcGIS discovery + **Connect a location** UI (review before activate).
- PWC + Loudoun evidence: both blocked for active workbook IDs — `docs/pwc-loudoun-source-evidence.md`.
- Fairfax demo = **live lookup + controlled change-detection test**; demo/test origin excluded from coverage.
- Utility headers suggest geography only (`confirmed=0`).
- ID-less investigation: 271 shells, 0 accepted auto-matches.
- Coverage: 22 workbook IDs → 0 live / 22 unavailable (import-origin only).
- Tests: 19/19 offline; live scripts separate.

---

## What works

| Step | Result |
|------|--------|
| Source workbook import | 24 sections; secondary sheets + archives |
| Fairfax live connector | Verified Building Records PLUS (activate via Sources) |
| PWC GIS Use Permits | Verified for zoning SUP/NCU only — not workbook BLD/ZNA |
| Loudoun ResBuildingPermits | Inspected; issued/legacy IDs — needs_review, not active tracker |
| Connect a location | Verified first; candidates need review; never auto-connects |
| Attention / integrity | Unchanged from prior milestone |
| Tests | Offline 19/19 |

---

## How to run

```bash
cd permit-tracker && npm install && npm run seed && npm run build && npm start
npm test
npm run coverage:report
npm run demo:fairfax-attention
npm run investigate:idless
```

UI: Permits · Attention · Import · **Sources** · Connectors

---

## Next step

**Further source access** (not operator standup trial): authorized PWC/Loudoun machine-readable feeds or documented limitation; operator AHJ confirmation; addresses/parcels for ID-less rows.
