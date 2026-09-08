# System Flow and Architecture

This is one of two prose documents under `docs/` — the other is `docs/architecture/functionality.md`
(what the system does). Every diagram referenced below is a standalone PlantUML `.puml` file, not
embedded here; open it in a PlantUML-capable viewer/IDE plugin or a local PlantUML server.

## Components

See **`docs/architecture/system-architecture.puml`** for the component diagram: the Electron app
per till (renderer, main process, local Express API, sync engine, local encrypted SQLite), the
AWS EC2-hosted cloud sync API (Postgres-backed), and the Lenco Pay integration.

## Operating modes

Set under Settings → Register (`electron/main.js`'s `local-config.json`, read via
`readLocalConfig`/`get-local-config` IPC):

| Mode | Local API | Local DB | Sync engine |
|---|---|---|---|
| Standalone Point of Sale | Yes (`127.0.0.1:8001`) | Yes | Yes |
| Network Point of Sale Server | Yes (`0.0.0.0:8001`) | Yes | Yes |
| Network Point of Sale Terminal | No | No | No — relies on its LAN server, which syncs on its behalf |

`startSyncEngine()` in `electron/main.js` reuses the exact same `shouldStartServer(mode)` gate the
local API already uses, so a Terminal till never tries to sync a database it doesn't have.

## Deployment target

The cloud sync API (`cloud-sync-api/`) is deployed to a single AWS EC2 instance (Phase 5 —
`docker compose up` on the instance, Postgres either co-located or RDS). This is a deliberate,
confirmed choice: **all business logic stays in the local Express server bundled with each
Electron install**, running against the local sql.js database — the EC2-hosted API is a thin
sync/reconciliation service only (push/pull/conflict-resolve), not the system of record for
day-to-day operation. The app must work with zero network connectivity, which rules out any
design where the EC2 API holds business rules the local app depends on to function.

## Trust boundaries: offline vs online

- **Fully offline, always**: sales/checkout with cash, dispensing, inventory lookups, prescription
  capture, reporting against local data — the local DB is the source of truth for day-to-day
  operation, per the brief's ground rules.
- **Requires connectivity**: card/mobile-money payments (Phase 2, Lenco), cross-branch
  price/stock-transfer/formulary updates arriving via sync pull, and pushing the local write
  queue to the cloud. None of these block the offline-capable flows above.

## What's architecturally different from a typical single-tenant POS

- **Append-only stock ledger** (`stock_movements`) alongside a maintained `products.quantity`
  projection — every write path (sales, dispensing, GRN, adjustments, transfers, stock takes)
  appends a movement row *and* updates `products.quantity` in the same database transaction, so
  the cached quantity can't drift from the ledger's history. Reads throughout the app use the
  cached `quantity` (fast, no aggregation needed); the ledger exists for audit history, per-batch
  cost tracking, and reporting, not as the live read path.
- **Immutable audit log and controlled-substance log** — insert-only tables, never updated, which
  is also why they can never conflict during sync.
- **Sync outbox, not per-table sync columns** — one `sync_outbox` queue table decouples "what
  needs to sync" from the domain schema; see `docs/architecture/database-schema.puml`.

## Data flow: offline sync

Implementation: `sync-engine/` (engine), `cloud-sync-api/` (dev-only in-memory cloud API today —
becomes a real Postgres-backed service in Phase 5). See
**`docs/architecture/data-flow-sync.puml`** for the happy-path sequence.

- **Trigger**: `ConnectivityMonitor` (`sync-engine/connectivity.js`) pings `GET /health` on a
  timer (`intervalMs`, default 15s). Every tick that comes back online runs a full push-then-pull
  pass — covering both "just reconnected" and "still online, drain anything queued since the last
  pass." The renderer reads live status via `window.pos.getSyncStatus()`.
- **Crash mid-sync (resume)**: every outbox row has a unique `idempotency_key`; a push is a plain
  `synced = 0` read, so a crash between "server accepted the batch" and "local rows marked synced"
  just means the next sync pass re-sends already-accepted rows. The cloud API's `applyPush`
  (`cloud-sync-api/store.js`) treats a repeated `idempotencyKey` as a no-op accept.
- **Conflict resolution** (`sync-engine/conflict.js`):

  | Entity class | Rule | Why |
  |---|---|---|
  | `stock_movements`, `audit_log`, `controlled_substance_log` | Never conflicts — append-only, throws if the transport ever reports one | Each row is inserted once by a unique id and never updated; a reported conflict here is a transport bug, not a data conflict |
  | `transactions`, `payments` (financial) | Server wins | Cloud is the reconciliation source of truth once synced — a device should never silently overwrite a settled financial record |
  | Everything else (products, customers, prescriptions, ...) | Last-write-wins, merged per field | Uses `updatedAt` (or a per-field `fieldUpdatedAt` map when present) to pick the newer side field-by-field rather than one side winning wholesale |

## Data model

- **`docs/architecture/erd.puml`** — conceptual entity-relationship diagram (entities,
  relationships, cardinality, key attributes only).
- **`docs/architecture/database-schema.puml`** — the full physical schema: every table, every
  column, every FK, with relations and cardinality.
- **`docs/architecture/domain-class-diagram.puml`** — the same domain expressed as a conceptual
  model with business behavior (independent of how it's implemented).

Design notes:

- `stock_movements` is append-only; current stock for day-to-day reads is `products.quantity`, a
  maintained projection updated in the same transaction as each movement — not derived by summing
  the ledger on every read.
- `controlled_substance_log` and `audit_log` are immutable by convention (application-level: no
  UPDATE/DELETE routes are ever built against them).
- `users.role` is mostly informational/UX (labeling, defaults) for `cashier`/`pharmacist`/
  `manager` — actual authorization for those three still runs through the flat boolean `perm_*`
  columns and `requirePerm`/`requireAnyPerm` in `backend/auth.js`. The two newer values, `admin`
  and `tech`, are the exception: both are hard-checked by name in `requirePerm`/`requireAnyPerm`
  (full access, same bypass shape as the `id === 1` seeded super-admin) and in the frontend nav
  (`frontend/layout/AppShell.tsx`) to enforce view separation — see
  `docs/architecture/role-view-access.puml` and `docs/architecture/functionality.md`'s
  "Role-based view access" section.
- `products.controlled_substance` has no catalog-editing UI yet to toggle it — it's set directly
  against the database until the Catalog view grows a field for it.
- `branches`/`stock_transfers` model *this branch's own* view of a transfer — cross-branch
  auto-routing would need the cloud sync API's generic entity store (Phase 5), extended with
  branch-aware routing logic — not yet built.
- `payments` (Phase 2) is treated as a financial record for sync conflict resolution — same
  server-authoritative rule as `transactions`. `transaction_id` is nullable because a
  card/mobile-money payment is initiated *before* the sale it pays for is created (never mark a
  sale paid speculatively).

## Implementation (code structure)

Unlike the domain class diagram (the conceptual business model), these reflect actual code
structure — real ES6 classes where they exist, and function-based modules (marked `<<module>>`)
documented as if their exported functions were methods, since most of this codebase is written as
plain functions and route handlers rather than classes. Three areas of the code use genuine OOP —
shown as real classes in their own diagrams:

- **`docs/architecture/class-diagram-payment-gateways.puml`** — `backend/payments/`'s abstract
  `PaymentGateway` hierarchy (`CashGateway`, `LencoGateway`, `UnconfiguredGateway`,
  `PaymentRegistry`), the one place in this codebase built as a textbook abstract-base-class
  hierarchy, specifically so checkout code never branches on provider.
- **`docs/architecture/class-diagram-sync-engine.puml`** — `sync-engine/`'s `ConnectivityMonitor`,
  `SyncEngine` (factory), `Outbox`, `Push`, `Pull`, `ConflictResolver`, `HttpTransport`.
- **`docs/architecture/class-diagram-db-encryption.puml`** — `backend/db.js` +
  `backend/encryption.js`'s `Database`, `DbHandle`, `Encryption`.

The bulk of the backend (`backend/routes/*.js`) is plain Express `Router` factories, not classes —
each exports a function that builds and returns a `Router`. They aren't diagrammed as classes
because they don't hold instance state between requests (all state is in the database); their
structure is better read directly from `backend/index.js`'s mount list, or from the component
diagram above.

## Related documents

- `docs/architecture/functionality.md` — what the system does, per use case, plus role-based view
  access.
- `docs/use-cases/*.puml` — one PlantUML sequence diagram per core use case.
