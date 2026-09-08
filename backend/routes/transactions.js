import { Router } from 'express';
import { getDb, mapTransaction, mapCashUp, recordStockMovement } from '../db.js';
import { requirePerm } from '../auth.js';
import { writeAuditLog } from '../audit.js';
import { enqueueSync } from '../../sync-engine/outbox.js';

const router = Router();

function decrementInventory(items, db) {
  for (const item of items || []) {
    const id = parseInt(item.id ?? item._id, 10);
    const qty = parseInt(item.quantity, 10) || 0;
    if (!id || !qty) continue;
    const product = db.prepare('SELECT id, quantity, stock FROM products WHERE id = ?').get(id);
    if (!product || product.stock === 0) continue;
    const updated = Math.max(0, (product.quantity || 0) - qty);
    db.prepare('UPDATE products SET quantity = ? WHERE id = ?').run(updated, id);
  }
}

// Server-side stock check, mirroring exactly which items decrementInventory() would actually
// touch (skips unlimited-stock items and unknown product ids the same way) — so a sale never
// silently under-fulfills by clamping a short item to zero. Ringing up more than is physically
// on the shelf is rejected up front instead, with enough detail to fix the cart.
function findInsufficientStock(items, db) {
  const shortfalls = [];
  for (const item of items || []) {
    const id = parseInt(item.id ?? item._id, 10);
    const qty = parseInt(item.quantity, 10) || 0;
    if (!id || !qty) continue;
    const product = db.prepare('SELECT id, name, quantity, stock FROM products WHERE id = ?').get(id);
    if (!product || product.stock === 0) continue;
    if (product.quantity < qty) {
      shortfalls.push({ id: product.id, name: product.name, available: product.quantity, requested: qty });
    }
  }
  return shortfalls;
}

// A return/void restocks the *actual* items being returned, appending to the ledger rather than
// setting an absolute quantity — same append-only discipline as the rest of Phase 1's inventory
// model, even though `products.quantity` (the legacy cache) is still bumped directly here until
// Phase 3's Inventory slice fully switches reads over to the ledger.
function restockItems(db, items, { movementType, refType, refId, userId, notes }) {
  for (const item of items || []) {
    const productId = parseInt(item.id ?? item._id, 10);
    const qty = parseInt(item.quantity, 10) || 0;
    if (!productId || !qty) continue;
    const product = db.prepare('SELECT quantity, stock FROM products WHERE id = ?').get(productId);
    if (!product || product.stock === 0) continue; // unlimited-stock item, nothing to restock
    db.prepare('UPDATE products SET quantity = quantity + ? WHERE id = ?').run(qty, productId);
    recordStockMovement(db, {
      productId,
      movementType,
      qtyDelta: qty,
      refType,
      refId,
      userId,
      notes,
    });
  }
}

// Awards loyalty points on a completed sale for a real (non walk-in/none) customer. Points are
// system-managed accrual only — nothing here lets a sale redeem points against the total yet.
function awardLoyaltyPoints(db, customerId, total) {
  const custId = parseInt(customerId, 10);
  if (!custId || total <= 0) return 0;
  const settings = db.prepare('SELECT loyalty_earn_rate FROM settings WHERE id = 1').get();
  const rate = settings?.loyalty_earn_rate ?? 0.1;
  const earned = Math.floor(total * rate);
  if (earned > 0) {
    db.prepare('UPDATE customers SET loyalty_points = loyalty_points + ? WHERE id = ?').run(earned, custId);
  }
  return earned;
}

// A discount above the configured threshold needs a second, authorized person's sign-off —
// checked server-side so the rule can't be bypassed by a modified client request.
function validateDiscountApproval(db, { subtotal, discount, discountApprovedBy }) {
  if (!discount || discount <= 0 || !subtotal) {
    return { ok: true, approvedBy: null };
  }
  const settings = db.prepare('SELECT discount_approval_threshold FROM settings WHERE id = 1').get();
  const threshold = settings?.discount_approval_threshold ?? 10;
  const pct = (discount / subtotal) * 100;
  if (pct <= threshold) {
    return { ok: true, approvedBy: discountApprovedBy || null };
  }
  if (!discountApprovedBy) {
    return {
      ok: false,
      error: `Discount of ${pct.toFixed(1)}% exceeds the ${threshold}% approval threshold — manager authorization required`,
    };
  }
  const approver = db
    .prepare('SELECT id, perm_discount_approve FROM users WHERE id = ?')
    .get(parseInt(discountApprovedBy, 10));
  if (!approver || (approver.id !== 1 && !approver.perm_discount_approve)) {
    return { ok: false, error: 'Selected approver is not authorized to approve discounts' };
  }
  return { ok: true, approvedBy: approver.id };
}

function computeCashUpTotals(db, till, date) {
  const dayStart = new Date(`${date}T00:00:00`).toISOString();
  const dayEnd = new Date(`${date}T23:59:59.999`).toISOString();

  const paidRows = db
    .prepare(`SELECT * FROM transactions WHERE till = ? AND date >= ? AND date <= ? AND status = 1`)
    .all(till, dayStart, dayEnd);
  const refundRows = db
    .prepare(`SELECT * FROM transactions WHERE till = ? AND date >= ? AND date <= ? AND status = 3`)
    .all(till, dayStart, dayEnd);

  let salesTotal = 0;
  let cashTotal = 0;
  let cardTotal = 0;
  let mobileMoneyTotal = 0;
  for (const t of paidRows) {
    salesTotal += t.total;
    if (t.payment_type === 1) cashTotal += t.paid - t.change;
    else if (t.payment_type === 3) cardTotal += t.total;
    else if (t.payment_type === 4) mobileMoneyTotal += t.total;
  }
  const refundsTotal = refundRows.reduce((sum, t) => sum + t.total, 0);

  return {
    salesTotal,
    cashTotal,
    cardTotal,
    mobileMoneyTotal,
    refundsTotal,
    transactionCount: paidRows.length,
    // Simplification, documented in docs/architecture/functionality.md's "End-of-Day Cash-Up"
    // section: assumes refunds on
    // this till are paid out of the cash drawer. A refund settled back to a card/mobile-money
    // provider instead would need to be excluded here — not distinguished yet.
    expectedCash: cashTotal - refundsTotal,
  };
}

router.get('/all', requirePerm('perm_transactions'), (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM transactions ORDER BY date DESC').all();
  res.json(rows.map(mapTransaction));
});

router.get('/on-hold', (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT * FROM transactions
       WHERE ref_number != '' AND status = 0
       ORDER BY date DESC`
    )
    .all();
  res.json(rows.map(mapTransaction));
});

router.get('/customer-orders', (_req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT * FROM transactions
       WHERE customer != '0' AND status = 0 AND (ref_number IS NULL OR ref_number = '')
       ORDER BY date DESC`
    )
    .all();
  res.json(rows.map(mapTransaction));
});

router.get('/by-date', requirePerm('perm_transactions'), (req, res) => {
  const startDate = new Date(String(req.query.start || ''));
  const endDate = new Date(String(req.query.end || ''));
  if (Number.isNaN(startDate.getTime()) || Number.isNaN(endDate.getTime())) {
    return res.status(400).json({ error: 'Invalid start or end date' });
  }

  const start = startDate.toISOString();
  const end = endDate.toISOString();
  const statusRaw = parseInt(String(req.query.status), 10);
  const status = Number.isFinite(statusRaw) ? statusRaw : 1;
  const userId = parseInt(String(req.query.user), 10) || 0;
  const till = parseInt(String(req.query.till), 10) || 0;

  let sql = `SELECT * FROM transactions WHERE date >= ? AND date <= ? AND status = ?`;
  const params = [start, end, status];

  if (userId) {
    sql += ' AND user_id = ?';
    params.push(userId);
  }
  if (till) {
    sql += ' AND till = ?';
    params.push(till);
  }
  sql += ' ORDER BY date DESC';

  const rows = getDb().prepare(sql).all(...params);
  res.json(rows.map(mapTransaction));
});

router.get('/cash-up', requirePerm('perm_transactions'), (req, res) => {
  const till = parseInt(req.query.till, 10) || 1;
  const date = String(req.query.date || new Date().toISOString().slice(0, 10));
  const totals = computeCashUpTotals(getDb(), till, date);
  res.json({
    till,
    date,
    sales_total: totals.salesTotal,
    cash_total: totals.cashTotal,
    card_total: totals.cardTotal,
    mobile_money_total: totals.mobileMoneyTotal,
    refunds_total: totals.refundsTotal,
    transaction_count: totals.transactionCount,
    expected_cash: totals.expectedCash,
  });
});

router.get('/cash-up/history', requirePerm('perm_transactions'), (req, res) => {
  const till = parseInt(req.query.till, 10) || 0;
  const db = getDb();
  const rows = till
    ? db.prepare('SELECT * FROM cash_ups WHERE till = ? ORDER BY created_at DESC LIMIT 50').all(till)
    : db.prepare('SELECT * FROM cash_ups ORDER BY created_at DESC LIMIT 50').all();
  res.json(rows.map(mapCashUp));
});

router.post('/cash-up', requirePerm('perm_transactions'), (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const till = parseInt(body.till, 10) || 1;
  const date = String(body.date || new Date().toISOString().slice(0, 10));
  const counted = parseFloat(body.counted_cash) || 0;
  const notes = String(body.notes || '');

  const totals = computeCashUpTotals(db, till, date);
  const variance = counted - totals.expectedCash;
  const now = new Date().toISOString();

  const insert = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO cash_ups (
          till, business_date, opened_by, sales_total, cash_total, card_total, mobile_money_total,
          refunds_total, transaction_count, expected_cash, counted_cash, variance, notes, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        till,
        date,
        req.user.id,
        totals.salesTotal,
        totals.cashTotal,
        totals.cardTotal,
        totals.mobileMoneyTotal,
        totals.refundsTotal,
        totals.transactionCount,
        totals.expectedCash,
        counted,
        variance,
        notes,
        now
      );
    writeAuditLog(db, {
      entityType: 'cash_up',
      entityId: result.lastInsertRowid,
      action: 'cash_up',
      userId: req.user.id,
      before: null,
      after: { till, date, expected: totals.expectedCash, counted, variance },
    });
    enqueueSync(db, 'cash_ups', result.lastInsertRowid, 'insert', {
      till,
      date,
      expected: totals.expectedCash,
      counted,
      variance,
    });
    return result.lastInsertRowid;
  });

  const id = insert();
  res.json(mapCashUp(db.prepare('SELECT * FROM cash_ups WHERE id = ?').get(id)));
});

router.post('/new', (req, res) => {
  const body = req.body || {};
  const items = body.items || [];
  const paid = parseFloat(body.paid) || 0;
  const total = parseFloat(body.total) || 0;
  const subtotal = parseFloat(body.subtotal) || 0;
  const discount = parseFloat(body.discount) || 0;

  const db = getDb();
  const approval = validateDiscountApproval(db, {
    subtotal,
    discount,
    discountApprovedBy: body.discount_approved_by,
  });
  if (!approval.ok) {
    return res.status(403).json({ error: approval.error });
  }

  const willBePaid = paid >= total && (parseInt(body.status, 10) === 1 || body.status === undefined);
  if (willBePaid) {
    const shortfalls = findInsufficientStock(items, db);
    if (shortfalls.length) {
      return res.status(400).json({
        error: `Not enough stock: ${shortfalls.map((s) => `${s.name} (have ${s.available}, need ${s.requested})`).join(', ')}`,
        shortfalls,
      });
    }
  }

  const insert = db.transaction(() => {
    const isPaid = willBePaid;
    const pointsEarned = isPaid ? awardLoyaltyPoints(db, body.customer, total) : 0;

    const result = db
      .prepare(
        `INSERT INTO transactions (
          ref_number, customer, customer_name, status, user_id, user_name, till,
          discount, subtotal, tax, total, paid, change, payment_type, items_json, date,
          discount_approved_by, loyalty_points_earned
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        body.ref_number || '',
        String(body.customer ?? '0'),
        body.customer_name || '',
        parseInt(body.status, 10) ?? 1,
        parseInt(body.user_id, 10) || 0,
        body.user || body.user_name || '',
        parseInt(body.till, 10) || 1,
        discount,
        subtotal,
        parseFloat(body.tax) || 0,
        total,
        paid,
        parseFloat(body.change) || 0,
        parseInt(body.payment_type, 10) || 1,
        JSON.stringify(items),
        body.date || new Date().toISOString(),
        approval.approvedBy,
        pointsEarned
      );

    if (isPaid) {
      decrementInventory(items, db);
    }
    if (approval.approvedBy) {
      writeAuditLog(db, {
        entityType: 'transaction',
        entityId: result.lastInsertRowid,
        action: 'discount_approved',
        userId: approval.approvedBy,
        before: null,
        after: { transactionId: result.lastInsertRowid, discount, subtotal },
      });
    }

    return result.lastInsertRowid;
  });

  const id = insert();
  res.json({ ok: true, id });
});

router.put('/new', (req, res) => {
  const body = req.body || {};
  const id = parseInt(body._id ?? body.id, 10);
  const items = body.items || [];
  const paid = parseFloat(body.paid) || 0;
  const total = parseFloat(body.total) || 0;
  const subtotal = parseFloat(body.subtotal) || 0;
  const discount = parseFloat(body.discount) || 0;
  const status = parseInt(body.status, 10) ?? 1;

  const db = getDb();
  const approval = validateDiscountApproval(db, {
    subtotal,
    discount,
    discountApprovedBy: body.discount_approved_by,
  });
  if (!approval.ok) {
    return res.status(403).json({ error: approval.error });
  }

  const existingBefore = db.prepare('SELECT status FROM transactions WHERE id = ?').get(id);
  const willCompleteHold = !!(existingBefore && existingBefore.status === 0 && status === 1 && paid >= total);
  if (willCompleteHold) {
    const shortfalls = findInsufficientStock(items, db);
    if (shortfalls.length) {
      return res.status(400).json({
        error: `Not enough stock: ${shortfalls.map((s) => `${s.name} (have ${s.available}, need ${s.requested})`).join(', ')}`,
        shortfalls,
      });
    }
  }

  const update = db.transaction(() => {
    const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
    const completesHold = !!(existing && existing.status === 0 && status === 1 && paid >= total);
    const pointsEarned = completesHold
      ? awardLoyaltyPoints(db, body.customer, total)
      : existing?.loyalty_points_earned || 0;

    db.prepare(
      `UPDATE transactions SET
        ref_number = ?, customer = ?, customer_name = ?, status = ?, user_id = ?, user_name = ?, till = ?,
        discount = ?, subtotal = ?, tax = ?, total = ?, paid = ?, change = ?, payment_type = ?, items_json = ?, date = ?,
        discount_approved_by = ?, loyalty_points_earned = ?
       WHERE id = ?`
    ).run(
      body.ref_number || '',
      String(body.customer ?? '0'),
      body.customer_name || '',
      status,
      parseInt(body.user_id, 10) || 0,
      body.user || body.user_name || '',
      parseInt(body.till, 10) || 1,
      discount,
      subtotal,
      parseFloat(body.tax) || 0,
      total,
      paid,
      parseFloat(body.change) || 0,
      parseInt(body.payment_type, 10) || 1,
      JSON.stringify(items),
      body.date || new Date().toISOString(),
      approval.approvedBy,
      pointsEarned,
      id
    );

    // Decrement stock when completing a previously unpaid/hold order
    if (completesHold) {
      decrementInventory(items, db);
    }
    if (approval.approvedBy) {
      writeAuditLog(db, {
        entityType: 'transaction',
        entityId: id,
        action: 'discount_approved',
        userId: approval.approvedBy,
        before: null,
        after: { transactionId: id, discount, subtotal },
      });
    }
  });

  update();
  res.sendStatus(200);
});

router.post('/void', requirePerm('perm_refund_void'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.body?.transactionId, 10);
  const reason = String(req.body?.reason || '');

  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Transaction not found' });
  if (existing.status === 2 || existing.status === 3) {
    return res.status(400).json({ error: 'Transaction is already voided or refunded' });
  }

  const run = db.transaction(() => {
    if (existing.status === 1) {
      const items = JSON.parse(existing.items_json || '[]');
      restockItems(db, items, {
        movementType: 'refund',
        refType: 'void',
        refId: id,
        userId: req.user.id,
        notes: reason,
      });
    }
    db.prepare('UPDATE transactions SET status = 2, void_refund_reason = ? WHERE id = ?').run(reason, id);
    writeAuditLog(db, {
      entityType: 'transaction',
      entityId: id,
      action: 'void',
      userId: req.user.id,
      before: mapTransaction(existing),
      after: { status: 2, reason },
    });
    enqueueSync(db, 'transactions', id, 'update', {
      id,
      status: 2,
      reason,
      updatedAt: new Date().toISOString(),
    });
  });
  run();

  res.json({ ok: true });
});

router.post('/refund', requirePerm('perm_refund_void'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.body?.transactionId, 10);
  const reason = String(req.body?.reason || '');
  const requestedItems = Array.isArray(req.body?.items) ? req.body.items : null;

  const existing = db.prepare('SELECT * FROM transactions WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Transaction not found' });
  if (existing.status !== 1) {
    return res.status(400).json({ error: 'Only a paid transaction can be refunded' });
  }

  const saleItems = JSON.parse(existing.items_json || '[]');
  const refundLines = requestedItems || saleItems.map((i) => ({ id: i.id ?? i._id, quantity: i.quantity }));

  const run = db.transaction(() => {
    restockItems(db, refundLines, {
      movementType: 'refund',
      refType: 'refund',
      refId: id,
      userId: req.user.id,
      notes: reason,
    });
    db.prepare('UPDATE transactions SET status = 3, void_refund_reason = ? WHERE id = ?').run(reason, id);
    writeAuditLog(db, {
      entityType: 'transaction',
      entityId: id,
      action: 'refund',
      userId: req.user.id,
      before: mapTransaction(existing),
      after: { status: 3, reason, items: refundLines },
    });
    enqueueSync(db, 'transactions', id, 'update', {
      id,
      status: 3,
      reason,
      updatedAt: new Date().toISOString(),
    });
  });
  run();

  res.json({ ok: true });
});

router.post('/delete', (req, res) => {
  const orderId = parseInt(req.body?.orderId ?? req.body?._id, 10);
  getDb().prepare('DELETE FROM transactions WHERE id = ?').run(orderId);
  res.sendStatus(200);
});

router.get('/transaction/:transactionId', (req, res) => {
  const row = getDb()
    .prepare('SELECT * FROM transactions WHERE id = ?')
    .get(parseInt(req.params.transactionId, 10));
  res.json(mapTransaction(row));
});

export default router;
