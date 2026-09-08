# Functionality

This is one of two prose documents under `docs/` — the other is
`docs/architecture/system-architecture.md` (system flow and architecture). It describes what the
system does, use case by use case. Every sequence diagram is a standalone PlantUML file under
`docs/use-cases/*.puml`, not embedded here; open it in a PlantUML-capable viewer/IDE plugin or a
local PlantUML server.

## Sale Checkout

Diagram: `docs/use-cases/uc-sale-checkout.puml`. Implementation: `frontend/pages/TillView.tsx`,
`backend/routes/transactions.js`. **Actor:** Cashier. **Preconditions:** Register session open;
till assigned.

1. Barcode scan / search adds line items; quantities editable in the cart.
2. Cashier optionally enters a flat discount amount and/or picks a customer.
3. Tax/VAT applied per `settings.percentage` when `settings.charge_tax` is on.
4. Cashier clicks **Pay (F2)**, picks a method (Cash / Card / Mobile Money), and completes the
   sale.
5. Receipt prints; stock decrements (`decrementInventory`).

**Discount approval (tiered: cashier vs manager)**

- `settings.discount_approval_threshold` (default 10%) caps what a cashier can apply
  unsupervised.
- Above that percentage of subtotal, clicking **Pay** opens a manager-approval prompt instead of
  charging — a manager (or anyone with `perm_discount_approve`) enters *their own* credentials,
  verified via `POST /api/users/authorize` without switching the till's logged-in session.
- The approval is re-armed every time the discount amount changes and is enforced server-side in
  `POST/PUT /api/new` regardless of what the client sends — a modified request without a
  validly-permissioned `discount_approved_by` is rejected (403).
- Approved discounts get their own `audit_log` entry (`action: 'discount_approved'`).

**Split payments (cash + Lenco)**

The payment modal's **Split payment** checkbox switches from a single method to a tender builder:
add any number of `{method, amount}` legs (cash settles instantly; card/mobile-money legs go
through the same `/api/payments/initiate` → poll flow as a single-method payment) until the legs
cover the total. The sale is only created once **every** leg has actually settled successfully,
with `payment_type: 5` and all leg references linked via `POST /api/payments/:reference/link`.

If a later leg fails after an earlier one already succeeded, the UI surfaces exactly how much was
already collected and on what method, and tells the cashier to involve a manager rather than
retry blindly — there's no automatic rollback (Lenco has no refund endpoint).

Known simplification: card/mobile-money detail fields (card number, phone number, etc.) are
shared across all legs of a given method in one split — splitting the *same* method across two
different cards or two different phone numbers in one sale isn't supported.

**Exceptions**

- Offline: cash-only — Card/Mobile Money grey out with an "(offline)" label.
- Held sale resumed with a large discount: the discount-approval check still runs on
  resume/complete.

## Dispensing a Prescription

Diagram: `docs/use-cases/uc-dispensing-prescription.puml`. Implementation:
`backend/routes/prescriptions.js`, `frontend/pages/PrescriptionsView.tsx`. **Actor:**
Pharmacist / Cashier (dispensing requires `perm_transactions`; a generic substitution additionally
requires the acting user to hold the `pharmacist`, `manager`, `admin`, or `tech` role).
**Preconditions:** Patient record exists (`customers` table doubles as the patient registry). A
prescription has been captured with one or more line items, each naming a product and a
prescribed quantity.

1. A prescription is created via `POST /prescriptions/` with `patient_id`, optional prescriber
   name/registration number, notes, and `items: [{ product_id, prescribed_qty }]`. Status starts
   `open`.
2. To dispense a line, the pharmacist/cashier opens the prescription and enters a quantity (up to
   the line's `remaining_qty`, i.e. `prescribed_qty - dispensed_qty`).
3. The server appends a `stock_movements` row (`movement_type: 'sale'` unless the product is a
   controlled substance, in which case `'controlled_dispense'`) and decrements
   `products.quantity` — dispensing never overwrites an absolute quantity, only appends a
   movement.
4. `prescription_items.dispensed_qty` accumulates, and `partial_fill_state` becomes `partial`
   (more remains) or `complete` (fully dispensed). Once every line is fully dispensed,
   `prescriptions.status` flips to `completed`; otherwise it's `partially_filled`.
5. `pharmacist_user_id` and `approved_at` are stamped on the line item with the acting user's id
   and the current time, regardless of role.

**Partial fills**: dispensable across multiple visits; asking for more than `remaining_qty` in one
call is rejected (400) server-side, not just disabled in the UI.

**Generic substitution**: passing `substituted_product_id` swaps which product's stock is
decremented, but requires the acting user's `role` to be `pharmacist`, `manager`, `admin`, or
`tech` (checked server-side against the `users` table, not the JWT claim) — a plain cashier gets
403. Recorded on the line item so the dispensing record shows exactly what was handed to the
patient versus what was prescribed.

**Exceptions**

- Over-dispense attempt: rejected (400).
- Unknown prescription/item: 404.
- Controlled substance: routed through the second-approver flow below — same endpoint, triggered
  automatically by the effective product's `controlled_substance` flag.
- Offline: works with zero connectivity, queues to `sync_outbox`.

## Controlled-Substance Dispensing

Diagram: `docs/use-cases/uc-controlled-substance-dispensing.puml`. Implementation:
`backend/routes/prescriptions.js` (controlled-substance branch), `backend/routes/users.js`
(`POST /api/users/authorize`), `frontend/pages/PrescriptionsView.tsx` (approval modal).
**Actor:** Dispensing user (any `perm_transactions` holder) plus a second, distinct authorized
approver holding `perm_controlled_approve` (or the id-1 super-admin). **Preconditions:** the
effective product being dispensed has `controlled_substance = 1`.

1. The dispensing user's attempt is rejected (403) unless it also carries an `approving_user_id`.
2. The UI's controlled-substance modal prompts for a *second* user's credentials — reusing the
   same pattern as manager discount approval: `POST /api/users/authorize` verifies that user's
   password and that they hold `perm_controlled_approve`, **without** switching the dispensing
   user's own session.
3. The dispense call is retried with the approver's id. The server independently re-verifies the
   approver holds `perm_controlled_approve` (never trusts the client's word for it) — a request
   forged with an arbitrary `approving_user_id` is rejected (403).
4. On success: the stock movement is recorded as `movement_type: 'controlled_dispense'`; a row is
   inserted into `controlled_substance_log` (`prescription_item_id`, `transaction_id`,
   `product_id`, `qty`, `dispensing_user_id`, `approving_user_id`, `patient_id`, timestamp); an
   immutable `audit_log` entry is written; both queue to `sync_outbox` as append-only.

**Reporting**: the full register (product, quantity, patient, dispensing user, approving user,
timestamp) is in the Analytics dashboard's Controlled-items register tab
(`GET /api/analytics/controlled-register`).

**Exceptions**

- No approver supplied: 403.
- Approver lacks permission: 403 — checked against the live `users` table at dispense time.
- Same user as both dispenser and approver: not blocked at the database level (id-1 super-admin is
  deliberately exempt), but the UI always asks for a *different* user's credentials.
- Offline: works fully offline — approver credentials checked against the local user table.

## End-of-Day Cash-Up / Z-Report

Diagram: `docs/use-cases/uc-end-of-day-cashup.puml`. Implementation:
`backend/routes/transactions.js` (`GET/POST /api/cash-up`, `GET /api/cash-up/history`),
`frontend/pages/PosPage.tsx`'s `CashUpView`. **Actor:** Cashier / Manager (`perm_transactions`).

1. Cashier opens the **Cash-up** tab, picks a till and business date.
2. `GET /api/cash-up?till=&date=` aggregates that till's day: sales total, a breakdown by payment
   type, refunds total, transaction count, and **expected cash** — `SUM(paid − change)` over that
   till's paid cash sales, minus refunds for the day.
3. Cashier counts the physical drawer and enters **Counted cash**; the UI shows the variance live
   before submitting.
4. `POST /api/cash-up` **recomputes the expected total server-side** (never trusts a client-sent
   figure) and persists a `cash_ups` row plus an `audit_log` entry.
5. Recent cash-ups for the till are listed below, most recent first.

Known simplification: expected cash assumes any refund on that till was paid out of the cash
drawer — a refund settled back to card/mobile-money instead isn't distinguished yet.

**Exceptions**

- Non-zero variance: recorded, not blocked.
- Multiple cash-ups same day (shift handover): allowed, each submission is its own row.

## Goods Receiving (GRN)

Diagram: `docs/use-cases/uc-goods-receiving.puml`. Implementation:
`backend/routes/inventory.js` (`POST /api/inventory/grn`, `GET /api/inventory/batches`),
`frontend/pages/InventoryView.tsx`. **Actor:** Store Manager / Stock Controller
(`perm_products`). **Preconditions:** product(s) already exist in the catalog; a supplier is
optional.

1. The user optionally selects (or quick-creates) a supplier, then enters line items: product, an
   optional batch/lot number, an optional expiry date, a received quantity, and an optional unit
   cost.
2. `POST /grn` runs the whole receipt as one transaction:
   - **Every** line creates a `product_batches` row — even without a batch number — because unit
     cost is tracked per receipt regardless of lot/expiry-tracking.
   - If a batch number *was* given, `products.batch_tracked` is set; if not, the batch row still
     exists for costing but is filtered out of the batches/expiry listing.
   - A `stock_movements` row is appended (`movement_type: 'goods_receipt'`, positive `qty_delta`),
     and `products.quantity` is incremented — never overwritten.
   - An `audit_log` entry and a `sync_outbox` entry are written for the whole receipt.
3. The Inventory UI shows the 20 most recent receipts as immediate confirmation.

**Exceptions**

- No line items: rejected (400).
- Unknown product id in a line: that line is silently skipped rather than failing the whole GRN.
- Offline: fully offline, queues to `sync_outbox`.

## Customer / Patient Management

Diagram: `docs/use-cases/uc-customer-patient-management.puml`. Implementation:
`backend/routes/customers.js`, `frontend/pages/CustomersView.tsx`. **Actor:** Any authenticated
user (no dedicated permission flag today — every till user can view and edit records).

1. A customer/patient record (`customers` table doubles as both) captures name, phone, email,
   address, date of birth, allergies, an insurance reference, an optional linked corporate
   account, and an accumulating `loyalty_points` balance.
2. Records are created/edited via `POST`/`PUT /api/customers/customer`, deleted via
   `DELETE /api/customers/customer/:id`.

**Purchase history**: `GET /api/customers/customer/:id/history` returns paid transactions
(`status = 1`), newest first, each showing `loyalty_points_earned` for that visit — read-only
(edits go through void/refund).

**Loyalty points**: on every sale that completes as paid, if attached to a real customer (not
walk-in), the server accrues `floor(total * settings.loyalty_earn_rate)` points automatically.
Default rate is 0.1 (1 point per 10 currency units). **Known limitation**: points can only be
*earned*, not yet *redeemed* at checkout — the balance is visible on the customer's profile and
can be redeemed manually (a discretionary discount through the existing approval flow) until a
dedicated redemption UI lands.

**Corporate / insurance pricing**: `corporate_accounts` records a name and a contracted
`discount_percent`. **Known limitation, by design**: not auto-applied to a sale — the cashier
sees the contracted rate and enters it as the sale's normal discount, still subject to the tiered
discount-approval check, so there's no new, un-audited path for a discount to reach a sale.
`insurance_ref` is record-keeping only — no claims/billing integration exists to integrate
against.

**Exceptions**

- Deleting a customer with purchase history: not blocked — past transactions aren't anonymized.
- Offline: fully offline.

## Offline → Online Sync

Diagram: `docs/use-cases/uc-offline-to-online-sync.puml`. Implementation: `sync-engine/`,
`cloud-sync-api/`. **Actor:** System (automatic — no user action required). **Preconditions:** the
local app has accumulated pending writes in `sync_outbox`.

1. Every domain write that should survive a crash or reach other branches is enqueued into
   `sync_outbox` in the *same* database transaction as the write itself.
2. `ConnectivityMonitor` pings `GET /health` on a timer (default 15s); nothing in the till,
   dispensing, or inventory flows blocks on this ping.
3. The moment a heartbeat succeeds, the engine runs a full push-then-pull pass (see
   `docs/architecture/system-architecture.md`'s "Data flow: offline sync" for the conflict rules).
4. The renderer reads live sync status via `window.pos.getSyncStatus()`.

**Exceptions**

- Extended offline period: the outbox simply grows; every offline-capable feature keeps working
  without degradation.
- Card/mobile-money payments while offline: explicitly *not* queued as if they'd succeeded — only
  cash sales are accepted offline.
- Crash mid-sync: idempotency keys make every retry safe.

## Lenco Card Payment

Diagram: `docs/use-cases/uc-payment-lenco-card.puml`. **Actor:** Cashier, initiating on behalf of
the customer at checkout. **Preconditions:** cart has items; `GET /api/payments/methods` reports
`card: true`; cashier has the customer's card details and billing address.

1. Cashier selects **Card**. If unreachable, the option is disabled with an "(offline)" label.
2. Cashier enters card number, expiry, CVV, and billing address; clicks **Pay**.
3. Client calls `POST /api/payments/initiate` (`method: 'card'`) — server-side,
   `LencoGateway._initiateCard` JWE-encrypts the payload and calls Lenco's `POST /collections/card`.
4. Response is one of: `successful` (sale created immediately, receipt printed); `action_required`
   (3DS — this till can't complete a redirect flow, cashier told to use a different card or cash);
   `pending` (client polls `GET /api/payments/:reference/status` every 2.5s for up to 60s);
   `failed` (cashier told the payment was declined; cart untouched).
5. Once `successful`, the sale is created and `POST /api/payments/:reference/link` backs the
   payment's `transaction_id`.

**Exceptions**

- Timeout: after 60s of polling, a timeout message warns against retrying blindly.
- Offline mid-flow: if connectivity drops before Pay, the next methods poll disables Card on modal
  reopen; if it drops during initiate, the request fails and the cart is untouched.
- Refund: not automatable (no refund endpoint in Lenco's v2.0 API).

## Lenco Mobile Money Payment

Diagram: `docs/use-cases/uc-payment-lenco-momo.puml`. **Actor:** Cashier, initiating on behalf of
the customer at checkout. **Preconditions:** cart has items; `GET /api/payments/methods` reports
`mobile_money: true`; cashier has the customer's mobile money number and network.

1. Cashier selects **Mobile Money**, enters the customer's phone number, network (Airtel / MTN /
   TNM / Zamtel) and country; clicks **Pay**.
2. Client calls `POST /api/payments/initiate` (`method: 'mobile_money'`) →
   `LencoGateway._initiateMobileMoney` → Lenco's `POST /collections/mobile-money`.
3. Response starts as `pending` (Lenco's pay-offline — the customer's phone is being prompted via
   USSD). UI polls `GET /api/payments/:reference/status` every 2.5s for up to 60s.
4. `successful` → sale created, payment linked, receipt printed. `failed` → cashier told the
   payment failed (with Lenco's `reasonForFailure` when available).

**Exceptions**

- Customer doesn't respond: after 60s, a timeout message shows; the underlying collection may
  still resolve later via a delayed webhook.
- Offline mid-flow: same as the card flow.
- Refund: not automatable.

## Refund / Void

Diagram: `docs/use-cases/uc-refund-void.puml`. Implementation: `backend/routes/transactions.js`
(`POST /api/void`, `POST /api/refund`), `frontend/components/TransactionsModal.tsx`. **Actor:**
Cashier (requires `perm_refund_void`; the id-1 super-admin always qualifies). **Preconditions:**
sale exists and is Paid (status 1).

**Void**: from Sales history, an authorized user clicks **Void** and enters a reason. Server
restocks every line item (`stock_movements`, `movement_type: 'refund'`, `ref_type: 'void'`), bumps
`products.quantity` back up, sets status → `2` (Voided), stores `void_refund_reason`, writes an
`audit_log` entry, queues `sync_outbox`.

**Refund**: same entry point, **Refund** instead — same restock + audit-log mechanics. Status →
`3` (Refunded). Accepts an optional `items: [{id, quantity}]` for a partial return — restock is
scoped to just those lines, though (documented limitation) the transaction's own status still
flips fully to `3` regardless of whether the refund was partial or full.

**Exceptions**

- Already void/refunded: a second attempt is rejected (400) server-side.
- Unlimited-stock items (`products.stock = 0`): never restocked, matching how they were never
  decremented on sale.
- Lenco-paid sale refund: restocking/audit trail work the same, but the **payment itself isn't
  refunded through Lenco** — needs a manual, off-platform reversal.

## Stock Take / Cycle Count

Diagram: `docs/use-cases/uc-stock-take.puml`. Implementation: `backend/routes/inventory.js`
(`POST /api/inventory/stock-take`, `PUT .../item/:itemId`, `POST .../complete`),
`frontend/pages/InventoryView.tsx`. **Actor:** Store Manager / Stock Controller
(`perm_products`).

1. The user starts a stock take for a business date. `POST /stock-take` snapshots
   `products.quantity` for every sellable product into `stock_take_items.expected_qty` and creates
   the parent row (`status: 'open'`).
2. Staff physically count stock and enter `counted_qty` per line; `variance`
   (`counted - expected`) is computed and stored as each line is saved.
3. On `POST /stock-take/:id/complete`: for every line with a recorded count, if `variance != 0` a
   `stock_movements` row is appended (`movement_type: 'adjustment'`, `ref_type: 'stock_take'`) and
   `products.quantity` is *set* to the counted value — the only place in the inventory model
   where a quantity is corrected to an absolute counted value rather than a relative delta. Lines
   never counted are left alone. Status flips to `completed`; a variance report is returned and an
   `audit_log` entry captures it in full.

**Exceptions**

- Completing twice: rejected (400).
- Invalid counted quantity (negative or non-numeric): rejected (400).
- Offline: fully offline, queues to `sync_outbox`.

## Branch-to-Branch Stock Transfer

Diagram: `docs/use-cases/uc-stock-transfer.puml`. Implementation: `backend/routes/inventory.js`
(`POST /api/inventory/transfer`, `POST .../transfer/:id/receive`),
`frontend/pages/InventoryView.tsx`. **Actor:** Store Manager (`perm_products`). **Preconditions:**
a `branches` registry exists locally (seeded with one `is_local = 1` row).

> **Scope note:** each Electron install is one branch's own local database — there is no single
> database spanning multiple branches. This use case covers the *local bookkeeping* half of a
> transfer. Automatic cross-branch routing depends on the cloud sync API's multi-branch data
> model (Phase 5, not yet built) — until then, the receiving branch's staff record the receipt
> themselves once the physical goods arrive.

**Sending branch**: user selects a destination branch and line items. `POST /transfer` creates a
`stock_transfers` row (`status: 'pending'`) with its `stock_transfer_items`, appends
`stock_movements` (`movement_type: 'transfer_out'`, negative `qty_delta`), decrements
`products.quantity` immediately — stock leaves this branch's ledger the moment the transfer is
recorded, since the goods have physically left.

**Receiving branch**: once goods arrive, staff call `POST /transfer/:id/receive`. Stock is
credited back (`movement_type: 'transfer_in'`, positive `qty_delta`), transfer status flips to
`received` with `received_by`/`received_at` stamped.

**Exceptions**

- No destination branch or no line items: rejected (400).
- Double receipt: rejected (400).
- Offline: both sending and receiving work fully offline, queuing to `sync_outbox`.

## Analytics Dashboard & Reports

Diagram: `docs/use-cases/uc-analytics-reporting.puml`. Implementation:
`backend/routes/analytics.js`, `frontend/pages/AnalyticsView.tsx`. **Actor:** Manager /
back-office user (`perm_transactions`). **Preconditions:** none — every report reads from the
local database directly.

1. **Daily sales** — paid transactions grouped by calendar day: count, total, total discount.
   Held/voided/refunded sales excluded.
2. **Profit & margin** — per product, quantity sold, revenue billed, and an estimated cost of
   goods sold using a **weighted-average landed cost** derived from every GRN. An approximation,
   not FIFO/LIFO-exact. Products never costed via GRN show `has_cost_data: false` rather than a
   misleading zero-cost 100% margin.
3. **Cashier performance** — per user, transaction count, sales total, average sale value, and a
   separate count of void/refund actions in the same window (shown alongside, not netted against,
   sales figures).
4. **Fast / slow movers** — fast movers ranked by quantity sold; slow movers lists products with
   **zero** sales in the window, ranked by current on-hand quantity.
5. **Stock valuation** — current `products.quantity` valued at retail price and at the same
   weighted-average cost, with grand totals.
6. **Near-expiry alerts** — reuses `GET /api/inventory/batches?nearExpiryDays=` directly, so
   there's exactly one implementation of "what's expiring soon."
7. **Controlled-items register** — see the Controlled-Substance Dispensing section above.

**Exceptions**

- No data in range: every tab renders an explicit empty state, never confused with "still
  loading."
- Multi-branch roll-ups: out of scope for this local dashboard by design — planned cloud-side once
  Phase 5's multi-branch data model exists.
- Offline: every report works fully offline.

## Role-based view access

Diagram: `docs/architecture/role-view-access.puml`. Which of the app's navigation views
(`frontend/layout/AppShell.tsx`'s `NavView`) each `users.role` value can reach. Three roles are
**hard-gated** (fixed regardless of the `perm_*` columns); the other two are **permission-driven**.

| Role | Till | Catalog | Sales | Cash-up | Prescriptions | Inventory | Analytics | Customers | Team | Settings |
|---|---|---|---|---|---|---|---|---|---|---|
| `cashier` (Till operator) | ✅ | — | — | — | — | — | — | — | — | — |
| `admin` (Administrator) | — | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `tech` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `pharmacist` / `manager` | ✅ | per `perm_*` | per `perm_*` | per `perm_*` | per `perm_*` | per `perm_*` | per `perm_*` | ✅ | per `perm_*` | per `perm_*` |

- **Till operator (`cashier`)** is restricted to the Till only, no exceptions — enforced in the
  nav itself, not by leaving every `perm_*` flag unset, so it can't be accidentally widened by
  ticking a permission checkbox.
- **Administrator (`admin`)** sees every other view and *not* the Till — an admin manages the
  pharmacy (catalog, staff, settings, reporting) but doesn't operate a register.
- **Tech** sees everything, Till included, for support/troubleshooting.
- **Pharmacist / Manager** are unchanged: the Till is always visible, and every other view's
  visibility still follows the `perm_*` checkboxes set on that user.

Enforced in two places that must agree:

- **Frontend nav** — `frontend/layout/AppShell.tsx` hard-overrides the `show` flag per item when
  `user.role` is `cashier`, `admin`, or `tech`; other roles fall through to the existing
  `hasPerm('perm_*')` checks.
- **Backend authorization** — `backend/auth.js`'s `requirePerm`/`requireAnyPerm` grant `admin` and
  `tech` full access (same bypass shape as the seeded `id === 1` super-admin), so a page an admin
  or tech can navigate to also functions. `cashier` gets no such bypass — still subject to their
  actual `perm_*` flags if a route were ever reached without a nav link.
