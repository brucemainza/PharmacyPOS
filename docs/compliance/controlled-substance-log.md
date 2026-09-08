# Controlled Substance Log

Implementation: `controlled_substance_log` table (`backend/db.js` migration 6),
`backend/routes/prescriptions.js` (write path), `backend/routes/analytics.js`
(`GET /api/analytics/controlled-register`, read/reporting path).

## What counts as a controlled item

A product is a controlled substance when `products.controlled_substance = 1`. This flag is set
directly on the product record; there is currently no catalog UI to toggle it (see
`docs/architecture/system-architecture.md`'s data model notes) — automated tests set it the same way, directly
against the database. Every dispense request checks
the *effective* product being handed over (the original prescribed product, or its generic
substitution if one was made), not just the originally prescribed product, so a substitution
can't be used to dispense a controlled item without triggering this workflow.

## Required approval step

See `docs/architecture/functionality.md`'s "Controlled-Substance Dispensing" section (diagram:
`docs/use-cases/uc-controlled-substance-dispensing.puml`) for the full flow. In summary: the
dispensing user alone cannot complete the transaction — a second, distinct user holding
`perm_controlled_approve` (verified live against the `users` table, not a JWT claim) must supply
their own credentials via `POST /api/users/authorize` before the dispense is allowed to proceed.

## What's captured per entry

Each `controlled_substance_log` row records:

| Field | Meaning |
|---|---|
| `prescription_item_id` | Which prescription line was dispensed |
| `transaction_id` | The linked sale, if any (nullable — dispensing doesn't strictly require a sale in the current flow) |
| `product_id` | The product actually dispensed (post-substitution if applicable) |
| `qty` | Quantity dispensed in this call |
| `dispensing_user_id` | Who handed over the item |
| `approving_user_id` | Who authorized it (always a different, permission-holding user) |
| `patient_id` | The patient the prescription belongs to |
| `created_at` | Server-generated timestamp |

Every entry also produces a matching `audit_log` row (`entity_type: 'controlled_substance_log'`,
`action: 'controlled_dispense'`) — see `docs/compliance/audit-trail-requirements.md`.

## Reporting

The Analytics dashboard's **Controlled-items register** tab
(`GET /api/analytics/controlled-register?start=&end=`) lists every entry in a date range with
product, quantity, patient, dispensing user, and approving user names resolved — this is the
report a pharmacy would print/export for a regulatory inspection. It reads local data only, so
it's available offline; there is no automated export-to-PDF/CSV yet (a reasonable Phase 4+
follow-up if a specific regulator's submission format is required).

## Immutability

No route updates or deletes `controlled_substance_log` rows. `sync-engine/conflict.js` treats
it as append-only (`APPEND_ONLY_ENTITIES`) — a sync conflict on this entity type is a transport
bug, not something to be resolved by picking a "winning" side, since every row is inserted once
and never touched again.

## Retention and regulatory reporting

Not yet enforced in code — there is no purge job or minimum-retention guarantee beyond "the row
is never deleted by application code." Most controlled-substance regulatory regimes (e.g. DEA-
style registers in the US, or the equivalent under Zambian pharmaceutical/narcotics regulations)
require these records be retained for a specific minimum period (commonly several years) and be
producible on demand — this needs to be confirmed against the specific jurisdiction's requirement
before go-live and, if a fixed retention period longer than "forever" is *not* required,
explicitly documented as "retain indefinitely" rather than left ambiguous. See
`docs/compliance/data-protection.md` for the broader retention-policy gap this sits inside.
