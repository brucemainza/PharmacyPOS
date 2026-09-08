# Engineering Brief: Convert Generic POS → Offline-First Pharmacy POS (Electron)

> Paste this whole document into your coding agent (e.g. Claude Code) working inside the
> existing POS repository. It is written as a phased, commit-driven work order, not a
> one-shot build request — the agent should work through the phases in order, committing
> after each completed, testable slice of work.

---

## 0. Ground Rules for the Agent

1. **This is a modification, not a rewrite.** Start by reading the existing codebase
   (`/src`, `/electron`, `/main`, `/renderer`, or wherever the app lives) and the existing
   data model before changing anything. Preserve working functionality; extend it.
2. **Commit-driven development.** One logical change per commit. Use Conventional Commits
   (`feat:`, `fix:`, `refactor:`, `docs:`, `chore:`, `test:`). No mega-commits. Each commit
   should leave the app in a runnable state. Open a short-lived branch per phase/feature
   (e.g. `feat/offline-sync-engine`, `feat/lenco-payments`) and merge into `main` when the
   phase's acceptance criteria (below) are met.
3. **Never invent API behavior.** For the Lenco Pay integration, fetch and read the actual
   Lenco API reference (https://lenco-api.readme.io) and the sandbox credentials already
   present in the project directory before writing integration code — do not guess endpoint
   names, payloads, or webhook signatures.
4. **Secrets stay out of git.** The Lenco sandbox credentials in the project directory must
   be loaded via `.env` (git-ignored) / OS keychain — never hardcoded, never committed.
5. **Docs are a deliverable, not an afterthought.** The `/docs` folder is built up
   incrementally, phase by phase, alongside the code — not written at the end.

---

## 1. Phase 1 — Domain & Architecture Foundation

**Goal:** Turn the generic POS's data model into a pharmacy-specific one, and lock in the
offline-first architecture before building features on top of it.

### 1.1 Offline-first architecture
- Local-first storage inside the Electron main process using an embedded database
  (e.g. SQLite via `better-sqlite3` or `sql.js`, or an embedded document store) — this is
  the **source of truth for day-to-day operation**, so the app is fully usable with zero
  network connectivity (sales, dispensing, inventory lookups must never block on the network).
- A **sync engine** as its own module (`/electron/sync` or `/services/sync`) responsible for:
  - Queuing local writes (sales, stock adjustments, dispensing records, cash-ups) with a
    monotonic local sequence id and a `synced: boolean` / `syncedAt` flag.
  - Detecting connectivity changes (online/offline events + periodic heartbeat ping to the
    cloud API) and triggering a sync pass when connectivity returns.
  - Pushing queued local changes to the cloud API, pulling down remote changes (e.g. price
    list updates, stock transfers from other branches, prescriber/formulary updates).
  - Conflict resolution strategy: define and document it explicitly (recommend
    last-write-wins per field with a server-authoritative merge for financial records, and
    an append-only ledger for stock movements so nothing is silently overwritten — reconcile
    stock via movement events, not absolute quantity overwrites).
  - Idempotent sync (safe to retry/resume after a crash mid-sync) using per-record
    idempotency keys.
- Cloud side: a minimal sync API (REST or similar) backed by a real database (Postgres
  recommended) that the Electron app talks to only when online. This is the piece that gets
  Dockerized (see Phase 5).

### 1.2 Pharmacy domain model
Extend/replace the generic POS schema with:
- **Products**: add batch/lot number, expiry date, controlled-substance flag,
  generic/substitution group, reorder level, supplier.
- **Prescriptions**: patient, prescriber, date, linked dispensed items vs billed items,
  partial-fill state, substitution record, pharmacist approval (with user id + timestamp).
- **Controlled items workflow**: extra approval step + immutable audit log entry for any
  controlled-item dispensing.
- **Inventory**: goods-receiving (GRN), supplier invoices, stock adjustments, stock
  transfers between branches, stock-take/cycle-count with variance report — all as
  append-only movement events, with current stock derived from the event log.
- **Customers/patients**: demographics, contact, purchase history, optional loyalty points,
  optional corporate/insurance pricing.
- **Users/roles**: cashier vs pharmacist vs manager, with permission checks for discounts,
  refunds/voids, controlled-item approval, and price overrides.
- **Audit trail**: every sale, void, refund, discount approval, stock adjustment, and
  controlled-item action gets an immutable, timestamped, user-attributed log entry.

**Acceptance criteria:** schema migrations exist and run cleanly on a fresh DB; the sync
engine has unit tests covering queue → push → pull → conflict cases; ERD is drafted (feeds
into Phase 4 docs).

---

## 2. Phase 2 — Lenco Pay Integration (Card + Mobile Money)

**Goal:** Replace/extend the existing payment flow so card and mobile money payments go
through Lenco Pay, while cash payments continue to work fully offline.

1. Locate the Lenco sandbox credentials already in the project directory; load them through
   environment config, never inline.
2. Read the live Lenco API docs (collections/payments endpoints for card and mobile money)
   before implementing — confirm auth scheme, request/response shape, currency handling, and
   webhook signature verification.
3. Build a `PaymentGateway` abstraction in the codebase so Lenco is a pluggable provider
   behind an interface (`initiatePayment`, `checkStatus`, `handleWebhook`) — this keeps cash
   and future providers cleanly separated from the Lenco-specific code.
4. **Offline behavior for card/mobile-money payments:** since these require connectivity,
   the checkout flow must clearly disable/queue-warn on these payment methods when offline,
   while cash remains always available. Do not silently queue a card/mobile-money charge as
   if it succeeded.
5. Handle: payment initiation, polling/webhook confirmation, reconciliation against the
   sale record, failure/timeout/retry, and refunds.
6. Store transaction references and reconcile them against the local sale + the sync ledger
   so a payment's success/failure state survives an app restart or a dropped connection
   mid-transaction.
7. Write integration tests against the Lenco **sandbox** only — never live/production keys
   in tests or CI.

**Acceptance criteria:** a sale can be completed end-to-end with a sandbox card and with a
sandbox mobile-money payment; a webhook correctly updates a pending sale; going offline
mid-checkout leaves the system in a safe, recoverable state.

---

## 3. Phase 3 — Feature Build-Out

Build against the domain model from Phase 1, each as its own commit-sized slice:

1. **Sales & Checkout** — barcode scan/search, add/remove/edit line items, tax/VAT and
   pricing rules, promotions, tiered discount approval (cashier vs manager), split payments
   (cash + Lenco), receipts, returns/refunds/voids with audit logging, end-of-day cash-up /
   Z-report.
2. **Dispensing & Prescriptions** — prescription capture, link to sale, partial fills,
   generic substitution with pharmacist approval, controlled-item workflow with extra
   approval + audit trail.
3. **Inventory** — real-time stock per branch, GRN/supplier invoices, batch/expiry tracking,
   reorder levels + suggested POs, branch-to-branch transfers, stock takes with variance
   reports.
4. **Customer/Patient management** — profiles, purchase history, loyalty points, optional
   corporate/insurance pricing.
5. **Analytics dashboard & reports** — daily sales, profit/margin, cashier performance,
   fast/slow movers, stock valuation, near-expiry/expired stock alerts, controlled-items
   register. Build this as its own dashboard view reading from local data (works offline)
   and reconciled/aggregated cloud-side for multi-branch roll-ups once synced.

**Acceptance criteria per feature:** manual test script in `/docs/test-scripts/` plus (where
practical) automated tests; feature works fully offline where the spec doesn't require
network (everything except card/mobile-money payment capture).

---

## 4. Phase 4 — Documentation (`/docs`)

Build a `/docs` folder covering every use case, kept current as features land:

```
/docs
  /architecture
    system-architecture.md        (offline-first + sync + Lenco integration, with diagram)
    data-flow-sync.md             (sequence diagram: local write → queue → push → conflict → pull)
    erd.md                        (entity-relationship diagram of the full domain model)
  /use-cases
    uc-sale-checkout.md
    uc-dispensing-prescription.md
    uc-controlled-substance-dispensing.md
    uc-goods-receiving.md
    uc-stock-transfer.md
    uc-stock-take.md
    uc-refund-void.md
    uc-end-of-day-cashup.md
    uc-payment-lenco-card.md
    uc-payment-lenco-momo.md
    uc-offline-to-online-sync.md
    ... (one file per use case, each with actor, preconditions, main flow, alternate/
        exception flows, and a use-case diagram)
  /diagrams
    (source files, e.g. Mermaid `.mmd` or PlantUML, rendered to `.svg`/`.png`, for every
    architecture and use-case diagram referenced above — keep source + rendered output)
  /compliance
    audit-trail-requirements.md
    controlled-substance-log.md
    data-protection.md            (patient data handling, retention, encryption at rest)
  /payments
    lenco-integration.md          (setup, sandbox vs production, webhook handling, credential
                                    management — no secrets committed)
  /ops
    docker.md                     (see Phase 5)
    sync-runbook.md                (how to diagnose/resolve a stuck or conflicted sync)
```

Use Mermaid diagrams (renderable directly in most Git hosts) for architecture, sequence, and
use-case diagrams unless the team has a different preferred tool.

**Acceptance criteria:** every feature merged in Phase 3 has a corresponding use-case doc;
the architecture diagrams accurately reflect the code as built (update them if they drift).

---

## 5. Phase 5 — Dockerization

- **Cloud sync API + database**: Dockerfile for the sync service, `docker-compose.yml`
  bringing up the sync API + Postgres (+ any cache/queue if used) for local development and
  for deployment. Include health checks and a seed/migration step.
- **Electron app itself is not containerized for end users** (it's a desktop installer), but
  provide a documented, containerized way to run its **test suite** and **build pipeline**
  reproducibly (a `Dockerfile.ci` or similar) so CI doesn't depend on a developer's machine
  state.
- Document all of this in `/docs/ops/docker.md`: how to bring the stack up locally
  (`docker compose up`), environment variables required (including where Lenco sandbox
  credentials get injected — via `.env`, never baked into the image), and how the packaged
  Electron app is pointed at the right sync API URL per environment.

**Acceptance criteria:** `docker compose up` brings up a working sync API + DB from a clean
checkout with no manual steps beyond copying `.env.example` to `.env`.

---

## 6. Suggested Execution Order (for commit planning)

1. `chore:` scaffold `/docs` structure and architecture stub docs
2. `feat:` local embedded DB + pharmacy domain schema/migrations
3. `feat:` sync engine (queue, push, pull, conflict handling) + tests
4. `feat:` Lenco Pay abstraction + sandbox card flow
5. `feat:` Lenco Pay mobile money flow + webhook handling
6. `feat:` sales/checkout updates for pharmacy pricing/discount rules
7. `feat:` prescriptions & dispensing workflow
8. `feat:` controlled-substance workflow + audit trail
9. `feat:` inventory (GRN, batch/expiry, transfers, stock take)
10. `feat:` customer/patient management
11. `feat:` analytics dashboard & reports
12. `docs:` fill in remaining use-case and compliance docs, finalize diagrams
13. `chore:` Dockerize sync API + compose stack, CI test container
14. `chore:` end-to-end offline/online sync + payment regression pass

---

## 7. Non-Functional Requirements Checklist

- [ ] Patient/prescription data encrypted at rest in the local DB
- [ ] Role-based access control enforced on discounts, refunds/voids, controlled items,
      price overrides
- [ ] Immutable audit log for all sensitive actions, survives offline periods, syncs to cloud
- [ ] No payment credentials or patient data ever logged in plaintext
- [ ] Graceful, user-visible handling of "offline" state throughout the UI — never a silent
      failure
- [ ] Data retention/compliance requirements for prescription and controlled-substance
      records documented and enforced
