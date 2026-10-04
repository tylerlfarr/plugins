# Prototype Report — Workbook-Native Permit Ledger

**Status:** Local prototype (not production-ready).  
**PR:** https://github.com/tylerlfarr/plugins/pull/1 · branch `cursor/lot-readiness-6ca0` (into `cursor/permit-tracker-prototype-6ca0` / draft PR #1 chain)  
**Code:** `/workspace/permit-tracker`

---

## What changed (this milestone — lot-readiness)

- Configurable workbook **lot-readiness** engine (`server/readiness.js`, ruleset `default_workbook_v1`).
- Per lot: **Ready / Blocked / Needs verification** from section-aware prerequisites (Release / Ordered / Received / utilities / StartSheet) + Target Start.
- Missing / blank section columns, `APPLY`/`rqst`, open revisions, and AHJ automation gaps never count as Ready.
- Attention extended: `approaching_start`, `readiness_blocked`, `needs_verification`, `revision_impact`, `official_change` (plus prior kinds).
- UI: readiness column, filters (state + approaching start), detail outstanding/gaps/satisfied.
- Export includes readiness summary + outstanding/gaps.
- Tests: `server/tests/readiness.test.js` · demo: `npm run demo:lot-readiness` (`--source` for store workbook).
- Requirements map updated vs current app.

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
