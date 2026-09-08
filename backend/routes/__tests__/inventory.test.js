import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createServer } from '../../index.js';

async function setupApp() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = path.join(os.tmpdir(), `inv-test-${suffix}.db`);
  const uploadsPath = path.join(os.tmpdir(), `inv-test-uploads-${suffix}`);
  const app = await createServer({ dbPath, uploadsPath, jwtSecret: 'inv-test-secret' });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}.key`, { force: true });
      fs.rmSync(uploadsPath, { recursive: true, force: true });
    },
  };
}

async function login(base, username, password) {
  const res = await fetch(`${base}/api/users/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'login failed');
  return json.token;
}

async function req(base, token, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function createProduct(base, token, { name, price = 5, reorder_level = 0 }) {
  const form = new FormData();
  form.append('name', name);
  form.append('price', String(price));
  form.append('category', 'Test');
  form.append('quantity', '0');
  form.append('stock', '1');
  const res = await fetch(`${base}/api/inventory/product`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const product = await res.json();
  if (reorder_level) {
    const { getDb } = await import('../../db.js');
    getDb().prepare('UPDATE products SET reorder_level = ? WHERE id = ?').run(reorder_level, product.id);
  }
  return product;
}

test('GRN receives stock into a batch and increments product quantity', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const product = await createProduct(app.base, token, { name: 'Amoxicillin' });

    const grn = await req(app.base, token, 'POST', '/api/inventory/grn', {
      items: [{ product_id: product.id, batch_no: 'B100', expiry_date: '2027-06-01', qty: 40, unit_cost: 1.5 }],
    });
    assert.equal(grn.status, 200);
    assert.equal(grn.json.batches.length, 1);

    const updated = await req(app.base, token, 'GET', `/api/inventory/product/${product.id}`);
    assert.equal(updated.json.quantity, 40);
    assert.equal(updated.json.batch_tracked, true);

    const batches = await req(app.base, token, 'GET', `/api/inventory/batches?productId=${product.id}`);
    assert.equal(batches.json.length, 1);
    assert.equal(batches.json[0].batch_no, 'B100');
    assert.equal(batches.json[0].qty_on_hand, 40);
  } finally {
    await app.close();
  }
});

test('near-expiry filter on batches only returns batches expiring within the window', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const product = await createProduct(app.base, token, { name: 'Ibuprofen' });

    const soon = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
    const far = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10);

    await req(app.base, token, 'POST', '/api/inventory/grn', {
      items: [
        { product_id: product.id, batch_no: 'SOON', expiry_date: soon, qty: 10 },
        { product_id: product.id, batch_no: 'FAR', expiry_date: far, qty: 20 },
      ],
    });

    const nearExpiry = await req(app.base, token, 'GET', '/api/inventory/batches?nearExpiryDays=30');
    assert.equal(nearExpiry.json.length, 1);
    assert.equal(nearExpiry.json[0].batch_no, 'SOON');
  } finally {
    await app.close();
  }
});

test('manual stock adjustment requires a reason and moves quantity with an audit trail', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const product = await createProduct(app.base, token, { name: 'Bandages' });
    await req(app.base, token, 'POST', '/api/inventory/grn', {
      items: [{ product_id: product.id, qty: 20 }],
    });

    const noReason = await req(app.base, token, 'POST', '/api/inventory/adjustment', {
      product_id: product.id,
      qty_delta: -5,
    });
    assert.equal(noReason.status, 400);

    const adjusted = await req(app.base, token, 'POST', '/api/inventory/adjustment', {
      product_id: product.id,
      qty_delta: -5,
      reason: 'Damaged in storage',
    });
    assert.equal(adjusted.status, 200);
    assert.equal(adjusted.json.quantity, 15);

    const { getDb } = await import('../../db.js');
    const db = getDb();
    const auditRow = db
      .prepare("SELECT * FROM audit_log WHERE action = 'manual_adjustment' ORDER BY id DESC LIMIT 1")
      .get();
    assert.ok(auditRow);
  } finally {
    await app.close();
  }
});

test('reorder suggestions list products at or below their reorder level', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const low = await createProduct(app.base, token, { name: 'Low Stock Item', reorder_level: 10 });
    const ok = await createProduct(app.base, token, { name: 'Well Stocked Item', reorder_level: 5 });
    await req(app.base, token, 'POST', '/api/inventory/grn', { items: [{ product_id: low.id, qty: 3 }] });
    await req(app.base, token, 'POST', '/api/inventory/grn', { items: [{ product_id: ok.id, qty: 50 }] });

    const suggestions = await req(app.base, token, 'GET', '/api/inventory/reorder-suggestions');
    const ids = suggestions.json.map((p) => p.id);
    assert.ok(ids.includes(low.id));
    assert.ok(!ids.includes(ok.id));
  } finally {
    await app.close();
  }
});

test('branch transfer decrements source stock immediately and credits destination on receipt', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const product = await createProduct(app.base, token, { name: 'Paracetamol' });
    await req(app.base, token, 'POST', '/api/inventory/grn', { items: [{ product_id: product.id, qty: 100 }] });

    const branch = await req(app.base, token, 'POST', '/api/inventory/branch', { name: 'Branch B' });
    const transfer = await req(app.base, token, 'POST', '/api/inventory/transfer', {
      to_branch_id: branch.json.id,
      items: [{ product_id: product.id, qty: 30 }],
    });
    assert.equal(transfer.status, 200);
    assert.equal(transfer.json.status, 'pending');

    const afterOut = await req(app.base, token, 'GET', `/api/inventory/product/${product.id}`);
    assert.equal(afterOut.json.quantity, 70);

    const doubleReceive = await req(app.base, token, 'POST', `/api/inventory/transfer/${transfer.json.id}/receive`);
    assert.equal(doubleReceive.status, 200);
    assert.equal(doubleReceive.json.status, 'received');

    const afterIn = await req(app.base, token, 'GET', `/api/inventory/product/${product.id}`);
    assert.equal(afterIn.json.quantity, 100);

    const secondReceive = await req(app.base, token, 'POST', `/api/inventory/transfer/${transfer.json.id}/receive`);
    assert.equal(secondReceive.status, 400);
  } finally {
    await app.close();
  }
});

test('stock take snapshots expected quantity, computes variance, and adjusts stock on completion', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const product = await createProduct(app.base, token, { name: 'Cough Syrup' });
    await req(app.base, token, 'POST', '/api/inventory/grn', { items: [{ product_id: product.id, qty: 50 }] });

    const take = await req(app.base, token, 'POST', '/api/inventory/stock-take', { business_date: '2026-09-07' });
    assert.equal(take.status, 200);
    const item = take.json.items.find((i) => i.product_id === product.id);
    assert.equal(item.expected_qty, 50);

    const counted = await req(
      app.base,
      token,
      'PUT',
      `/api/inventory/stock-take/${take.json.id}/item/${item.id}`,
      { counted_qty: 45 }
    );
    assert.equal(counted.status, 200);

    const completed = await req(app.base, token, 'POST', `/api/inventory/stock-take/${take.json.id}/complete`);
    assert.equal(completed.status, 200);
    assert.equal(completed.json.variance_report[0].variance, -5);

    const afterTake = await req(app.base, token, 'GET', `/api/inventory/product/${product.id}`);
    assert.equal(afterTake.json.quantity, 45);

    const again = await req(app.base, token, 'POST', `/api/inventory/stock-take/${take.json.id}/complete`);
    assert.equal(again.status, 400);
  } finally {
    await app.close();
  }
});

test('the product form persists pharmacy fields: controlled substance, generic group, reorder level, supplier', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const supplier = await req(app.base, token, 'POST', '/api/inventory/supplier', { name: 'MedSupply Ltd' });

    const form = new FormData();
    form.append('name', 'Morphine Sulfate 10mg');
    form.append('price', '120');
    form.append('category', 'Controlled Substances');
    form.append('quantity', '15');
    form.append('stock', '1');
    form.append('controlled_substance', '1');
    form.append('generic_group', 'Morphine');
    form.append('reorder_level', '5');
    form.append('supplier_id', String(supplier.json.id));
    const created = await fetch(`${app.base}/api/inventory/product`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: form,
    }).then((r) => r.json());

    assert.equal(created.controlled_substance, true);
    assert.equal(created.generic_group, 'Morphine');
    assert.equal(created.reorder_level, 5);
    assert.equal(created.supplier_id, supplier.json.id);

    const editForm = new FormData();
    editForm.append('id', String(created.id));
    editForm.append('name', 'Morphine Sulfate 10mg');
    editForm.append('price', '120');
    editForm.append('category', 'Controlled Substances');
    editForm.append('quantity', '15');
    editForm.append('stock', '1');
    editForm.append('controlled_substance', '0');
    editForm.append('generic_group', 'Morphine');
    editForm.append('reorder_level', '8');
    const updated = await fetch(`${app.base}/api/inventory/product`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: editForm,
    }).then((r) => r.json());

    assert.equal(updated.controlled_substance, false);
    assert.equal(updated.reorder_level, 8);
    assert.equal(updated.supplier_id, null);
  } finally {
    await app.close();
  }
});
