# Prototype Report — Workbook-Native Permit Ledger

**Status:** Local prototype (not production-ready).  
**PR:** https://github.com/tylerlfarr/plugins/pull/1 · branch `cursor/permit-tracker-prototype-6ca0`  
**Code:** `/workspace/permit-tracker`

---

## What changed (this milestone)

- Full 8-tab workbook map; archived sheets stored (not wiped).
- Import profile separated from reusable core (`importProfile.js`).
- Data integrity: no live→synthetic fallback; fixtures/demo isolated (`record_origin`); 3-way import conflicts; stable lot identity; multi-record per ID; confirmed jurisdiction wins.
- Coverage report excludes fixtures/probes (`npm run coverage:report`).
- Attention: separate clocks (progress vs check vs matching vs overdue); dedupe + resolve; schedule preview (not sent).
- Offline sanitized fixtures + tests; essential docs in repo; UI says “source workbook” / “import profile”.

---

## What works

| Step | Result |
|------|--------|
| Source workbook import | 24 Permit Tracker sections; Revisions / Masterfile / MST active; 4 sheets archived |
| Re-import | Updates without wiping app-edited milestones; conflicts queued |
| Fairfax live | Confirmed Fairfax + strong prefixes only; BLDC ambiguous without mapping → unavailable |
| Unsupported AHJs | Loudoun / PWC / etc. → `unavailable` (no synthetic on import records) |
| Attention | status_change / no_progress / source_missing / check_failed / unresolved_matching / overdue_action |
| Structured export | Import-origin only; multi-sheet coexistence workbook |
| Tests | Offline integrity suite + optional live workbook tests |

See `docs/coverage-matrix.md` after `npm run coverage:report` for live numbers.

---

## How to run / review

```bash
cd permit-tracker
npm install
npm run seed
npm run dev
npm test
npm run coverage:report   # needs network + source workbook
```

UI: Permits · Attention (digest preview + conflicts) · Import · Connectors  
Import → **Import store source workbook** · **Structured export** · **Run Fairfax checks**

---

## Simulated / incomplete

| Item | Mode |
|------|------|
| Loudoun / PWC / City of Fairfax / Houston / Harris | **Unsupported** → `unavailable` |
| Fairfax pending / comments / holds / inspections | **Unavailable** on Building Records PLUS |
| Address/parcel match for ID-less rows | Not implemented |
| MST auto-link to lots | Reference only |
| Email/Slack digest | Preview only — not sent |
| Auth, multi-tenant, billing | Pre-hosting requirements (pilot pack) |

---

## Remaining work before paid pilot

1. Operator validation of per-section milestone synonyms.
2. Loudoun + PWC: ToS-safe machine access or documented limitation.
3. AuthN/Z, tenant isolation, backups, hosting.
4. Address/parcel review queue for ID-less rows.
5. Optional lot-range explosion (explicit opt-in).

## Next concrete milestone toward customer pilot

Prove weekly saved-work metric on one community: Fairfax morning checks + conflict-aware re-import + Attention digest used in a real standup for 2 weeks; document which manual portal checks were eliminated (hypothesis → evidence).
