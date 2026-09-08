import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createServer } from '../../index.js';

async function setupApp() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = path.join(os.tmpdir(), `txn-test-${suffix}.db`);
  const uploadsPath = path.join(os.tmpdir(), `txn-test-uploads-${suffix}`);
  const app = await createServer({ dbPath, uploadsPath, jwtSecret: 'test-secret' });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
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

async function post(base, token, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function get(base, token, path) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json() };
}

async function put(base, token, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

async function seedRolesAndUsers(base) {
  const adminToken = await login(base, 'admin', 'admin');
  const manager = await createUser(base, adminToken, {
    username: 'mgr1',
    password: 'pass1234',
    fullname: 'Manager One',
    role: 'manager',
    perm_discount_approve: true,
    perm_refund_void: true,
    perm_transactions: true,
  });
  const cashier = await createUser(base, adminToken, {
    username: 'csh1',
    password: 'pass1234',
    fullname: 'Cashier One',
    role: 'cashier',
    perm_transactions: true,
  });
  const cashierToken = await login(base, 'csh1', 'pass1234');
  const managerToken = await login(base, 'mgr1', 'pass1234');
  return { adminToken, manager, cashier, cashierToken, managerToken };
}

test('discount above threshold is rejected without approval, accepted with a valid manager approval', async () => {
  const app = await setupApp();
  try {
    const { manager, cashierToken } = await seedRolesAndUsers(app.base);

    const saleBody = {
      items: [{ id: 1, name: 'Test', price: 100, quantity: 1, stock: 1 }],
      subtotal: 100,
      discount: 20, // 20% > default 10% threshold
      tax: 0,
      total: 80,
      paid: 80,
      change: 0,
      payment_type: 1,
      status: 1,
    };

    const rejected = await post(app.base, cashierToken, '/api/new', saleBody);
    assert.equal(rejected.status, 403);

    const withUnauthorizedApprover = await post(app.base, cashierToken, '/api/new', {
      ...saleBody,
      discount_approved_by: 999,
    });
    assert.equal(withUnauthorizedApprover.status, 403);

    const approved = await post(app.base, cashierToken, '/api/new', {
      ...saleBody,
      discount_approved_by: manager.id,
    });
    assert.equal(approved.status, 200);
    assert.ok(approved.json.id);
  } finally {
    await app.close();
  }
});

test('discount at/under threshold needs no approval', async () => {
  const app = await setupApp();
  try {
    const { cashierToken } = await seedRolesAndUsers(app.base);
    const saleBody = {
      items: [{ id: 1, name: 'Test', price: 100, quantity: 1, stock: 1 }],
      subtotal: 100,
      discount: 5, // 5% <= default 10% threshold
      tax: 0,
      total: 95,
      paid: 95,
      change: 0,
      payment_type: 1,
      status: 1,
    };
    const result = await post(app.base, cashierToken, '/api/new', saleBody);
    assert.equal(result.status, 200);
  } finally {
    await app.close();
  }
});

test('users/authorize verifies a different user\'s credentials + permission without switching session', async () => {
  const app = await setupApp();
  try {
    const { manager, cashierToken } = await seedRolesAndUsers(app.base);

    const ok = await post(app.base, cashierToken, '/api/users/authorize', {
      username: 'mgr1',
      password: 'pass1234',
      perm: 'perm_discount_approve',
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.id, manager.id);

    const badPassword = await post(app.base, cashierToken, '/api/users/authorize', {
      username: 'mgr1',
      password: 'wrong',
      perm: 'perm_discount_approve',
    });
    assert.equal(badPassword.status, 401);

    const insufficientPerm = await post(app.base, cashierToken, '/api/users/authorize', {
      username: 'csh1',
      password: 'pass1234',
      perm: 'perm_discount_approve',
    });
    assert.equal(insufficientPerm.status, 403);
  } finally {
    await app.close();
  }
});

test('void requires perm_refund_void and restocks a paid sale', async () => {
  const app = await setupApp();
  try {
    const { cashierToken, managerToken } = await seedRolesAndUsers(app.base);

    // seed a product with known stock via the inventory route (avoids poking the DB directly)
    const adminToken = await login(app.base, 'admin', 'admin');
    const form = new FormData();
    form.append('name', 'Paracetamol');
    form.append('price', '10');
    form.append('category', 'Pain Relief');
    form.append('quantity', '20');
    form.append('stock', '1');
    const productRes = await fetch(`${app.base}/api/inventory/product`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: form,
    });
    const product = await productRes.json();

    const sale = await post(app.base, cashierToken, '/api/new', {
      items: [{ id: product.id, name: product.name, price: 10, quantity: 5, stock: 1 }],
      subtotal: 50,
      discount: 0,
      tax: 0,
      total: 50,
      paid: 50,
      change: 0,
      payment_type: 1,
      status: 1,
    });
    assert.equal(sale.status, 200);

    const afterSale = await get(app.base, adminToken, '/api/inventory/products');
    const productAfterSale = afterSale.json.find((p) => p.id === product.id);
    assert.equal(productAfterSale.quantity, 15); // 20 - 5

    const deniedVoid = await post(app.base, cashierToken, '/api/void', {
      transactionId: sale.json.id,
      reason: 'Customer changed mind',
    });
    assert.equal(deniedVoid.status, 403);

    const voided = await post(app.base, managerToken, '/api/void', {
      transactionId: sale.json.id,
      reason: 'Customer changed mind',
    });
    assert.equal(voided.status, 200);

    const afterVoid = await get(app.base, adminToken, '/api/inventory/products');
    const productAfterVoid = afterVoid.json.find((p) => p.id === product.id);
    assert.equal(productAfterVoid.quantity, 20); // restocked back to original

    const doubleVoid = await post(app.base, managerToken, '/api/void', {
      transactionId: sale.json.id,
      reason: 'again',
    });
    assert.equal(doubleVoid.status, 400);
  } finally {
    await app.close();
  }
});

test('refund restocks and marks the transaction refunded, with an audit trail', async () => {
  const app = await setupApp();
  try {
    const { cashierToken, managerToken } = await seedRolesAndUsers(app.base);
    const adminToken = await login(app.base, 'admin', 'admin');

    const form = new FormData();
    form.append('name', 'Ibuprofen');
    form.append('price', '8');
    form.append('category', 'Pain Relief');
    form.append('quantity', '10');
    form.append('stock', '1');
    const productRes = await fetch(`${app.base}/api/inventory/product`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: form,
    });
    const product = await productRes.json();

    const sale = await post(app.base, cashierToken, '/api/new', {
      items: [{ id: product.id, name: product.name, price: 8, quantity: 3, stock: 1 }],
      subtotal: 24,
      discount: 0,
      tax: 0,
      total: 24,
      paid: 24,
      change: 0,
      payment_type: 1,
      status: 1,
    });

    const refund = await post(app.base, managerToken, '/api/refund', {
      transactionId: sale.json.id,
      reason: 'Customer returned unopened',
    });
    assert.equal(refund.status, 200);

    const afterRefund = await get(app.base, adminToken, '/api/inventory/products');
    const productAfter = afterRefund.json.find((p) => p.id === product.id);
    assert.equal(productAfter.quantity, 10); // 10 - 3 + 3 restocked

    const txn = await get(app.base, adminToken, `/api/transaction/${sale.json.id}`);
    assert.equal(txn.json.status, 3);
    assert.equal(txn.json.void_refund_reason, 'Customer returned unopened');
  } finally {
    await app.close();
  }
});

test('cash-up computes expected cash and persists a Z-report record', async () => {
  const app = await setupApp();
  try {
    const { cashierToken } = await seedRolesAndUsers(app.base);

    await post(app.base, cashierToken, '/api/new', {
      items: [{ id: 1, name: 'A', price: 30, quantity: 1, stock: 0 }],
      subtotal: 30,
      discount: 0,
      tax: 0,
      total: 30,
      paid: 50,
      change: 20,
      payment_type: 1,
      till: 1,
      status: 1,
    });

    const date = new Date().toISOString().slice(0, 10);
    const preview = await get(app.base, cashierToken, `/api/cash-up?till=1&date=${date}`);
    assert.equal(preview.status, 200);
    assert.equal(preview.json.cash_total, 30); // paid(50) - change(20)
    assert.equal(preview.json.expected_cash, 30);

    const recorded = await post(app.base, cashierToken, '/api/cash-up', {
      till: 1,
      date,
      counted_cash: 25,
      notes: 'short by 5',
    });
    assert.equal(recorded.status, 200);
    assert.equal(recorded.json.variance, -5);

    const history = await get(app.base, cashierToken, '/api/cash-up/history?till=1');
    assert.equal(history.status, 200);
    assert.equal(history.json.length, 1);
    assert.equal(history.json[0].notes, 'short by 5');
  } finally {
    await app.close();
  }
});

test('selling more than a stock-tracked product has on hand is rejected, not silently clamped to zero', async () => {
  const app = await setupApp();
  try {
    const { cashierToken } = await seedRolesAndUsers(app.base);
    const adminToken = await login(app.base, 'admin', 'admin');

    const form = new FormData();
    form.append('name', 'Amoxicillin 500mg');
    form.append('price', '35');
    form.append('category', 'Antibiotics');
    form.append('quantity', '3');
    form.append('stock', '1');
    const productRes = await fetch(`${app.base}/api/inventory/product`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}` },
      body: form,
    });
    const product = await productRes.json();

    const oversold = await post(app.base, cashierToken, '/api/new', {
      items: [{ id: product.id, name: product.name, price: 35, quantity: 5, stock: 1 }],
      subtotal: 175,
      discount: 0,
      tax: 0,
      total: 175,
      paid: 175,
      change: 0,
      payment_type: 1,
      status: 1,
    });
    assert.equal(oversold.status, 400);
    assert.match(oversold.json.error, /Not enough stock/);
    assert.equal(oversold.json.shortfalls[0].available, 3);
    assert.equal(oversold.json.shortfalls[0].requested, 5);

    // Rejected up front — no transaction should have been created, and stock is untouched.
    const afterAttempt = await get(app.base, adminToken, '/api/inventory/products');
    assert.equal(afterAttempt.json.find((p) => p.id === product.id).quantity, 3);

    const withinStock = await post(app.base, cashierToken, '/api/new', {
      items: [{ id: product.id, name: product.name, price: 35, quantity: 3, stock: 1 }],
      subtotal: 105,
      discount: 0,
      tax: 0,
      total: 105,
      paid: 105,
      change: 0,
      payment_type: 1,
      status: 1,
    });
    assert.equal(withinStock.status, 200);

    // Holding an order for more than is currently on hand is still allowed (nothing decrements
    // yet) — only completing it as paid enforces the stock check.
    const held = await post(app.base, cashierToken, '/api/new', {
      ref_number: 'H-TEST-1',
      items: [{ id: product.id, name: product.name, price: 35, quantity: 10, stock: 1 }],
      subtotal: 350,
      discount: 0,
      tax: 0,
      total: 350,
      paid: 0,
      change: 0,
      payment_type: 1,
      status: 0,
    });
    assert.equal(held.status, 200);

    const completingOversoldHold = await put(app.base, cashierToken, '/api/new', {
      _id: held.json.id,
      items: [{ id: product.id, name: product.name, price: 35, quantity: 10, stock: 1 }],
      subtotal: 350,
      discount: 0,
      tax: 0,
      total: 350,
      paid: 350,
      change: 0,
      payment_type: 1,
      status: 1,
    });
    assert.equal(completingOversoldHold.status, 400);
    assert.match(completingOversoldHold.json.error, /Not enough stock/);

    const stillOnHold = await get(app.base, adminToken, '/api/on-hold');
    assert.ok(stillOnHold.json.some((t) => t.id === held.json.id));
  } finally {
    await app.close();
  }
});
