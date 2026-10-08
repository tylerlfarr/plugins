# Privacy and contact-use summary (RC)

## Data classes in the pilot

| Allowed in pilot DB | Keep out of V1 hosting / providers |
|---|---|
| Community/lot schedules, internal milestones | Employer gospel workbook upload to hosting |
| Public AHJ IDs / issued status from activated sources | Real AHJ portal credentials |
| Work emails/names already entered for coordination | Payment data, SSN, relatives, borrower PII |
| Fixture/sandbox contact candidates labeled as non-operational | Live enriched-lead purchase without separate approval |

## Contact rules

1. **Sought role required** — owner ≠ applicant ≠ contractor ≠ developer. Borrower / financing-seeker roles are forbidden.
2. **Fixture/sandbox only on this RC** — cost preview $0; live enriched-lead pilot status is **BLOCKED**.
3. **No outreach automation** — no dialer, SMS, or email sender in this candidate.
4. **Suppressions survive re-import** — rejected/DNC contacts are not silently reattached.
5. **Exports exclude** sandbox_demo / local_fixture contact rows from operational sheets.
6. **Opportunities ≠ marketing leads from Projects** — linking does not copy permit facts into a shared prospecting database; private workbook records stay private.

## Logging and AI

- Assistant audit paths redact credentials, tokens, emails, and phone numbers (`sanitizeForAudit`).
- With AI unavailable, the app uses deterministic filters/summaries only — it does not invent IDs, dates, or contacts.
- Do not paste full workbook dumps into third-party AI tools without a written agreement.

## Sessions

- Auth fail-closed when `PILOT_AUTH=1` or `NODE_ENV=production`.
- Logout revokes the server session; do not share one browser profile across owner and operator.
