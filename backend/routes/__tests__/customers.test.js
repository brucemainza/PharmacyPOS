import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createServer } from '../../index.js';

async function setupApp() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = path.join(os.tmpdir(), `cust-test-${suffix}.db`);
  const uploadsPath = path.join(os.tmpdir(), `cust-test-uploads-${suffix}`);
  const app = await createServer({ dbPath, uploadsPath, jwtSecret: 'cust-test-secret' });
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
  let json = null;
  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json };
}

async function createProduct(base, token, { name, price }) {
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
  return res.json();
}

test('customer profile persists pharmacy fields (dob, allergies, insurance, corporate account)', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');

    const corp = await req(app.base, token, 'POST', '/api/customers/corporate-account', {
      name: 'Acme Corp',
      discount_percent: 12,
    });
    assert.equal(corp.status, 200);

    const created = await req(app.base, token, 'POST', '/api/customers/customer', {
      name: 'Jane Doe',
      phone: '0977000000',
      date_of_birth: '1990-05-01',
      allergies: 'Penicillin',
      insurance_ref: 'INS-123',
      corporate_account_id: corp.json.id,
    });
    assert.equal(created.status, 200);
    assert.equal(created.json.allergies, 'Penicillin');
    assert.equal(created.json.corporate_account_id, corp.json.id);
    assert.equal(created.json.loyalty_points, 0);

    const updated = await req(app.base, token, 'PUT', '/api/customers/customer', {
      _id: created.json.id,
      name: 'Jane Doe',
      allergies: 'Penicillin, Sulfa',
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.json.allergies, 'Penicillin, Sulfa');
  } finally {
    await app.close();
  }
});

test('completing a sale for a real customer accrues loyalty points; walk-in earns none', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const product = await createProduct(app.base, token, { name: 'Vitamin C', price: 10 });
    const customer = await req(app.base, token, 'POST', '/api/customers/customer', { name: 'Loyal Larry' });

    const sale = await req(app.base, token, 'POST', '/api/new', {
      customer: customer.json.id,
      customer_name: 'Loyal Larry',
      status: 1,
      total: 100,
      subtotal: 100,
      paid: 100,
      items: [{ id: product.id, quantity: 1 }],
    });
    assert.equal(sale.status, 200);

    const afterSale = await req(app.base, token, 'GET', `/api/customers/customer/${customer.json.id}`);
    // default loyalty_earn_rate is 0.1 -> 100 * 0.1 = 10 points
    assert.equal(afterSale.json.loyalty_points, 10);

    const history = await req(app.base, token, 'GET', `/api/customers/customer/${customer.json.id}/history`);
    assert.equal(history.json.length, 1);
    assert.equal(history.json[0].loyalty_points_earned, 10);

    const walkInSale = await req(app.base, token, 'POST', '/api/new', {
      customer: '0',
      customer_name: 'Walk-in',
      status: 1,
      total: 50,
      subtotal: 50,
      paid: 50,
      items: [{ id: product.id, quantity: 1 }],
    });
    assert.equal(walkInSale.status, 200);
  } finally {
    await app.close();
  }
});

test('a held sale only earns loyalty points once it is completed, not while on hold', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const product = await createProduct(app.base, token, { name: 'Cough Drops', price: 5 });
    const customer = await req(app.base, token, 'POST', '/api/customers/customer', { name: 'Hold Customer' });

    const held = await req(app.base, token, 'POST', '/api/new', {
      customer: customer.json.id,
      customer_name: 'Hold Customer',
      status: 0,
      total: 20,
      subtotal: 20,
      paid: 0,
      items: [{ id: product.id, quantity: 2 }],
    });
    assert.equal(held.status, 200);

    const stillZero = await req(app.base, token, 'GET', `/api/customers/customer/${customer.json.id}`);
    assert.equal(stillZero.json.loyalty_points, 0);

    const completed = await req(app.base, token, 'PUT', '/api/new', {
      _id: held.json.id,
      customer: customer.json.id,
      customer_name: 'Hold Customer',
      status: 1,
      total: 20,
      subtotal: 20,
      paid: 20,
      items: [{ id: product.id, quantity: 2 }],
    });
    assert.equal(completed.status, 200);

    const afterComplete = await req(app.base, token, 'GET', `/api/customers/customer/${customer.json.id}`);
    assert.equal(afterComplete.json.loyalty_points, 2); // floor(20 * 0.1)
  } finally {
    await app.close();
  }
});
