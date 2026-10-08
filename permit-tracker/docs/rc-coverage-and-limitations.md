# RC coverage and limitations sheet

Honest bounds for the Phase 8 release candidate. Ready means named coordinator + LO can complete core tasks with trustworthy evidence — **not** nationwide coverage or financing approval.

## Covered (local foundations green; hosted journey owner-gated)

| Area | Coverage |
|---|---|
| Auth / roles | Owner + operator; fail-closed API; session revoke on logout |
| Workbook import | Sanitized fixture preview/commit; 3-way conflict; no silent wipe |
| Projects / permits | Assignment, milestones, dirty guards, Attention action queue |
| Fairfax official check | Issued-layer PLUS adapter when activated; real outcomes only |
| Opportunities | Fairfax residential **issued** discovery → private pipeline |
| Contacts | Fixture/sandbox review handoff at $0; manual contacts |
| Assistant | Deterministic NL→filters + evidence summaries when AI unavailable |
| Handoffs / export | Project + opportunity handoff preview; coexistence export; sensitive off by default |
| Jobs | Server-side sync jobs continue after browser close |
| Security | SSRF allow-list, upload rejection, log redaction, spend lock |

## Not covered / blocked

| Area | Status |
|---|---|
| Live Tracerfy production enrichment | **BLOCKED** (hard spend lock; rights/budget separate) |
| Live AI model provider | **Unset / force-off** by default — no fake LLM answers |
| Early-intent LO / borrower identification | **Out of scope** — Opportunities are post-permit issued activity |
| Loudoun / PWC / WV / City of Fairfax live sync | **Unsupported** (honest labels; proposals only) |
| Employer gospel on hosting | **Forbidden** for this RC |
| Nationwide discovery / scrapers | Deferred |
| Lending approval from readiness | Never — readiness ≠ underwriting |
| Invented demo-property shortcut on RC host | Off unless disposable `demo_mode` / flags |

## Geography

- **Operational market:** Fairfax County, VA (issued building records PLUS).
- **Pilot profile:** NoVA residential builder/developer relationship prospecting.
- Additional AHJs remain inventory/proposal only until verified adapters exist.

## Disabled feature flags (RC defaults)

```
PILOT_AUTH=1
AUTO_SEED=0
TRACERFY_PROVIDER_MODE=local_fixture   # or hosted_sandbox
tracerfy_hard_spend_lock=1
tracerfy_production_enabled=0
tracerfy_spend_limit_credits=0
PERMIT_AI_FORCE_OFF=1
ALLOW_DEMO_SHORTCUTS unset / 0
SOURCE_WORKBOOK_XLSX unset on host
```
