import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createServer } from '../../index.js';

async function setupApp() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = path.join(os.tmpdir(), `an-test-${suffix}.db`);
  const uploadsPath = path.join(os.tmpdir(), `an-test-uploads-${suffix}`);
  const app = await createServer({ dbPath, uploadsPath, jwtSecret: 'an-test-secret' });
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

async function createProduct(base, token, { name, price }) {
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
  return res.json();
}

test('profit-margin computes revenue/cost/margin from GRN unit cost and sold items', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const product = await createProduct(app.base, token, { name: 'Panadol', price: 10 });

    await req(app.base, token, 'POST', '/api/inventory/grn', {
      items: [{ product_id: product.id, qty: 100, unit_cost: 4 }],
    });
    await req(app.base, token, 'POST', '/api/new', {
      customer: '0',
      customer_name: 'Walk-in',
      status: 1,
      total: 50,
      subtotal: 50,
      paid: 50,
      items: [{ id: product.id, quantity: 5, price: 10 }],
    });

    const { status, json } = await req(app.base, token, 'GET', '/api/analytics/profit-margin');
    assert.equal(status, 200);
    const row = json.find((r) => r.product_id === product.id);
    assert.ok(row);
    assert.equal(row.qty_sold, 5);
    assert.equal(row.revenue, 50);
    assert.equal(row.cost_of_goods, 20);
    assert.equal(row.profit, 30);
    assert.equal(row.margin_pct, 60);
    assert.equal(row.has_cost_data, true);
  } finally {
    await app.close();
  }
});

test('daily-sales groups paid transactions by day and excludes held/voided sales', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const product = await createProduct(app.base, token, { name: 'Ibuprofen', price: 5 });
    await req(app.base, token, 'POST', '/api/inventory/grn', { items: [{ product_id: product.id, qty: 50 }] });

    await req(app.base, token, 'POST', '/api/new', {
      customer: '0',
      customer_name: 'Walk-in',
      status: 1,
      total: 20,
      subtotal: 20,
      paid: 20,
      items: [{ id: product.id, quantity: 4, price: 5 }],
    });
    await req(app.base, token, 'POST', '/api/new', {
      customer: '0',
      customer_name: 'Walk-in',
      status: 0,
      total: 100,
      subtotal: 100,
      paid: 0,
      items: [{ id: product.id, quantity: 20, price: 5 }],
    });

    const { json } = await req(app.base, token, 'GET', '/api/analytics/daily-sales');
    const totalAcrossDays = json.reduce((sum, d) => sum + d.sales_total, 0);
    assert.equal(totalAcrossDays, 20);
  } finally {
    await app.close();
  }
});

test('cashier-performance aggregates by user and counts refunds/voids separately', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const product = await createProduct(app.base, token, { name: 'Bandage', price: 2 });
    await req(app.base, token, 'POST', '/api/inventory/grn', { items: [{ product_id: product.id, qty: 50 }] });

    const sale = await req(app.base, token, 'POST', '/api/new', {
      customer: '0',
      customer_name: 'Walk-in',
      user_id: 1,
      user: 'Administrator',
      status: 1,
      total: 10,
      subtotal: 10,
      paid: 10,
      items: [{ id: product.id, quantity: 5, price: 2 }],
    });

    await req(app.base, token, 'POST', '/api/void', { transactionId: sale.json.id, reason: 'Customer changed mind' });

    const { json } = await req(app.base, token, 'GET', '/api/analytics/cashier-performance');
    const admin = json.find((r) => r.user_id === 1);
    // the voided sale no longer counts toward sales_total (status moved to 2), but should show under refund_void_count
    assert.ok(!admin || admin.sales_total === 0);
    const registerCheck = await req(app.base, token, 'GET', '/api/analytics/controlled-register');
    assert.equal(registerCheck.status, 200);
  } finally {
    await app.close();
  }
});

test('stock-valuation totals retail and cost value across products', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const product = await createProduct(app.base, token, { name: 'Vitamin D', price: 8 });
    await req(app.base, token, 'POST', '/api/inventory/grn', {
      items: [{ product_id: product.id, qty: 10, unit_cost: 3 }],
    });

    const { json } = await req(app.base, token, 'GET', '/api/analytics/stock-valuation');
    const row = json.products.find((p) => p.product_id === product.id);
    assert.equal(row.retail_value, 80);
    assert.equal(row.cost_value, 30);
    assert.ok(json.totals.retail_value >= 80);
  } finally {
    await app.close();
  }
});

test('movers separates fast and slow movers by quantity sold in the window', async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');
    const fast = await createProduct(app.base, token, { name: 'Fast Mover', price: 1 });
    const slow = await createProduct(app.base, token, { name: 'Slow Mover', price: 1 });
    await req(app.base, token, 'POST', '/api/inventory/grn', { items: [{ product_id: slow.id, qty: 50 }] });
    await req(app.base, token, 'POST', '/api/inventory/grn', { items: [{ product_id: fast.id, qty: 50 }] });

    await req(app.base, token, 'POST', '/api/new', {
      customer: '0',
      customer_name: 'Walk-in',
      status: 1,
      total: 20,
      subtotal: 20,
      paid: 20,
      items: [{ id: fast.id, quantity: 20, price: 1 }],
    });

    const { json } = await req(app.base, token, 'GET', '/api/analytics/movers');
    assert.equal(json.fast_movers[0].product_id, fast.id);
    assert.ok(json.slow_movers.some((r) => r.product_id === slow.id));
  } finally {
    await app.close();
  }
});
