# Lenco Pay Integration

Implementation: `backend/payments/` (gateway abstraction + Lenco client), `backend/routes/payments.js`
(HTTP surface), `frontend/pages/TillView.tsx` (checkout UI). Built directly from the live docs at
https://lenco-api.readme.io/v2.0/reference — endpoint paths, field names, and status vocabularies
below are copied from there, not guessed (see git history on this file's commit for the exact
pages fetched).

## Setup

1. Copy `.env.example` to `.env` (git-ignored — never commit it).
2. Fill in `LENCO_SECRET_KEY` and `LENCO_PUBLIC_KEY` from your Lenco App dashboard (sandbox
   values are in the project's `Lenco_Integration_Guide v2.pdf`, itself git-ignored since it
   contains the sandbox secret key in plaintext).
3. `LENCO_ENV=sandbox` (default) or `production` selects the base URL; see `backend/config.js`.

`backend/payments/registry.js` builds one `LencoGateway` instance backing both `card` and
`mobile_money`, and a `CashGateway` for cash. If `LENCO_SECRET_KEY` is unset, the registry falls
back to a stub that only fails when card/mobile-money is actually used — cash keeps working.

## PaymentGateway abstraction

`backend/payments/PaymentGateway.js` defines the contract every provider implements:
`initiatePayment(params)`, `checkStatus(reference)`, `handleWebhook(rawBody, headers)`,
`refund(reference, amount)`. `CashGateway` (`backend/payments/cash/`) and `LencoGateway`
(`backend/payments/lenco/`) both implement it — checkout code never branches on provider, only on
`method` (`cash` | `card` | `mobile_money`).

## Card payments

`POST /collections/card` requires the card payload **JWE-encrypted** (RSA-OAEP-256 / A256GCM)
with a public key fetched fresh from `GET /encryption-key` on every call (Lenco's docs: the key
"might change anytime and should not be stored and reused"). Implemented in
`backend/payments/lenco/encryption.js` using the `jose` package, matching Lenco's own Node.js
example.

**PCI-DSS note, called out honestly rather than glossed over:** Lenco's docs state plainly that
raw card collection via this direct API "requires PCI DSS certification... for production use."
This project uses the direct API for sandbox testing convenience (it's scriptable, so it's what
the integration tests exercise end to end). For a real production rollout, prefer Lenco's hosted
widget (`https://pay.lenco.co/js/v1/inline.js`, `LencoPay.getPaid()`) instead, which keeps raw
card data off this app's servers entirely — that's a checkout-flow change, not a gateway-interface
change, since `PaymentGateway` doesn't care how a provider collects card details.

Sandbox test cards (from Lenco's test-cards-and-accounts page): Visa `4622 9431 2701 3705`
(CVV 838), Visa `4622 9431 2701 3747` (CVV 370), Mastercard `5555 5555 5555 4444` (any CVV). All
three test cards can return `3ds-auth-required` with a `meta.authorization.redirect` URL — the
checkout UI surfaces this as "requires additional verification, use a different card or cash"
since this till has no way to complete a 3DS redirect.

## Mobile money payments

`POST /collections/mobile-money` is plain JSON, no encryption — `phone`, `operator`
(`airtel`/`mtn`/`tnm`/`zamtel`), `country` (`zm`/`mw`, optional), `amount`, `reference`. Sandbox
resolution is **asynchronous**: the initiate call returns `pay-offline` (mapped to our `pending`),
and the sandbox resolves it to `successful`/`failed` some seconds later based on the test phone
number used (see Lenco's test-cards-and-accounts page for the full list, e.g. `0971111111`
Airtel-ZM succeeds, `0975555555` fails with "Not enough funds"). Observed in this project's
integration tests: success resolves in ~15-20s, some failure scenarios take just over 30s — the
checkout UI polls every 2.5s for up to 60s before giving up.

## Status polling & webhooks

- `GET /collections/status/:reference` — used by `LencoGateway.checkStatus` and by
  `GET /api/payments/:reference/status`, which the checkout UI polls while a payment is pending.
- Webhook: unauthenticated `POST /api/payments/webhook/lenco`, mounted before the `authenticate`
  middleware in `backend/index.js` (same pattern as `/api/health`/`/api/users`). Signature scheme
  per Lenco's docs: `X-Lenco-Signature` header = HMAC-SHA512 of the **raw** request body, keyed by
  `SHA256(LENCO_SECRET_KEY)` hex digest. `backend/index.js`'s `express.json()` captures the exact
  raw bytes onto `req.rawBody` via its `verify` option specifically so the signature check hashes
  what Lenco actually signed, not a re-`JSON.stringify`'d (and potentially differently-ordered)
  reconstruction. Verified with a real HMAC computed the same way in
  `backend/payments/lenco/LencoGateway.test.js`.
- Lenco's own docs warn webhooks aren't fully reliable ("you may not be able to rely completely
  on webhooks... if your server is experiencing downtime") and recommend a polling fallback —
  this app does both: the checkout UI polls while the sale is in progress, and the webhook can
  independently update a payment's status later (e.g. after an app restart), converging on the
  same `payments` row either way.
- **Webhook delivery itself is not integration-tested** — Lenco requires a publicly reachable
  URL ("localhost won't work"), which a local dev/CI environment doesn't have. What's tested is
  our own implementation of their documented signature algorithm (unit tests) and status polling
  against the real sandbox (integration tests).

## Refunds — a real limitation, not an oversight

Lenco's v2.0 API (confirmed via its documentation index) has **no "refund a collection"
endpoint** — only outbound transfers, which are a different flow (recipient creation, a separate
payout, no automatic link back to the original collection). `LencoGateway.refund()` throws a
clear error rather than faking a refund with a transfer. Card/mobile-money refunds currently need
manual reconciliation (e.g. a bank-side reversal or a goodwill cash refund) — flagged here as a
known gap for Phase 3's refund/void use case (`docs/architecture/functionality.md`'s
"Refund / Void" section, diagram `docs/use-cases/uc-refund-void.puml`) to account for.

## Offline behavior

`GET /api/payments/methods` (authenticated) returns `{ cash: true, card, mobile_money }`, where
`card`/`mobile_money` reflect `LencoGateway.isReachable()` (a short-timeout ping to
`/encryption-key`). The checkout UI (`TillView.tsx`) calls this every time the payment modal
opens — not once at app start — so a checkout that started online but lost connectivity mid-flow
doesn't keep offering options it can't fulfil. Card/mobile-money options are disabled (not
hidden) with an "(offline)" label when unreachable; cash is always available. A payment is never
marked successful locally without the gateway saying so — `finalizeSale()` (which creates the
paid sale record) is only ever called after a `successful` status, whether that arrives
immediately, via polling, or (for a resumed hold) via a later webhook.

## Reconciliation & offline sync

Every payment attempt gets a `payments` row (`backend/db.js` migration 11) with its own reference,
provider reference, status, and idempotency key, independent of whether a `transactions` (sale)
row exists yet. For a new (non-held) sale, the payment is initiated *before* the sale is created
(so nothing is marked paid speculatively); once the gateway confirms success, the sale is created
and `POST /api/payments/:reference/link` backfills `payments.transaction_id`. Every payment status
change also enqueues a `sync_outbox` entry (`entity_type: 'payments'`) via the Phase 1 sync
engine, so a payment's state — including one that only resolves via a later webhook or poll —
survives an app restart and eventually reaches the cloud ledger, per
`docs/architecture/system-architecture.md`'s conflict rules (`payments` isn't in the sync engine's
append-only set, so it follows the same server-authoritative-on-conflict path as `transactions`).
