# Audit Trail Requirements

Implementation: `backend/audit.js` (`writeAuditLog`), the `audit_log` table
(`backend/db.js` migration 8).

## What gets an entry today

| `entity_type` | `action` | Written from | Notes |
|---|---|---|---|
| `transaction` | `void` | `POST /api/void` | Before/after snapshot of the transaction row |
| `transaction` | `refund` | `POST /api/refund` | Includes the refunded line items in `after_json` |
| `transaction` | `discount_approved` | `POST/PUT /api/new` | `user_id` is the **approving manager**, not the cashier who rang the sale |
| `cash_up` | `cash_up` | `POST /api/cash-up` | Expected/counted/variance in `after_json` |
| `controlled_substance_log` | `controlled_dispense` | `POST /api/prescriptions/:id/items/:itemId/dispense` | `user_id` is the dispensing user; the approving user's id is in `after_json` |
| `stock_movements` | `goods_receipt` | `POST /api/inventory/grn` | One entry per GRN call (covers every line, not one per line) |
| `stock_movements` | `manual_adjustment` | `POST /api/inventory/adjustment` | `after_json` includes the required `reason` |
| `stock_transfers` | `transfer_out` / `transfer_in` | `POST /api/inventory/transfer`, `POST /api/inventory/transfer/:id/receive` | One entry per side of the transfer |
| `stock_takes` | `stock_take_completed` | `POST /api/inventory/stock-take/:id/complete` | Full variance report in `after_json` |

Still to wire up: price overrides (`perm_price_override` exists on `users` but nothing checks it
yet — no code path currently lets a user override a price at all, so there's nothing to gate).

## Required fields (enforced by `writeAuditLog`'s shape, not just convention)

- `entity_type` + `entity_id` — what was acted on.
- `action` — what happened.
- `user_id` — who did it (`0` only for genuinely system-initiated actions; every route above
  passes `req.user.id`).
- `before_json` / `after_json` — state snapshots, JSON-stringified (nullable — a pure "this was
  created" event like `cash_up` has no meaningful "before").
- `created_at` — server-generated ISO timestamp, never client-supplied.

## Immutability

No route updates or deletes `audit_log` rows — enforced by convention (no such route exists),
same as `controlled_substance_log`. The sync engine treats both as append-only/insert-only for
conflict resolution purposes (`sync-engine/conflict.js`'s `APPEND_ONLY_ENTITIES`), so audit
entries can't be silently overwritten by a stale sync pull either.

## Retention

Not yet enforced anywhere (no purge job, no retention column) — a real deployment needs a
retention policy here before go-live; see `docs/compliance/data-protection.md`.
