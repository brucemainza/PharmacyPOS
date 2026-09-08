import crypto from 'crypto';
import { mapPayment } from '../db.js';

// Local bookkeeping for a payment attempt — reconciled against the sale (transactions row) and
// the offline sync ledger so a payment's success/failure state survives an app restart or a
// dropped connection mid-transaction, per the Phase 2 brief.
export function createPaymentRecord(db, { transactionId, provider, method, reference, amount, currency }) {
  const now = new Date().toISOString();
  const idempotencyKey = crypto.randomUUID();
  const result = db
    .prepare(
      `INSERT INTO payments
        (transaction_id, provider, method, reference, amount, currency, status, idempotency_key, initiated_at, raw_response_json)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, '{}')`
    )
    .run(transactionId, provider, method, reference, amount, currency, idempotencyKey, now);
  return result.lastInsertRowid;
}

export function updatePaymentStatus(
  db,
  reference,
  { status, providerReference, reasonForFailure, redirectUrl, raw }
) {
  const isTerminal = status === 'successful' || status === 'failed' || status === 'refunded';
  const existing = db.prepare('SELECT confirmed_at FROM payments WHERE reference = ?').get(reference);
  const confirmedAt = isTerminal ? existing?.confirmed_at || new Date().toISOString() : existing?.confirmed_at || null;

  db.prepare(
    `UPDATE payments SET
      status = ?,
      provider_reference = COALESCE(?, provider_reference),
      reason_for_failure = ?,
      redirect_url = COALESCE(?, redirect_url),
      raw_response_json = ?,
      confirmed_at = ?
     WHERE reference = ?`
  ).run(
    status,
    providerReference || null,
    reasonForFailure || null,
    redirectUrl || null,
    JSON.stringify(raw || {}),
    confirmedAt,
    reference
  );
}

// A new (not resumed-from-hold) sale doesn't have a transactions row yet when a card/mobile
// money payment is initiated — the row is only created once the gateway confirms success, per
// the "never mark a sale paid before the gateway confirms it" rule. This backfills the link
// once that row exists, so the payment stays reconcilable against the sale it paid for.
export function linkPaymentToTransaction(db, reference, transactionId) {
  db.prepare('UPDATE payments SET transaction_id = ? WHERE reference = ?').run(
    transactionId,
    reference
  );
}

export function recordWebhookPayload(db, reference, payload) {
  db.prepare('UPDATE payments SET webhook_payload_json = ? WHERE reference = ?').run(
    JSON.stringify(payload),
    reference
  );
}

export function getPaymentByReference(db, reference) {
  return mapPayment(db.prepare('SELECT * FROM payments WHERE reference = ?').get(reference));
}

export function getPaymentsForTransaction(db, transactionId) {
  return db
    .prepare('SELECT * FROM payments WHERE transaction_id = ? ORDER BY id DESC')
    .all(transactionId)
    .map(mapPayment);
}

export function generateReference(prefix = 'pos') {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
}
