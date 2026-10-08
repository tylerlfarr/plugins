# Real-data evaluation checklist

Private operator trial prep for Permit Ledger. Uses existing crosswalk import + UI.  
**No purchases, production Tracerfy, or public deploy in this prep.**

Keep **permit coverage** and **contact coverage** separate.  
PWC / Loudoun remain **unsupported** unless demonstrated with live evidence.

---

## Before you start (operator inputs required)

| Input | Status | Notes |
|-------|--------|-------|
| 5–10 operator-selected lot/permit records | ☐ pending | Prefer mix: Fairfax-shaped IDs, ID-less, ready/blocked |
| Property addresses/parcels for those lots (or crosswalk CSV) | ☐ pending | Do not fabricate for ID-less rows |
| `TRACERFY_API_TOKEN` in server env (not settings DB) | ☐ pending | Only when production trial approved |
| Approved lookup spend cap (`tracerfy_spend_limit_credits`) | ☐ pending | e.g. 25–50 credits (~$0.50–$1.00) |
| Commercial-use / provider ToS confirmation | ☐ pending | `tracerfy_commercial_confirmed=1` |
| Legal OK to store/export provider contacts | ☐ pending | Rights still unresolved from public docs |

---

## A. Import & property match (5–10 records)

For each selected record:

| # | Lot / community | Crosswalk match | Property confirmed? | Match accuracy (exact / close / wrong / none) | Notes |
|---|-----------------|-----------------|---------------------|-----------------------------------------------|-------|
| 1 | | matched_stable_key / project_lot / ambiguous / range / missing | ☐ | | |
| 2 | | | ☐ | | |
| 3 | | | ☐ | | |
| 4 | | | ☐ | | |
| 5 | | | ☐ | | |
| 6 | | | ☐ | | |
| 7 | | | ☐ | | |
| 8 | | | ☐ | | |
| 9 | | | ☐ | | |
| 10 | | | ☐ | | |

**How:** Import tab → Download template → fill → Preview crosswalk → select rows → Commit selected → open lot → Confirm property.

---

## B. Permit-field coverage (separate from contacts)

| # | Primary official ID | Jurisdiction | Check source outcome | Official status captured? | Fields useful? (dates/address/status) | AHJ support |
|---|---------------------|--------------|----------------------|---------------------------|----------------------------------------|-------------|
| 1 | | | | ☐ | | Fairfax live / PWC unsupported / Loudoun unsupported / none |
| 2 | | | | ☐ | | |
| … | | | | ☐ | | |

Fairfax = limited GIS (issued-heavy). Missing pending/comments/holds/inspections is expected.

---

## C. Contact enrichment (only after property confirmed)

Provider mode for trial: ☐ local_fixture smoke · ☐ hosted_sandbox (invented props only) · ☐ production (capped)

| # | Searched address / APN | Mode | Role(s) returned | Source | Review (accept / reject / needs_review) | Restriction flags | Time to review (min) |
|---|------------------------|------|------------------|--------|------------------------------------------|-------------------|----------------------|
| 1 | | | | | | | |
| 2 | | | | | | | |
| … | | | | | | | |

Rules:
- Hosted sandbox: **invented `sandbox_demo` properties only** — operational imports are rejected before network.
- Production: confirmed property↔permit link required; spend cap enforced including uncertain holds.
- Manual contacts OK when provider skipped.

---

## D. Export correctness

| Check | Pass? |
|-------|-------|
| Structured export opens in Excel | ☐ |
| Contacts sheet has **confirmed** operational contacts only (default) | ☐ |
| No `sandbox_demo` / `local_fixture` / hosted_sandbox rows | ☐ |
| No rejected / outdated contacts | ☐ |
| Properties sheet links match confirmed lots | ☐ |
| Optional “Export + reviewed” includes intended candidates only | ☐ |

---

## E. Provider usage & accounting

| Metric | Value |
|--------|-------|
| Jobs queued / succeeded / failed / timed_out / abandoned_blocked | |
| Credits reserved (incl. reserved_uncertain) | |
| Credits actual | |
| Cap remaining | |
| Any abandon still blocking resubmit? | ☐ yes expected until `manual_allow_resubmit` + evidence |

---

## F. Builder core work (measure these — not just contact hits)

| Task | Old way (approx min / steps) | With Permit Ledger | Manual steps remaining | Notes |
|------|------------------------------|--------------------|------------------------|-------|
| Morning meeting prep (changed permits) | | | | Use Attention + last successful check |
| Find changed / newly issued permits | | | | Fairfax issued-heavy only |
| Identify blocked lots | | | | Lot readiness Ready/Blocked/Needs verification |
| Preserve internal milestones across import | | | | Conflicts tab |
| Assemble contacts for outreach | | | | Confirmed export only |
| Filter residential vs commercial (when labeled) | | | | Many types → Unknown; see use-classification note |

Trial sequence: **Import → missing property → confirm → retrieve supported official info → optional contacts → review → export → Attention.**

---

## G. Time saved (operator judgment)

| Task | Old way (approx min) | With Permit Ledger (approx min) | Notes |
|------|----------------------|----------------------------------|-------|
| Find owner/applicant for one lot | | | |
| Prep morning outreach list (N lots) | | | |

---

## H. Go / no-go for private trial expansion

| Gate | Met? |
|------|------|
| Property match accuracy acceptable on selected set | ☐ |
| Fairfax-limited coverage understood (not oversold) | ☐ |
| Contact roles labeled correctly; rejects preserved | ☐ |
| Export clean for outreach | ☐ |
| No unexpected provider charges | ☐ |
| PWC/Loudoun not claimed as live | ☐ |
| Invite-only access verified (if `PILOT_AUTH=1`) | ☐ |
| DB persists across restart on deploy volume | ☐ |

**Use classification:** Prefer official labels; unreliable → Unknown; manual override survives sync. Does **not** expand jurisdiction coverage.

**Shortest next step after gates:** operator supplies the 5–10 records + crosswalk addresses, hosting secrets (owner email/password), optional Tracerfy token + cap + commercial confirm, runs production mode on **confirmed** properties only with Instant Trace, reviews/accepts, exports confirmed package.
