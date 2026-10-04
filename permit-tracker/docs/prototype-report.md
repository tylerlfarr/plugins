# Prototype Report — Workbook-Native Permit Ledger

**Status:** Local prototype (not production-ready).  
**PR:** https://github.com/tylerlfarr/plugins/pull/1 · branch `cursor/lot-readiness-6ca0` (into `cursor/permit-tracker-prototype-6ca0` / draft PR #1 chain)  
**Code:** `/workspace/permit-tracker`

---

## What changed (this milestone — property + contacts)

- Readiness integrity fixes: split water≠sewer; `na` unconfirmed until waiver; future dates ≠ completion; AHJ verification separate from workbook Ready; lot-group counts; no `updated_at` bump on recalc; no rebuildAttention official_change; activate requires real adapter.
- **Property identity** on detail + crosswalk preview/commit (stable community/lot match; ranges need review).
- **Contacts panel** + Find contacts; roles separate; Accept/Reject; sandbox Tracerfy adapter (production disabled).
- Filters: Missing property / Contacts available / Contact review needed.
- Export: Properties + Contacts sheets (sandbox demo contacts excluded).
- Tests: readiness + `property-contacts.test.js` (34 offline).

---

## What works

| Step | Result |
|------|--------|
| Source workbook import | 24 sections; secondary sheets + archives |
| Lot-readiness | Ready / Blocked / Needs verification under rules |
| Attention morning list | Starts, blockers, verification gaps, revision impact, changes |
| Fairfax live connector | Verified Building Records PLUS (activate via Sources) |
| PWC / Loudoun | Unsupported → unavailable (no synthetic fallback) |
| Connect a location | Verified first; never auto-connects |
| Structured Excel export | Includes readiness + notes/milestones |
| Tests | Offline 27/27 |

---

## How to run

```bash
cd permit-tracker && npm install && npm run seed && npm run build && npm start
npm test
npm run demo:lot-readiness
npm run demo:lot-readiness:source   # store workbook if present
npm run coverage:report
npm run demo:fairfax-attention
```

UI: Permits · Attention · Import · Sources · Connectors  
Try Live (when serving): http://localhost:4173/

---

## Next step

Operator answers on deck-path requirements, `na` semantics, revision owners, and Masterfile↔lot join — then tighten community-specific templates. PWC/Loudoun remain access-blocked for live IDs.
