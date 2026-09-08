import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createServer } from '../../index.js';

async function setupApp() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = path.join(os.tmpdir(), `rx-test-${suffix}.db`);
  const uploadsPath = path.join(os.tmpdir(), `rx-test-uploads-${suffix}`);
  const app = await createServer({ dbPath, uploadsPath, jwtSecret: 'rx-test-secret' });
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

async function createUser(base, adminToken, body) {
  const res = await fetch(`${base}/api/users/post`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error || 'create user failed');
  return json;
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

async function createProduct(base, token, { name, price, controlled = false }) {
  const form = new FormData();
  form.append('name', name);
  form.append('price', String(price));
  form.append('category', 'Test');
  form.append('quantity', '100');
  form.append('stock', '1');
  const res = await fetch(`${base}/api/inventory/product`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  const product = await res.json();
  if (controlled) {
    // No dedicated route flips controlled_substance yet (Inventory slice) — set directly via a
    // second product save isn't possible either, so this reaches into the DB layer the same way
    // the (not yet built) catalog UI eventually will. Acceptable for a test seam.
    const { getDb } = await import('../../db.js');
    getDb().prepare('UPDATE products SET controlled_substance = 1 WHERE id = ?').run(product.id);
  }
  return product;
}

async function getCustomerId(base, token) {
  const res = await fetch(`${base}/api/customers/all`, { headers: { Authorization: `Bearer ${token}` } });
  const customers = await res.json();
  return customers[0].id; // seeded Walk-in Customer always exists
}

async function seedRoles(base) {
  const adminToken = await login(base, 'admin', 'admin');
  const pharmacist = await createUser(base, adminToken, {
    username: 'pharm1',
    password: 'pass1234',
    fullname: 'Pharm One',
    role: 'pharmacist',
    perm_transactions: true,
    perm_controlled_approve: true,
  });
  const cashier = await createUser(base, adminToken, {
    username: 'csh1',
    password: 'pass1234',
    fullname: 'Cashier One',
    role: 'cashier',
    perm_transactions: true,
  });
  const cashierToken = await login(base, 'csh1', 'pass1234');
  const pharmacistToken = await login(base, 'pharm1', 'pass1234');
  return { adminToken, pharmacist, cashier, cashierToken, pharmacistToken };
}

test('create a prescription and dispense it fully, no substitution or controlled items', async () => {
  const app = await setupApp();
  try {
    const { adminToken, cashierToken } = await seedRoles(app.base);
    const patientId = await getCustomerId(app.base, cashierToken);
    const product = await createProduct(app.base, adminToken, { name: 'Amoxicillin 250mg', price: 5 });

    const created = await req(app.base, cashierToken, 'POST', '/api/prescriptions/', {
      patient_id: patientId,
      prescriber_name: 'Dr. Banda',
      prescriber_reg_no: 'REG-1',
      date: new Date().toISOString(),
      items: [{ product_id: product.id, prescribed_qty: 20 }],
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.status, 'open');
    assert.equal(created.json.items.length, 1);
    assert.equal(created.json.items[0].remaining_qty, 20);

    const item = created.json.items[0];
    const dispensed = await req(
      app.base,
      cashierToken,
      'POST',
      `/api/prescriptions/${created.json.id}/items/${item.id}/dispense`,
      { dispensed_qty: 20 }
    );
    assert.equal(dispensed.status, 200);
    assert.equal(dispensed.json.status, 'completed');
    assert.equal(dispensed.json.items[0].dispensed_qty, 20);
    assert.equal(dispensed.json.items[0].partial_fill_state, 'complete');

    const productsRes = await req(app.base, cashierToken, 'GET', '/api/inventory/products');
    const updated = productsRes.json.find((p) => p.id === product.id);
    assert.equal(updated.quantity, 80); // 100 - 20
  } finally {
    await app.close();
  }
});

test('partial fill leaves the prescription partially_filled and remaining_qty accurate', async () => {
  const app = await setupApp();
  try {
    const { adminToken, cashierToken } = await seedRoles(app.base);
    const patientId = await getCustomerId(app.base, cashierToken);
    const product = await createProduct(app.base, adminToken, { name: 'Ibuprofen 400mg', price: 3 });

    const created = await req(app.base, cashierToken, 'POST', '/api/prescriptions/', {
      patient_id: patientId,
      items: [{ product_id: product.id, prescribed_qty: 30 }],
    });
    const item = created.json.items[0];

    const first = await req(
      app.base,
      cashierToken,
      'POST',
      `/api/prescriptions/${created.json.id}/items/${item.id}/dispense`,
      { dispensed_qty: 10 }
    );
    assert.equal(first.status, 200);
    assert.equal(first.json.status, 'partially_filled');
    assert.equal(first.json.items[0].remaining_qty, 20);

    const overDispense = await req(
      app.base,
      cashierToken,
      'POST',
      `/api/prescriptions/${created.json.id}/items/${item.id}/dispense`,
      { dispensed_qty: 25 }
    );
    assert.equal(overDispense.status, 400);

    const second = await req(
      app.base,
      cashierToken,
      'POST',
      `/api/prescriptions/${created.json.id}/items/${item.id}/dispense`,
      { dispensed_qty: 20 }
    );
    assert.equal(second.status, 200);
    assert.equal(second.json.status, 'completed');
  } finally {
    await app.close();
  }
});

test('generic substitution requires a pharmacist/manager, not a plain cashier', async () => {
  const app = await setupApp();
  try {
    const { adminToken, cashierToken, pharmacistToken } = await seedRoles(app.base);
    const patientId = await getCustomerId(app.base, cashierToken);
    const original = await createProduct(app.base, adminToken, { name: 'Brand Painkiller', price: 10 });
    const generic = await createProduct(app.base, adminToken, { name: 'Generic Painkiller', price: 6 });

    const created = await req(app.base, cashierToken, 'POST', '/api/prescriptions/', {
      patient_id: patientId,
      items: [{ product_id: original.id, prescribed_qty: 5 }],
    });
    const item = created.json.items[0];

    const deniedForCashier = await req(
      app.base,
      cashierToken,
      'POST',
      `/api/prescriptions/${created.json.id}/items/${item.id}/dispense`,
      { dispensed_qty: 5, substituted_product_id: generic.id }
    );
    assert.equal(deniedForCashier.status, 403);

    const allowedForPharmacist = await req(
      app.base,
      pharmacistToken,
      'POST',
      `/api/prescriptions/${created.json.id}/items/${item.id}/dispense`,
      { dispensed_qty: 5, substituted_product_id: generic.id }
    );
    assert.equal(allowedForPharmacist.status, 200);
    assert.equal(allowedForPharmacist.json.items[0].substituted_product_id, generic.id);
  } finally {
    await app.close();
  }
});

test('controlled substance dispensing requires a second authorized approver and writes an audit trail', async () => {
  const app = await setupApp();
  try {
    const { adminToken, cashier, cashierToken, pharmacist } = await seedRoles(app.base);
    const patientId = await getCustomerId(app.base, cashierToken);
    const controlled = await createProduct(app.base, adminToken, {
      name: 'Morphine 10mg',
      price: 20,
      controlled: true,
    });

    const created = await req(app.base, cashierToken, 'POST', '/api/prescriptions/', {
      patient_id: patientId,
      items: [{ product_id: controlled.id, prescribed_qty: 2 }],
    });
    const item = created.json.items[0];
    assert.equal(created.json.items[0].product_controlled, true);

    const withoutApproval = await req(
      app.base,
      cashierToken,
      'POST',
      `/api/prescriptions/${created.json.id}/items/${item.id}/dispense`,
      { dispensed_qty: 2 }
    );
    assert.equal(withoutApproval.status, 403);

    const withUnauthorizedApprover = await req(
      app.base,
      cashierToken,
      'POST',
      `/api/prescriptions/${created.json.id}/items/${item.id}/dispense`,
      { dispensed_qty: 2, approving_user_id: 999 }
    );
    assert.equal(withUnauthorizedApprover.status, 403);

    const withValidApproval = await req(
      app.base,
      cashierToken,
      'POST',
      `/api/prescriptions/${created.json.id}/items/${item.id}/dispense`,
      { dispensed_qty: 2, approving_user_id: pharmacist.id }
    );
    assert.equal(withValidApproval.status, 200);
    assert.equal(withValidApproval.json.status, 'completed');

    // controlled_substance_log + audit_log both got real rows — check via a fresh DB read
    const { getDb } = await import('../../db.js');
    const db = getDb();
    const logRow = db.prepare('SELECT * FROM controlled_substance_log WHERE prescription_item_id = ?').get(item.id);
    assert.ok(logRow);
    assert.equal(logRow.qty, 2);
    assert.equal(logRow.dispensing_user_id, cashier.id);
    assert.equal(logRow.approving_user_id, pharmacist.id);

    const auditRow = db
      .prepare("SELECT * FROM audit_log WHERE entity_type = 'controlled_substance_log' AND entity_id = ?")
      .get(logRow.id);
    assert.ok(auditRow);
    assert.equal(auditRow.action, 'controlled_dispense');
  } finally {
    await app.close();
  }
});

test('dispensing more than the pharmacy physically has in stock is rejected, not silently clamped to zero', async () => {
  const app = await setupApp();
  try {
    const { adminToken, cashierToken } = await seedRoles(app.base);
    const patientId = await getCustomerId(app.base, cashierToken);
    // createProduct seeds quantity: 100 — prescribe more than that so the remaining_qty check
    // (prescribed vs dispensed) alone wouldn't catch running out of physical stock.
    const product = await createProduct(app.base, adminToken, { name: 'Ibuprofen 400mg', price: 3 });

    const created = await req(app.base, cashierToken, 'POST', '/api/prescriptions/', {
      patient_id: patientId,
      items: [{ product_id: product.id, prescribed_qty: 150 }],
    });
    const item = created.json.items[0];
    assert.equal(item.remaining_qty, 150);

    const oversold = await req(
      app.base,
      cashierToken,
      'POST',
      `/api/prescriptions/${created.json.id}/items/${item.id}/dispense`,
      { dispensed_qty: 150 }
    );
    assert.equal(oversold.status, 400);
    assert.match(oversold.json.error, /Not enough stock/);

    // Rejected before any write — dispensed_qty and product quantity are both untouched.
    const unchanged = await req(app.base, cashierToken, 'GET', `/api/prescriptions/${created.json.id}`);
    assert.equal(unchanged.json.items[0].dispensed_qty, 0);
    const productsRes = await req(app.base, cashierToken, 'GET', '/api/inventory/products');
    assert.equal(productsRes.json.find((p) => p.id === product.id).quantity, 100);

    const withinStock = await req(
      app.base,
      cashierToken,
      'POST',
      `/api/prescriptions/${created.json.id}/items/${item.id}/dispense`,
      { dispensed_qty: 100 }
    );
    assert.equal(withinStock.status, 200);
    assert.equal(withinStock.json.items[0].dispensed_qty, 100);
  } finally {
    await app.close();
  }
});
