# CAS / row_version bump policy (Phase 1)

Decision recorded October 7, 2026 for Permit Ledger integrity residuals.

## Permit `row_version` purpose

`row_version` protects **operator-editable permit form fields** (and milestone writes that go through the same PATCH CAS) from silent overwrite when two writers race. Clients must send `expected_row_version` on PATCH and conflict resolve.

## Paths that **claim** (CAS) or **bump**

| Path | Behavior |
|---|---|
| `PATCH /api/permits/:id` | **CAS** via `claimPermitWrite` |
| `POST /api/conflicts/:id/resolve` | **CAS** via `claimPermitWrite` |
| `POST /api/permits/bulk` | **Bump** per changed permit (no client expected version) |
| Workbook / gospel commit | **Bump** on updated permits |
| Milestone waiver / revoke | **Bump** |
| Official sync when **operator-visible permit fields** change | **Bump** (see below) |

## Sync policy — bump on visible field change; orthogonal check metadata

`POST /api/sync/:id` and `POST /api/sync` call `applyConnectorResult`.

**Bump** when the sync apply sets `changed = true` — i.e. any of:

- `source_native_status`, `official_status`, `source_url`
- Official milestone dates (`official_*` keys)
- Use classification fields applied from official type
- Baseline establishment that also wrote visible fields counted as `changed`

**Do not bump** (intentional orthogonality) when sync only updates check telemetry:

- `last_checked_at` / `last_successful_check_at` / `last_check_outcome` / `last_check_error`
- Attention upsert/resolve without permit field changes
- Eligibility `blocked` / `not_found` / `failed` / pure `no_change` outcomes

Rationale: check timestamps and Attention are not part of the editable permit draft. Bumping on every poll would force reconcile UI after harmless refresh checks. Bumping when official status/URL/use/milestones change ensures a stale open form cannot PATCH with an obsolete version after a live check mutated what the operator sees.

Acceptance: after a sync that changes `official_status` (or other bumped fields), a PATCH with the pre-sync `expected_row_version` returns **409** `stale_write` and persisted official fields remain the sync values.

## Property paths — intentional orthogonality

Property create, confirm-link, and offer-official-address mutate `properties` / `property_links` only. They **do not** claim or bump permit `row_version`.

Rationale: property identity is a separate confirmation workflow (`link_state`). Permit form CAS remains independent. Operators confirm property before contacts; that does not rewrite permit scalars. Tests assert confirm-link leaves `row_version` unchanged and a subsequent PATCH with the same expected version still succeeds for permit fields.

## Contacts / jobs / readiness rebuild / Attention ack

Orthogonal — no permit `row_version` interaction (unchanged from Phase 0 inventory).
