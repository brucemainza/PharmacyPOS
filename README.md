# MediPOS

Offline-first pharmacy Point of Sale for a single register or a LAN of networked tills. Version
**2.0** rebuilds the original generic-retail Electron app into a pharmacy system: prescriptions,
controlled-substance dispensing with a second-approver workflow, batch/expiry tracking, goods
receiving, stock takes and branch transfers, card/mobile-money payments (Lenco), and
role-separated access — all on a secure, maintainable Electron/React/Express stack.

## How it works

- **Local-first, always.** Each till is a full Electron app bundling its own Express API and an
  encrypted local SQLite database (via `sql.js`). Sales, dispensing, inventory, prescriptions, and
  reporting all run against that local database — the app works correctly with **zero network
  connectivity**, which is the whole point of the design, not an afterthought.
- **Sync is a background reconciliation layer, not a dependency.** A local sync engine
  (`sync-engine/`) queues every domain write to an outbox and pushes/pulls it against a
  Postgres-backed cloud API (`cloud-sync-api/`, deployed to a single AWS EC2 instance) whenever
  connectivity is available. No business rule the till needs to function ever lives only in the
  cloud. Financial records (`transactions`, `payments`) are server-authoritative once synced;
  append-only ledgers (`stock_movements`, `audit_log`, `controlled_substance_log`) never conflict
  by construction; everything else is last-write-wins, merged per field.
- **One database, three connection modes.** *Standalone* runs the API and DB locally. *Network
  Server* does the same but binds the API to the LAN so other tills can use it. *Network Terminal*
  has no local API/DB at all and talks to a Server till over the LAN — see **Operating modes**
  below.
- **Two authorization layers.** `users.role` (`cashier` / `pharmacist` / `manager` / `admin` /
  `tech`) drives which navigation views a user even sees (see **Roles & navigation** below), while
  a set of flat `perm_*` boolean flags on each user drives what they're allowed to *do* — checked
  server-side on every request via `requirePerm`/`requireAnyPerm`, never just hidden in the UI.
- **Payments never trust the client.** Card and mobile-money payments go through Lenco's sandbox
  API; a sale is only ever marked paid after the gateway itself confirms success (immediately, via
  polling, or via a signature-verified webhook) — never speculatively.

For the full technical picture (component diagram, sync sequence, database schema, class
diagrams) and a per-use-case functional breakdown, see **Documentation** below.

## Features

### Till (checkout)
- Barcode scan / search (Enter to add), category filter chips (pharmacy therapeutic categories)
- Product tiles with price and stock status; a red diagonal **Sold out** ribbon replaces
  out-of-stock tiles instead of a text badge
- Cart with quantity controls, a flat discount, and tax
- Customer picker with quick-add
- Hold / resume sales
- Cash, card, and mobile-money payment (see **Payments**), plus **split payments** — any number
  of cash/card/mobile-money tenders against one sale
- Tiered discount approval: above `settings.discount_approval_threshold`, a manager (or anyone
  with `perm_discount_approve`) must authorize with their own credentials before the sale charges
- Animated **Payment successful** confirmation (green checkmark) before the receipt-printing step
- Printable receipt with a decorative QR code; currency amounts render in bold Roboto, everything
  else in the app's normal font
- Change / still-due display

### Prescriptions & controlled substances
- Create a prescription against a patient with one or more line items
- Dispense fully or partially across multiple visits; remaining quantity always visible
- Generic substitution, restricted to `pharmacist`/`manager`/`admin`/`tech` roles, checked
  server-side against the live user record
- Controlled-substance dispensing requires a **second, distinct approving user**
  (`perm_controlled_approve`), verified without switching the dispensing user's session — logged
  immutably to a dedicated controlled-substance register

### Catalog & Inventory
- Products, categories, and suppliers
- Batch/lot and expiry tracking, with a near-expiry alerts view
- **Goods receiving (GRN)** — records landed cost per batch and increments stock in one
  transaction
- **Stock take / cycle count** — snapshot expected quantity, record counts, post variance
  adjustments
- **Branch-to-branch stock transfer** — local bookkeeping for goods leaving/arriving at this
  branch (see `docs/use-cases/uc-stock-transfer.puml` for the current single-branch-database
  scope)
- Reorder-level tracking, photo picker (local upload + Pexels search) for catalog images
- **Seed demo** sample pharmacy catalog (18 therapeutic categories, brand/generic pairs,
  controlled substances) and multi-select **bulk delete**

### Sales, Refunds & Cash-up
- Transaction history filtered by date range, cashier, till, and status (paid / held / voided /
  refunded)
- Void and full/partial refund, restocking inventory and writing an audit trail
  (`perm_refund_void`)
- **End-of-day cash-up / Z-report** — server-recomputed expected cash vs. a physical count, with
  variance recorded (not blocked)

### Customers & Patients
- Combined customer/patient record: contact details, date of birth, allergies, insurance
  reference, corporate account link
- Purchase history per customer
- Automatic **loyalty points** accrual on paid sales (earning only — redemption is manual today)
- Corporate/insurance contracted discount rates (entered manually at checkout, still subject to
  the tiered discount-approval check)

### Analytics
- Daily sales, profit & margin (weighted-average landed cost), cashier performance, fast/slow
  movers, stock valuation, near-expiry alerts, and the controlled-substance dispensing register —
  all computed from the local database, fully offline

### Team & Roles
- Staff accounts with a role (`cashier` / `pharmacist` / `manager` / `admin` / `tech`) plus
  granular permission flags (products, categories, sales, users, settings, discount approval,
  refund/void, controlled-substance approval, price override)
- **Role-based navigation separation** — see below

### Settings
- Store identity (name, address, contact, logo, receipt footer)
- Currency symbol (defaults to **ZMW**) and optional tax
- Operating mode (Standalone / Network Server / Network Terminal), till number
- Pexels API key for catalog photos
- Demo data seed / full catalog & sales wipe

The discount-approval threshold (default 10% of subtotal, see **Till** above) exists as a
`settings` column with no Settings-page field yet — change it via the API/database directly until
a form control is added.

### Payments (Lenco)
- Card and mobile-money (Airtel / MTN / TNM / Zamtel) collections against Lenco's sandbox API
- Connectivity re-checked every time the payment modal opens — Card/Mobile Money disable
  themselves with an "(offline)" label rather than offering a payment method that can't complete
- Signature-verified webhook endpoint for asynchronous status updates
- No refund endpoint exists in Lenco's API — refunds on a card/mobile-money sale need a manual,
  off-platform reversal (the sale record and inventory restocking still work normally)

### Roles & navigation

Three roles are **hard-gated** in the sidebar regardless of permission flags; two remain
permission-driven as before:

| Role | Till | Every other view |
|---|---|---|
| `cashier` (Till operator) | ✅ | — |
| `admin` (Administrator) | — | ✅ |
| `tech` | ✅ | ✅ |
| `pharmacist` / `manager` | ✅ | per `perm_*` flags, unchanged |

A till operator can reach *only* the Till — this can't be widened by ticking a permission
checkbox. An administrator manages the pharmacy (catalog, staff, settings, reporting) but doesn't
operate a register. Tech has full access, including the Till, for support/troubleshooting. See
`docs/architecture/functionality.md`'s "Role-based view access" section and
`docs/architecture/role-view-access.puml` for the full diagram.

## Tech stack

| Layer | Technology |
|--------|------------|
| Desktop shell | Electron 33 (contextIsolation, preload bridge — no `nodeIntegration`) |
| UI | React 18 + TypeScript + Vite 6 |
| API | Express |
| Auth | JWT + bcrypt, flat `perm_*` RBAC (`backend/auth.js`) |
| Database | SQLite via **sql.js** (no native build toolchain required), AES-256-GCM encrypted at rest |
| Payments | Lenco Pay API (card + mobile money), sandbox by default |
| Offline sync | Custom outbox/push/pull engine (`sync-engine/`) against a Postgres-backed cloud API (`cloud-sync-api/`) |
| Cloud deploy | Docker Compose on a single AWS EC2 instance |
| Receipts | Client-generated QR code (`qrcode`), bundled Roboto font (`@fontsource/roboto`) for currency |
| Installer | electron-builder (Windows NSIS) |

## Requirements

- Node.js 18+ (20 LTS recommended)
- Windows for the packaged installer (`npm run dist`); `npm run dev` works wherever Electron runs

## Quick start

```bash
npm install
npm run dev
```

Default login:

| Username | Password |
|----------|----------|
| `admin`  | `admin`  |

Change the admin password after first login in a production deployment. The seeded `admin` user
is id `1` and is treated as a permanent super-admin regardless of its role/permission flags.

### Till shortcuts

| Key | Action |
|-----|--------|
| **Enter** | Add scanned / searched item |
| **F2** | Open payment (charge) |
| **F4** | Held sales |
| **Esc** | Close payment modal |

## Operating modes

Configure under **Settings → Register**. Restart the app after changing mode.

| Mode | Behavior |
|------|----------|
| **Standalone** | Local API + SQLite on this PC (`127.0.0.1:8001`) |
| **Network Server** | Same database, API bound to `0.0.0.0:8001` so other tills can connect |
| **Network Terminal** | No local DB; connects to the server IP you enter |

Typical LAN setup:

1. On the back-office / main PC → **Network Server**, note the LAN IP shown in Settings.
2. On each till PC → **Network Terminal**, set **Server IP** to that address, assign a unique **Till number**.
3. Restart both apps.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Vite + Electron (development) |
| `npm run build` | Production UI build into `dist/` |
| `npm start` | Electron against an existing build / config |
| `npm test` | Unit/integration tests (sync engine, payments, routes, DB) — no network required |
| `npm run test:lenco-sandbox` | Payment tests against the real Lenco sandbox (needs sandbox credentials) |
| `npm run smoke` | API + LAN smoke tests |
| `npm run dist` | Build UI and create Windows installer |

Installer output:

```text
release/MediPOS Setup 2.0.0.exe
```

## Project layout

```text
electron/          Main process + secure preload (window.pos)
backend/           Express API, sql.js database, route modules
  routes/          inventory, categories, customers, users, settings, transactions,
                   prescriptions, analytics, payments, media, demo
  payments/        PaymentGateway abstraction (Cash, Lenco, Unconfigured)
sync-engine/       Offline-first sync engine (outbox, push/pull, conflict resolution)
frontend/          React UI
  pages/           Till, Catalog, Inventory, Sales, Prescriptions, Analytics, Customers,
                   Team, Settings, Login
  components/      Payment pad, success animation, photo picker, customer select, …
  layout/          App shell / sidebar (role-based nav)
  api/client.ts    HTTP client
cloud-sync-api/    Postgres-backed cloud sync API (deployed separately, e.g. to EC2)
docs/              Architecture, use cases, compliance, ops, and payments documentation
scripts/           Smoke tests
build/             App icons for the installer
public/favicon.ico Packaged favicon
```

Data and uploads live under Electron **userData** (not in the repo), so uninstalling may leave a database folder depending on OS settings.

## Demo data

From **Catalog** or **Settings → Demo data**:

- **Seed demo** — adds a sample pharmacy catalog (18 therapeutic categories, brand/generic pairs,
  controlled substances, suppliers) and customers if those names do not already exist
- **Bulk delete** (Catalog) — delete selected products
- **Bulk delete catalog & sales** (Settings) — removes products, categories, sales history, and customers except Walk-in; keeps staff and settings

## API overview

Local API base (standalone): `http://127.0.0.1:8001/api`

| Area | Examples |
|------|----------|
| Auth | `POST /users/login`, `POST /users/authorize` (supervisor override without switching session) |
| Catalog | `/inventory/products`, `/categories/all`, `/inventory/grn`, `/inventory/batches`, `/inventory/stock-take`, `/inventory/transfer` |
| Sales | `POST /new`, `GET /by-date`, `GET /on-hold`, `POST /void`, `POST /refund`, `GET/POST /cash-up` |
| Prescriptions | `POST /prescriptions/`, `POST /prescriptions/:id/items/:itemId/dispense` |
| Payments | `POST /payments/initiate`, `GET /payments/:reference/status`, `POST /payments/:reference/link`, `POST /payments/webhook/lenco` |
| Analytics | `/analytics/daily-sales`, `/analytics/profit-margin`, `/analytics/cashier-performance`, `/analytics/movers`, `/analytics/stock-valuation`, `/analytics/controlled-register` |
| Media | `/media/library`, `/media/pexels/search` |
| Demo | `POST /demo/seed`, `POST /demo/clear` |

Authenticated routes expect `Authorization: Bearer <token>`.

## Documentation

Deeper documentation lives under `docs/`. Diagrams are plain PlantUML `.puml` files — open them in
a PlantUML-capable viewer/IDE plugin or a local PlantUML server (they don't render inline on
GitHub).

- `docs/architecture/functionality.md` — what the system does, use case by use case, plus the
  role-based view access table.
- `docs/architecture/system-architecture.md` — system flow, architecture, operating modes,
  deployment target, trust boundaries, and data-model design notes.
- `docs/architecture/*.puml` — system architecture (components), sync data flow, ERD, full
  physical database schema, domain class diagram, implementation class diagrams (payment
  gateways, sync engine, DB/encryption), and role-view access.
- `docs/use-cases/*.puml` — one sequence diagram per core use case (sale checkout, prescription
  dispensing, controlled-substance dispensing, cash-up, goods receiving, customer/patient
  management, offline sync, Lenco card/mobile-money payment, refund/void, stock take, stock
  transfer, analytics).
- `docs/payments/lenco-integration.md` — Lenco integration details, offline gating, refund
  limitation.
- `docs/compliance/` — audit trail requirements, controlled-substance log, data protection.
- `docs/ops/` — Docker deployment and the sync runbook.

## Security & compliance notes

- Renderer has no Node integration; privileged actions go through the preload bridge.
- Local database is AES-256-GCM encrypted at rest (`backend/encryption.js`); a legacy plaintext
  file loads transparently once and is re-persisted encrypted.
- Authorization is enforced server-side (`requirePerm`/`requireAnyPerm`) on every request, not
  just hidden in the UI — including for the new `admin`/`tech` roles, which are granted full
  access the same way the seeded `id === 1` super-admin is.
- `audit_log` and `controlled_substance_log` are immutable by convention (no UPDATE/DELETE routes
  are ever built against them) and never conflict during sync.
- Change default `admin` credentials before real use.
- Prefer Network Server only on a trusted LAN; put a firewall in front for wider exposure.
- Pexels key and Lenco secret key are stored/used on the server machine — treat them like secrets.

## Troubleshooting

| Issue | What to try |
|-------|-------------|
| Blank window / `window.pos` missing | Use Electron via `npm run dev`, not a plain browser tab |
| Terminal cannot reach server | Same LAN, correct server IP, mode = Network Server, port **8001** open |
| Sales history empty | Date filters use local time; default range is month start → end of today |
| Card/Mobile Money greyed out | `GET /api/payments/methods` couldn't reach Lenco — check network/sandbox credentials; cash still works |
| Media library 404 after code changes | Restart Electron so the API process reloads new routes |
| Native module / SSL build errors | This project uses **sql.js** deliberately to avoid `better-sqlite3` compile issues |

## License / authorship

Desktop POS application maintained for pharmacy use. See repository history for contributors to the original generic-retail build and the pharmacy 2.0 rewrite.
