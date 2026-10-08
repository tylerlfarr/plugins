# Pilot start guide (≈2 minutes)

Disposable / authorized pilot data only. Do **not** upload the employer gospel workbook to hosting or providers.

## Before you begin

Owner has deployed the release-candidate tip with:

- `PILOT_AUTH=1`, `AUTO_SEED=0`, durable `PERMIT_DB_PATH`
- Tracerfy: `local_fixture` or `hosted_sandbox` only; hard spend lock on; production off
- `PERMIT_AI_FORCE_OFF=1` (or no AI key) unless a model is separately approved
- No `SOURCE_WORKBOOK_XLSX` / gospel path on the host

Full env table: project store `docs/phase-8-release-candidate-checklist.md`, plus Hostinger fields in [`hostinger.md`](./hostinger.md).

## Named roles

| Role | Who | Can |
|---|---|---|
| **Owner** | Deployer / admin | Sign in, create trial operator, activate Fairfax PLUS after review, provider mode, settings |
| **Operator** (coordinator / LO) | Pilot users | Import sanitized data, edit, check, Opportunities, fixture contact review, export — **not** activate sources or create users |

## Two-minute path

1. **Sign in** — Owner creates the operator (Sources → Create trial user), then each person signs in in their own browser/profile.
2. **Import** — Operator: Import → upload `server/fixtures/sanitized-source-workbook.xlsx` → preview → commit. (Never gospel on host.)
3. **Coordinate** — Open a permit → set Assigned to / next action → Save. Re-import same file if testing conflicts; resolve keep_app or take_incoming — no silent overwrite.
4. **Check** — Run permit check on a Fairfax-shaped ID. Expect a real outcome (`updated` / `no_change` / `not_found` / `unavailable` / `failed`).
5. **Opportunities** — Coverage notice → Fairfax residential **issued** search → save → disposition. This is post-permit activity, **not** early-intent borrower discovery.
6. **Contacts** — Fixture/sandbox contact review only ($0). Live enriched-lead stays **BLOCKED**.
7. **Export** — Structured export or handoff preview; sensitive columns off unless explicitly enabled.
8. **Sign out** — Sessions revoke; do not share cookies across roles.

## Local disposable rehearsal

```bash
cd permit-tracker
npm ci && npm run build
npm run test:phase8-rc          # owner + operator HTTP journey
# or interactive:
PERMIT_DB_PATH=./data/rc.sqlite AUTO_SEED=0 PILOT_AUTH=1 COOKIE_SECURE=0 \
  OWNER_EMAIL=owner@example.com OWNER_PASSWORD='change-me-now-10+' \
  TRACERFY_PROVIDER_MODE=local_fixture PERMIT_AI_FORCE_OFF=1 \
  LISTEN_HOST=127.0.0.1 PORT=4173 npm start
```

## Disabled on this RC (intentional)

- Live Tracerfy production / paid enrichment
- Live AI model answers (deterministic assistant only when AI unavailable)
- Opportunities as early-intent / borrower claims
- Invented demo-property shortcut (off unless owner enables `demo_mode` or disposable flags)
- Gospel upload to hosting

See also: [rc-coverage-and-limitations.md](./rc-coverage-and-limitations.md), [privacy-and-contact-use.md](./privacy-and-contact-use.md), [report-a-problem-and-rollback.md](./report-a-problem-and-rollback.md).
