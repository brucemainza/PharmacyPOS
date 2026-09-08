import { Router } from 'express';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import {
  getDb,
  mapProduct,
  mapSupplier,
  mapProductBatch,
  mapStockMovement,
  mapBranch,
  mapStockTransfer,
  mapStockTake,
  recordStockMovement,
} from '../db.js';
import { requirePerm } from '../auth.js';
import { writeAuditLog } from '../audit.js';
import { enqueueSync } from '../../sync-engine/outbox.js';

export default function inventoryRouter(uploadsPath) {
  const router = Router();

  const storage = multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, uploadsPath),
    filename: (_req, _file, cb) => cb(null, `${Date.now()}.jpg`),
  });
  const upload = multer({ storage });

  router.get('/products', (_req, res) => {
    const rows = getDb().prepare('SELECT * FROM products ORDER BY name').all();
    res.json(rows.map(mapProduct));
  });

  router.get('/product/:productId', (req, res) => {
    const row = getDb()
      .prepare('SELECT * FROM products WHERE id = ?')
      .get(parseInt(req.params.productId, 10));
    res.json(mapProduct(row));
  });

  router.post('/product/sku', (req, res) => {
    const sku = req.body?.skuCode;
    const row = getDb()
      .prepare('SELECT * FROM products WHERE id = ? OR name = ?')
      .get(parseInt(sku, 10) || -1, String(sku || ''));
    res.json(mapProduct(row));
  });

  router.post(
    '/product',
    requirePerm('perm_products'),
    upload.single('imagename'),
    (req, res) => {
      const body = req.body || {};
      let image = body.img || '';

      if (req.file) {
        image = req.file.filename;
      }

      if (String(body.remove) === '1' && body.img) {
        const oldPath = path.join(uploadsPath, body.img);
        try {
          if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        } catch (err) {
          console.error(err);
        }
        if (!req.file) image = '';
      }

      const stock = body.stock === 'on' || body.stock === 0 || body.stock === '0' ? 0 : 1;
      const quantity = body.quantity === '' || body.quantity == null ? 0 : parseInt(body.quantity, 10);
      const controlledSubstance = body.controlled_substance === '1' || body.controlled_substance === 'true' ? 1 : 0;
      const genericGroup = body.generic_group || '';
      const reorderLevel = body.reorder_level === '' || body.reorder_level == null ? 0 : parseInt(body.reorder_level, 10);
      const supplierId = body.supplier_id ? parseInt(body.supplier_id, 10) : null;

      if (!body.id) {
        const result = getDb()
          .prepare(
            `INSERT INTO products (name, price, category, quantity, stock, img,
              controlled_substance, generic_group, reorder_level, supplier_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            body.name,
            parseFloat(body.price) || 0,
            body.category || '',
            quantity,
            stock,
            image,
            controlledSubstance,
            genericGroup,
            reorderLevel,
            supplierId
          );
        const row = getDb().prepare('SELECT * FROM products WHERE id = ?').get(result.lastInsertRowid);
        return res.json(mapProduct(row));
      }

      const id = parseInt(body.id, 10);
      getDb()
        .prepare(
          `UPDATE products SET name = ?, price = ?, category = ?, quantity = ?, stock = ?, img = ?,
            controlled_substance = ?, generic_group = ?, reorder_level = ?, supplier_id = ?
           WHERE id = ?`
        )
        .run(
          body.name,
          parseFloat(body.price) || 0,
          body.category || '',
          quantity,
          stock,
          image,
          controlledSubstance,
          genericGroup,
          reorderLevel,
          supplierId,
          id
        );
      const row = getDb().prepare('SELECT * FROM products WHERE id = ?').get(id);
      res.json(mapProduct(row));
    }
  );

  router.delete('/product/:productId', requirePerm('perm_products'), (req, res) => {
    const id = parseInt(req.params.productId, 10);
    const row = getDb().prepare('SELECT img FROM products WHERE id = ?').get(id);
    getDb().prepare('DELETE FROM products WHERE id = ?').run(id);
    if (row?.img) {
      const imgPath = path.join(uploadsPath, row.img);
      try {
        if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
      } catch (err) {
        console.error(err);
      }
    }
    res.sendStatus(200);
  });

  router.post('/products/bulk-delete', requirePerm('perm_products'), (req, res) => {
    const ids = (req.body?.ids || [])
      .map((id) => parseInt(id, 10))
      .filter((id) => Number.isFinite(id) && id > 0);
    if (!ids.length) {
      return res.status(400).json({ error: 'No product ids provided' });
    }

    const db = getDb();
    let deleted = 0;
    db.transaction(() => {
      const getImg = db.prepare('SELECT img FROM products WHERE id = ?');
      const del = db.prepare('DELETE FROM products WHERE id = ?');
      for (const id of ids) {
        const row = getImg.get(id);
        const result = del.run(id);
        if (result.changes) deleted += 1;
        if (row?.img) {
          const imgPath = path.join(uploadsPath, row.img);
          try {
            if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
          } catch (err) {
            console.error(err);
          }
        }
      }
    })();

    res.json({ ok: true, deleted });
  });

  // ---- Suppliers ----

  router.get('/suppliers', (_req, res) => {
    const rows = getDb().prepare('SELECT * FROM suppliers ORDER BY name').all();
    res.json(rows.map(mapSupplier));
  });

  router.post('/supplier', requirePerm('perm_products'), (req, res) => {
    const body = req.body || {};
    const db = getDb();
    if (!body.name) return res.status(400).json({ error: 'name is required' });

    if (!body.id) {
      const result = db
        .prepare('INSERT INTO suppliers (name, contact, email, phone, address) VALUES (?, ?, ?, ?, ?)')
        .run(body.name, body.contact || '', body.email || '', body.phone || '', body.address || '');
      return res.json(mapSupplier(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(result.lastInsertRowid)));
    }
    db.prepare('UPDATE suppliers SET name = ?, contact = ?, email = ?, phone = ?, address = ? WHERE id = ?').run(
      body.name,
      body.contact || '',
      body.email || '',
      body.phone || '',
      body.address || '',
      parseInt(body.id, 10)
    );
    res.json(mapSupplier(db.prepare('SELECT * FROM suppliers WHERE id = ?').get(parseInt(body.id, 10))));
  });

  router.delete('/supplier/:id', requirePerm('perm_products'), (req, res) => {
    getDb().prepare('DELETE FROM suppliers WHERE id = ?').run(parseInt(req.params.id, 10));
    res.sendStatus(200);
  });

  // ---- Batches / expiry ----

  router.get('/batches', (req, res) => {
    const db = getDb();
    const productId = parseInt(req.query.productId, 10) || null;
    const nearExpiryDays = req.query.nearExpiryDays ? parseInt(req.query.nearExpiryDays, 10) : null;

    let sql = `SELECT b.*, p.name AS product_name FROM product_batches b
               JOIN products p ON p.id = b.product_id`;
    // Every GRN line creates a product_batches row (for cost tracking), but this listing is
    // for lot/expiry tracking specifically, so only surface rows that actually carry a batch no.
    const clauses = ["b.batch_no != ''"];
    const params = [];
    if (productId) {
      clauses.push('b.product_id = ?');
      params.push(productId);
    }
    if (nearExpiryDays != null) {
      const cutoff = new Date(Date.now() + nearExpiryDays * 86400000).toISOString().slice(0, 10);
      clauses.push("b.expiry_date != '' AND b.expiry_date <= ?");
      params.push(cutoff);
    }
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY b.expiry_date ASC';

    const rows = db.prepare(sql).all(...params);
    res.json(rows.map((row) => ({ ...mapProductBatch(row), product_name: row.product_name })));
  });

  // ---- Goods receiving (GRN) ----

  router.post('/grn', requirePerm('perm_products'), (req, res) => {
    const db = getDb();
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const supplierId = body.supplier_id ? parseInt(body.supplier_id, 10) : null;

    if (!items.length) return res.status(400).json({ error: 'At least one line item is required' });

    const now = new Date().toISOString();
    const receivedBatches = [];

    const run = db.transaction(() => {
      for (const item of items) {
        const productId = parseInt(item.product_id, 10);
        const qty = parseInt(item.qty, 10) || 0;
        if (!productId || qty <= 0) continue;

        // Every receipt gets a product_batches row so unit cost is always tracked for
        // profit/margin and stock-valuation reporting, even for products the pharmacy
        // doesn't lot/expiry-track (batch_no left blank in that case).
        const unitCost = parseFloat(item.unit_cost) || 0;
        const result = db
          .prepare(
            `INSERT INTO product_batches (product_id, batch_no, expiry_date, qty_on_hand, unit_cost, supplier_id, received_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`
          )
          .run(productId, item.batch_no ? String(item.batch_no) : '', item.expiry_date || '', qty, unitCost, supplierId, now);
        const batchId = result.lastInsertRowid;
        receivedBatches.push(batchId);
        if (item.batch_no) {
          db.prepare('UPDATE products SET batch_tracked = 1 WHERE id = ?').run(productId);
        }

        recordStockMovement(db, {
          productId,
          batchId,
          movementType: 'goods_receipt',
          qtyDelta: qty,
          refType: 'grn',
          refId: supplierId,
          userId: req.user.id,
          notes: '',
        });
        db.prepare('UPDATE products SET quantity = quantity + ? WHERE id = ?').run(qty, productId);
      }

      writeAuditLog(db, {
        entityType: 'stock_movements',
        entityId: null,
        action: 'goods_receipt',
        userId: req.user.id,
        before: null,
        after: { supplierId, items },
      });
      enqueueSync(db, 'stock_movements', 0, 'insert', { type: 'grn', supplierId, items, createdAt: now });
    });

    run();
    res.json({ ok: true, batches: receivedBatches });
  });

  // ---- Reorder suggestions ----

  router.get('/reorder-suggestions', (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT * FROM products WHERE reorder_level > 0 AND quantity <= reorder_level ORDER BY name`
      )
      .all();
    res.json(
      rows.map((row) => ({
        ...mapProduct(row),
        suggested_qty: Math.max(row.reorder_level * 2 - row.quantity, row.reorder_level),
      }))
    );
  });

  // ---- Manual stock adjustments ----

  router.post('/adjustment', requirePerm('perm_products'), (req, res) => {
    const db = getDb();
    const body = req.body || {};
    const productId = parseInt(body.product_id, 10);
    const qtyDelta = parseInt(body.qty_delta, 10);
    if (!productId || !qtyDelta) {
      return res.status(400).json({ error: 'product_id and a non-zero qty_delta are required' });
    }
    if (!body.reason) return res.status(400).json({ error: 'reason is required for a manual adjustment' });

    const now = new Date().toISOString();
    const run = db.transaction(() => {
      recordStockMovement(db, {
        productId,
        movementType: 'adjustment',
        qtyDelta,
        refType: 'manual',
        userId: req.user.id,
        notes: body.reason,
      });
      db.prepare('UPDATE products SET quantity = MAX(0, quantity + ?) WHERE id = ?').run(qtyDelta, productId);
      writeAuditLog(db, {
        entityType: 'stock_movements',
        entityId: null,
        action: 'manual_adjustment',
        userId: req.user.id,
        before: null,
        after: { productId, qtyDelta, reason: body.reason },
      });
      enqueueSync(db, 'stock_movements', 0, 'insert', { type: 'adjustment', productId, qtyDelta, createdAt: now });
    });
    run();

    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(productId);
    res.json(mapProduct(product));
  });

  router.get('/movements', (req, res) => {
    const db = getDb();
    const productId = parseInt(req.query.productId, 10) || null;
    let sql = 'SELECT * FROM stock_movements';
    const params = [];
    if (productId) {
      sql += ' WHERE product_id = ?';
      params.push(productId);
    }
    sql += ' ORDER BY created_at DESC LIMIT 200';
    res.json(db.prepare(sql).all(...params).map(mapStockMovement));
  });

  // ---- Branches ----

  router.get('/branches', (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM branches ORDER BY is_local DESC, name').all().map(mapBranch));
  });

  router.post('/branch', requirePerm('perm_products'), (req, res) => {
    const db = getDb();
    const name = req.body?.name;
    if (!name) return res.status(400).json({ error: 'name is required' });
    const now = new Date().toISOString();
    const result = db.prepare('INSERT INTO branches (name, is_local, created_at) VALUES (?, 0, ?)').run(name, now);
    res.json(mapBranch(db.prepare('SELECT * FROM branches WHERE id = ?').get(result.lastInsertRowid)));
  });

  // ---- Branch-to-branch stock transfers ----
  // Local bookkeeping only: creating a transfer decrements this branch's stock immediately
  // (goods physically leave now) and records a 'pending' transfer that syncs out via the
  // outbox. Automatic cross-branch routing (the receiving branch's own instance picking up
  // the transfer from the cloud sync API and crediting its stock) depends on the cloud sync
  // API's multi-branch data model landing in Phase 5 — until then, /transfer/:id/receive lets
  // whichever branch physically receives the goods record that receipt locally.

  router.post('/transfer', requirePerm('perm_products'), (req, res) => {
    const db = getDb();
    const body = req.body || {};
    const items = Array.isArray(body.items) ? body.items : [];
    const toBranchId = parseInt(body.to_branch_id, 10);
    if (!toBranchId) return res.status(400).json({ error: 'to_branch_id is required' });
    if (!items.length) return res.status(400).json({ error: 'At least one line item is required' });

    const localBranch = db.prepare('SELECT id FROM branches WHERE is_local = 1').get();
    const now = new Date().toISOString();

    const run = db.transaction(() => {
      const result = db
        .prepare(
          `INSERT INTO stock_transfers (from_branch_id, to_branch_id, status, notes, created_by, created_at)
           VALUES (?, ?, 'pending', ?, ?, ?)`
        )
        .run(localBranch.id, toBranchId, body.notes || '', req.user.id, now);
      const transferId = result.lastInsertRowid;

      for (const item of items) {
        const productId = parseInt(item.product_id, 10);
        const qty = parseInt(item.qty, 10) || 0;
        if (!productId || qty <= 0) continue;

        db.prepare(
          'INSERT INTO stock_transfer_items (stock_transfer_id, product_id, batch_id, qty) VALUES (?, ?, ?, ?)'
        ).run(transferId, productId, item.batch_id || null, qty);

        recordStockMovement(db, {
          productId,
          batchId: item.batch_id || null,
          movementType: 'transfer_out',
          qtyDelta: -qty,
          refType: 'stock_transfer',
          refId: transferId,
          userId: req.user.id,
          notes: `To branch ${toBranchId}`,
        });
        db.prepare('UPDATE products SET quantity = MAX(0, quantity - ?) WHERE id = ?').run(qty, productId);
      }

      writeAuditLog(db, {
        entityType: 'stock_transfers',
        entityId: transferId,
        action: 'transfer_out',
        userId: req.user.id,
        before: null,
        after: { toBranchId, items },
      });
      enqueueSync(db, 'stock_transfers', transferId, 'insert', { toBranchId, items, createdAt: now });
      return transferId;
    });

    const id = run();
    res.json(mapStockTransfer(db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(id)));
  });

  router.get('/transfers', (req, res) => {
    const db = getDb();
    const status = req.query.status ? String(req.query.status) : null;
    let sql = 'SELECT * FROM stock_transfers';
    const params = [];
    if (status) {
      sql += ' WHERE status = ?';
      params.push(status);
    }
    sql += ' ORDER BY created_at DESC';
    res.json(db.prepare(sql).all(...params).map(mapStockTransfer));
  });

  router.get('/transfer/:id', (req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const row = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(id);
    if (!row) return res.status(404).json({ error: 'Transfer not found' });
    const items = db
      .prepare(
        `SELECT ti.*, p.name AS product_name FROM stock_transfer_items ti
         JOIN products p ON p.id = ti.product_id WHERE ti.stock_transfer_id = ?`
      )
      .all(id);
    res.json({ ...mapStockTransfer(row), items: items.map((it) => ({ ...it, product_name: it.product_name })) });
  });

  router.post('/transfer/:id/receive', requirePerm('perm_products'), (req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const transfer = db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found' });
    if (transfer.status === 'received') return res.status(400).json({ error: 'Transfer already received' });

    const items = db.prepare('SELECT * FROM stock_transfer_items WHERE stock_transfer_id = ?').all(id);
    const now = new Date().toISOString();

    db.transaction(() => {
      for (const item of items) {
        recordStockMovement(db, {
          productId: item.product_id,
          batchId: item.batch_id,
          movementType: 'transfer_in',
          qtyDelta: item.qty,
          refType: 'stock_transfer',
          refId: id,
          userId: req.user.id,
          notes: `From branch ${transfer.from_branch_id}`,
        });
        db.prepare('UPDATE products SET quantity = quantity + ? WHERE id = ?').run(item.qty, item.product_id);
      }
      db.prepare(
        "UPDATE stock_transfers SET status = 'received', received_by = ?, received_at = ? WHERE id = ?"
      ).run(req.user.id, now, id);
      writeAuditLog(db, {
        entityType: 'stock_transfers',
        entityId: id,
        action: 'transfer_in',
        userId: req.user.id,
        before: { status: transfer.status },
        after: { status: 'received' },
      });
      enqueueSync(db, 'stock_transfers', id, 'update', { status: 'received', receivedAt: now });
    })();

    res.json(mapStockTransfer(db.prepare('SELECT * FROM stock_transfers WHERE id = ?').get(id)));
  });

  // ---- Stock takes / cycle counts ----

  router.post('/stock-take', requirePerm('perm_products'), (req, res) => {
    const db = getDb();
    const businessDate = req.body?.business_date || new Date().toISOString().slice(0, 10);
    const now = new Date().toISOString();

    const id = db.transaction(() => {
      const result = db
        .prepare("INSERT INTO stock_takes (business_date, status, created_by, created_at) VALUES (?, 'open', ?, ?)")
        .run(businessDate, req.user.id, now);
      const takeId = result.lastInsertRowid;
      const products = db.prepare('SELECT id, quantity FROM products WHERE stock = 1').all();
      const insertItem = db.prepare(
        'INSERT INTO stock_take_items (stock_take_id, product_id, expected_qty) VALUES (?, ?, ?)'
      );
      for (const p of products) insertItem.run(takeId, p.id, p.quantity);
      return takeId;
    })();

    res.json(withStockTakeItems(db, id));
  });

  function withStockTakeItems(db, id) {
    const take = db.prepare('SELECT * FROM stock_takes WHERE id = ?').get(id);
    if (!take) return null;
    const items = db
      .prepare(
        `SELECT sti.*, p.name AS product_name FROM stock_take_items sti
         JOIN products p ON p.id = sti.product_id WHERE sti.stock_take_id = ? ORDER BY p.name`
      )
      .all(id);
    return { ...mapStockTake(take), items };
  }

  router.get('/stock-takes', (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM stock_takes ORDER BY created_at DESC').all().map(mapStockTake));
  });

  router.get('/stock-take/:id', (req, res) => {
    const result = withStockTakeItems(getDb(), parseInt(req.params.id, 10));
    if (!result) return res.status(404).json({ error: 'Stock take not found' });
    res.json(result);
  });

  router.put('/stock-take/:id/item/:itemId', requirePerm('perm_products'), (req, res) => {
    const db = getDb();
    const countedQty = parseInt(req.body?.counted_qty, 10);
    if (!Number.isFinite(countedQty) || countedQty < 0) {
      return res.status(400).json({ error: 'counted_qty must be a non-negative number' });
    }
    const item = db
      .prepare('SELECT * FROM stock_take_items WHERE id = ? AND stock_take_id = ?')
      .get(parseInt(req.params.itemId, 10), parseInt(req.params.id, 10));
    if (!item) return res.status(404).json({ error: 'Stock take item not found' });

    db.prepare('UPDATE stock_take_items SET counted_qty = ?, variance = ? WHERE id = ?').run(
      countedQty,
      countedQty - item.expected_qty,
      item.id
    );
    res.json(withStockTakeItems(db, parseInt(req.params.id, 10)));
  });

  router.post('/stock-take/:id/complete', requirePerm('perm_products'), (req, res) => {
    const db = getDb();
    const id = parseInt(req.params.id, 10);
    const take = db.prepare('SELECT * FROM stock_takes WHERE id = ?').get(id);
    if (!take) return res.status(404).json({ error: 'Stock take not found' });
    if (take.status === 'completed') return res.status(400).json({ error: 'Stock take already completed' });

    const items = db.prepare('SELECT * FROM stock_take_items WHERE stock_take_id = ?').all(id);
    const now = new Date().toISOString();
    const varianceReport = [];

    db.transaction(() => {
      for (const item of items) {
        if (item.counted_qty == null) continue;
        const variance = item.counted_qty - item.expected_qty;
        varianceReport.push({ productId: item.product_id, expected: item.expected_qty, counted: item.counted_qty, variance });
        if (variance !== 0) {
          recordStockMovement(db, {
            productId: item.product_id,
            movementType: 'adjustment',
            qtyDelta: variance,
            refType: 'stock_take',
            refId: id,
            userId: req.user.id,
            notes: `Stock take #${id} variance`,
          });
          db.prepare('UPDATE products SET quantity = ? WHERE id = ?').run(item.counted_qty, item.product_id);
        }
      }
      db.prepare("UPDATE stock_takes SET status = 'completed', completed_at = ? WHERE id = ?").run(now, id);
      writeAuditLog(db, {
        entityType: 'stock_takes',
        entityId: id,
        action: 'stock_take_completed',
        userId: req.user.id,
        before: null,
        after: { varianceReport },
      });
      enqueueSync(db, 'stock_takes', id, 'update', { status: 'completed', completedAt: now });
    })();

    res.json({ ...withStockTakeItems(db, id), variance_report: varianceReport });
  });

  return router;
}
