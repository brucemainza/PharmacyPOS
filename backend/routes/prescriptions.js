import { Router } from 'express';
import {
  getDb,
  mapPrescription,
  mapPrescriptionItem,
  recordStockMovement,
} from '../db.js';
import { requirePerm } from '../auth.js';
import { writeAuditLog } from '../audit.js';
import { enqueueSync } from '../../sync-engine/outbox.js';

const router = Router();

function withItems(db, prescriptionRow) {
  const rows = db
    .prepare(
      `SELECT pi.*, p.name AS product_name, p.controlled_substance AS product_controlled,
              p.generic_group AS product_generic_group
       FROM prescription_items pi
       JOIN products p ON p.id = pi.product_id
       WHERE pi.prescription_id = ?
       ORDER BY pi.id`
    )
    .all(prescriptionRow.id);

  return {
    ...mapPrescription(prescriptionRow),
    items: rows.map((row) => ({
      ...mapPrescriptionItem(row),
      product_name: row.product_name,
      product_controlled: !!row.product_controlled,
      generic_group: row.product_generic_group,
      remaining_qty: row.prescribed_qty - row.dispensed_qty,
    })),
  };
}

router.get('/all', requirePerm('perm_transactions'), (req, res) => {
  const db = getDb();
  const patientId = parseInt(req.query.patientId, 10) || null;
  const status = req.query.status ? String(req.query.status) : null;

  let sql = 'SELECT * FROM prescriptions';
  const clauses = [];
  const params = [];
  if (patientId) {
    clauses.push('patient_id = ?');
    params.push(patientId);
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
  sql += ' ORDER BY created_at DESC';

  const rows = db.prepare(sql).all(...params);
  res.json(rows.map((row) => withItems(db, row)));
});

router.get('/:id', requirePerm('perm_transactions'), (req, res) => {
  const db = getDb();
  const row = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(parseInt(req.params.id, 10));
  if (!row) return res.status(404).json({ error: 'Prescription not found' });
  res.json(withItems(db, row));
});

router.post('/', requirePerm('perm_transactions'), (req, res) => {
  const db = getDb();
  const body = req.body || {};
  const items = Array.isArray(body.items) ? body.items : [];

  if (!body.patient_id) return res.status(400).json({ error: 'patient_id is required' });
  if (!items.length) return res.status(400).json({ error: 'At least one prescription item is required' });

  const now = new Date().toISOString();
  const insert = db.transaction(() => {
    const result = db
      .prepare(
        `INSERT INTO prescriptions (patient_id, prescriber_name, prescriber_reg_no, date, status, notes, created_at)
         VALUES (?, ?, ?, ?, 'open', ?, ?)`
      )
      .run(
        parseInt(body.patient_id, 10),
        body.prescriber_name || '',
        body.prescriber_reg_no || '',
        body.date || now,
        body.notes || '',
        now
      );
    const prescriptionId = result.lastInsertRowid;

    for (const item of items) {
      const productId = parseInt(item.product_id, 10);
      const qty = parseInt(item.prescribed_qty, 10) || 0;
      if (!productId || !qty) continue;
      // A line for a product that doesn't exist would otherwise silently disappear from
      // withItems()'s response (it inner-joins products) and could never be dispensed —
      // skip it here instead of accepting it and hiding the problem.
      if (!db.prepare('SELECT id FROM products WHERE id = ?').get(productId)) continue;
      db.prepare(
        `INSERT INTO prescription_items (prescription_id, product_id, prescribed_qty, dispensed_qty, partial_fill_state)
         VALUES (?, ?, ?, 0, 'none')`
      ).run(prescriptionId, productId, qty);
    }

    enqueueSync(db, 'prescriptions', prescriptionId, 'insert', {
      patientId: body.patient_id,
      createdAt: now,
    });
    return prescriptionId;
  });

  const id = insert();
  const row = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(id);
  res.json(withItems(db, row));
});

router.put('/:id', requirePerm('perm_transactions'), (req, res) => {
  const db = getDb();
  const id = parseInt(req.params.id, 10);
  const body = req.body || {};
  const existing = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Prescription not found' });

  db.prepare('UPDATE prescriptions SET notes = ?, status = ? WHERE id = ?').run(
    body.notes ?? existing.notes,
    body.status ?? existing.status,
    id
  );
  const row = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(id);
  res.json(withItems(db, row));
});

// The compliance-sensitive core of this feature: dispensing a line item (fully or partially),
// with generic substitution requiring a pharmacist/manager/admin/tech and controlled substances
// requiring a *second* authorized approver on top of whoever is dispensing — see
// docs/architecture/functionality.md's "Dispensing a Prescription" and
// "Controlled-Substance Dispensing" sections.
router.post('/:id/items/:itemId/dispense', requirePerm('perm_transactions'), (req, res) => {
  const db = getDb();
  const prescriptionId = parseInt(req.params.id, 10);
  const itemId = parseInt(req.params.itemId, 10);
  const body = req.body || {};
  const dispenseQty = parseInt(body.dispensed_qty, 10) || 0;
  const substitutedProductId = body.substituted_product_id
    ? parseInt(body.substituted_product_id, 10)
    : null;
  const transactionId = body.transaction_id ? parseInt(body.transaction_id, 10) : null;
  const approvingUserId = body.approving_user_id ? parseInt(body.approving_user_id, 10) : null;

  const item = db
    .prepare('SELECT * FROM prescription_items WHERE id = ? AND prescription_id = ?')
    .get(itemId, prescriptionId);
  if (!item) return res.status(404).json({ error: 'Prescription item not found' });
  if (dispenseQty <= 0) return res.status(400).json({ error: 'dispensed_qty must be positive' });

  const remaining = item.prescribed_qty - item.dispensed_qty;
  if (dispenseQty > remaining) {
    return res.status(400).json({ error: `Cannot dispense more than the remaining ${remaining} unit(s)` });
  }

  const effectiveProductId = substitutedProductId || item.product_id;
  const product = db.prepare('SELECT * FROM products WHERE id = ?').get(effectiveProductId);
  if (!product) return res.status(404).json({ error: 'Product not found' });

  // The prescribed/remaining quantity check above only guards against over-dispensing a
  // prescription; it says nothing about whether the pharmacy actually has that much physical
  // stock. Check separately so running out of a medicine produces a clear, actionable error
  // instead of silently clamping the stock ledger to zero.
  if (product.stock !== 0 && product.quantity < dispenseQty) {
    return res.status(400).json({
      error: `Not enough stock of ${product.name} to dispense ${dispenseQty} unit(s) (${product.quantity} available)`,
    });
  }

  if (substitutedProductId && substitutedProductId !== item.product_id) {
    const requester = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.user.id);
    const canApproveSubstitution =
      req.user.id === 1 ||
      requester?.role === 'pharmacist' ||
      requester?.role === 'manager' ||
      requester?.role === 'admin' ||
      requester?.role === 'tech';
    if (!canApproveSubstitution) {
      return res.status(403).json({ error: 'Generic substitution requires a pharmacist or manager' });
    }
  }

  if (product.controlled_substance) {
    if (!approvingUserId) {
      return res.status(403).json({
        error: 'Controlled-substance dispensing requires a second approving user',
      });
    }
    const approver = db
      .prepare('SELECT id, perm_controlled_approve FROM users WHERE id = ?')
      .get(approvingUserId);
    if (!approver || (approver.id !== 1 && !approver.perm_controlled_approve)) {
      return res
        .status(403)
        .json({ error: 'Selected approver is not authorized to approve controlled-substance dispensing' });
    }
  }

  const now = new Date().toISOString();
  const run = db.transaction(() => {
    const totalDispensed = item.dispensed_qty + dispenseQty;
    const fillState = totalDispensed >= item.prescribed_qty ? 'complete' : 'partial';

    db.prepare(
      `UPDATE prescription_items
       SET dispensed_qty = ?, substituted_product_id = ?, partial_fill_state = ?, pharmacist_user_id = ?, approved_at = ?
       WHERE id = ?`
    ).run(totalDispensed, substitutedProductId, fillState, req.user.id, now, itemId);

    recordStockMovement(db, {
      productId: effectiveProductId,
      movementType: product.controlled_substance ? 'controlled_dispense' : 'sale',
      qtyDelta: -dispenseQty,
      refType: 'prescription',
      refId: prescriptionId,
      userId: req.user.id,
      notes: substitutedProductId ? `Substituted for product ${item.product_id}` : '',
    });
    db.prepare('UPDATE products SET quantity = MAX(0, quantity - ?) WHERE id = ?').run(
      dispenseQty,
      effectiveProductId
    );

    if (product.controlled_substance) {
      const prescription = db
        .prepare('SELECT patient_id FROM prescriptions WHERE id = ?')
        .get(prescriptionId);
      const logResult = db
        .prepare(
          `INSERT INTO controlled_substance_log
            (prescription_item_id, transaction_id, product_id, qty, dispensing_user_id, approving_user_id, patient_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          itemId,
          transactionId,
          effectiveProductId,
          dispenseQty,
          req.user.id,
          approvingUserId,
          prescription.patient_id,
          now
        );
      writeAuditLog(db, {
        entityType: 'controlled_substance_log',
        entityId: logResult.lastInsertRowid,
        action: 'controlled_dispense',
        userId: req.user.id,
        before: null,
        after: {
          prescriptionId,
          itemId,
          productId: effectiveProductId,
          qty: dispenseQty,
          approvingUserId,
          transactionId,
        },
      });
      enqueueSync(db, 'controlled_substance_log', logResult.lastInsertRowid, 'insert', {
        prescriptionId,
        itemId,
        productId: effectiveProductId,
        qty: dispenseQty,
        createdAt: now,
      });
    }

    const remainingItems = db
      .prepare(
        'SELECT COUNT(*) AS c FROM prescription_items WHERE prescription_id = ? AND dispensed_qty < prescribed_qty'
      )
      .get(prescriptionId);
    db.prepare('UPDATE prescriptions SET status = ? WHERE id = ?').run(
      remainingItems.c === 0 ? 'completed' : 'partially_filled',
      prescriptionId
    );

    enqueueSync(db, 'prescription_items', itemId, 'update', {
      prescriptionId,
      itemId,
      dispensedQty: totalDispensed,
      fillState,
      updatedAt: now,
    });
  });

  run();

  const row = db.prepare('SELECT * FROM prescriptions WHERE id = ?').get(prescriptionId);
  res.json(withItems(db, row));
});

export default router;
