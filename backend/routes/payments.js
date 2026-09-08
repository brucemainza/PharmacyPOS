import { Router } from 'express';
import { getDb } from '../db.js';
import { getGateway } from '../payments/registry.js';
import {
  createPaymentRecord,
  updatePaymentStatus,
  recordWebhookPayload,
  getPaymentByReference,
  getPaymentsForTransaction,
  linkPaymentToTransaction,
  generateReference,
} from '../payments/paymentsStore.js';
import { enqueueSync } from '../../sync-engine/outbox.js';
import { requirePerm } from '../auth.js';

const METHOD_PROVIDER = { cash: 'cash', card: 'lenco', mobile_money: 'lenco' };
const TERMINAL_STATUSES = new Set(['successful', 'failed', 'refunded']);

function enqueuePaymentSync(db, reference, status, extra = {}) {
  enqueueSync(db, 'payments', reference, 'update', {
    reference,
    status,
    updatedAt: new Date().toISOString(),
    ...extra,
  });
}

// Requires payments never appear settled unless a real gateway said so — checkout must never
// silently treat an unconfirmed card/mobile-money charge as paid (Phase 2 ground rule).
function applyStatusUpdate(db, reference, result, extra = {}) {
  const run = db.transaction(() => {
    updatePaymentStatus(db, reference, {
      status: result.status,
      providerReference: result.providerReference,
      reasonForFailure: result.reasonForFailure,
      redirectUrl: result.redirectUrl,
      raw: result.raw,
    });
    enqueuePaymentSync(db, reference, result.status, extra);
  });
  run();
}

// Authenticated routes: initiate/poll/list payments.
const router = Router();

// Lets the checkout UI know whether card/mobile-money can be offered right now — cash is
// always available. Never silently queue a card/mobile-money charge as if it succeeded; this
// is what the checkout flow polls to decide whether to grey those options out.
router.get('/methods', async (_req, res) => {
  let cardMomoReachable = false;
  try {
    cardMomoReachable = await getGateway('card').isReachable();
  } catch {
    cardMomoReachable = false;
  }
  res.json({ cash: true, card: cardMomoReachable, mobile_money: cardMomoReachable });
});

router.post('/initiate', async (req, res) => {
  const body = req.body || {};
  const { transactionId, method, currency = 'ZMW', customer, card, billing, mobileMoney, bearer } = body;
  const amount = parseFloat(body.amount);

  if (!method || !METHOD_PROVIDER[method]) {
    return res.status(400).json({ error: `Unsupported payment method "${method}"` });
  }
  if (!amount || amount <= 0) {
    return res.status(400).json({ error: 'amount must be a positive number' });
  }

  const db = getDb();
  const reference = generateReference();
  const provider = METHOD_PROVIDER[method];

  createPaymentRecord(db, {
    transactionId: transactionId || null,
    provider,
    method,
    reference,
    amount,
    currency,
  });
  enqueuePaymentSync(db, reference, 'pending', { transactionId: transactionId || null, method, amount });

  try {
    const gateway = getGateway(method);
    const result = await gateway.initiatePayment({
      method,
      reference,
      amount,
      currency,
      bearer,
      customer,
      card,
      billing,
      mobileMoney,
    });

    applyStatusUpdate(db, reference, result, { transactionId: transactionId || null, method, amount });

    res.json({
      reference,
      status: result.status,
      redirectUrl: result.redirectUrl || null,
      transactionId: transactionId || null,
    });
  } catch (err) {
    applyStatusUpdate(
      db,
      reference,
      { status: 'failed', reasonForFailure: err.message, raw: { error: err.message } },
      { transactionId: transactionId || null, method, amount }
    );
    res.status(502).json({ error: err.message, reference });
  }
});

router.get('/:reference/status', async (req, res) => {
  const db = getDb();
  const local = getPaymentByReference(db, req.params.reference);
  if (!local) return res.status(404).json({ error: 'Payment not found' });

  if (TERMINAL_STATUSES.has(local.status)) {
    return res.json(local);
  }

  try {
    const gateway = getGateway(local.method);
    const result = await gateway.checkStatus(local.reference);
    if (result && result.status !== local.status) {
      applyStatusUpdate(db, local.reference, result, {
        transactionId: local.transaction_id,
        method: local.method,
        amount: local.amount,
      });
    }
    res.json(getPaymentByReference(db, local.reference));
  } catch {
    // Transient poll failure (offline, timeout) — return last known local state instead of
    // erroring the checkout; the caller keeps polling or falls back to cash.
    res.json(local);
  }
});

router.post('/:reference/link', (req, res) => {
  const db = getDb();
  const transactionId = parseInt(req.body?.transactionId, 10);
  if (!transactionId) return res.status(400).json({ error: 'transactionId is required' });

  const payment = getPaymentByReference(db, req.params.reference);
  if (!payment) return res.status(404).json({ error: 'Payment not found' });

  linkPaymentToTransaction(db, req.params.reference, transactionId);
  enqueuePaymentSync(db, req.params.reference, payment.status, { transactionId, linked: true });
  res.json(getPaymentByReference(db, req.params.reference));
});

router.get('/transaction/:transactionId', requirePerm('perm_transactions'), (req, res) => {
  const db = getDb();
  const transactionId = parseInt(req.params.transactionId, 10);
  res.json(getPaymentsForTransaction(db, transactionId));
});

export default router;

// Unauthenticated: Lenco calls this directly, so it's mounted outside the `authenticate`
// middleware in server/index.js (same pattern as /api/health and /api/users).
export const paymentsWebhookRouter = Router();

paymentsWebhookRouter.post('/lenco', async (req, res) => {
  const rawBody = req.rawBody;
  if (!rawBody) {
    return res.status(400).json({ error: 'raw request body unavailable for signature check' });
  }

  try {
    const gateway = getGateway('card');
    const { event, record } = await gateway.handleWebhook(rawBody, req.headers);

    if (record?.reference) {
      const db = getDb();
      const local = getPaymentByReference(db, record.reference);
      if (local) {
        applyStatusUpdate(db, record.reference, record, {
          transactionId: local.transaction_id,
          method: local.method,
          amount: local.amount,
          via: 'webhook',
        });
        recordWebhookPayload(db, record.reference, { event, data: record.raw });
      }
    }

    res.sendStatus(200);
  } catch (err) {
    res.status(err.statusCode || 500).json({ error: err.message });
  }
});
