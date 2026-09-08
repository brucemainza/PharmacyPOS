// Split payment (cash + Lenco mobile money) through the real route stack, exercising the exact
// path the checkout UI's paySplit() drives: two independent payments rows, both linked to one
// sale. Uses the live Lenco *sandbox* for the mobile-money leg — see
// server/payments/__tests__/lenco.sandbox.test.js for the ground rule this follows (skip, not
// fail, when no sandbox credentials are configured).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { createServer } from '../../index.js';
import { getLencoConfig } from '../../config.js';

const skip = !getLencoConfig().secretKey ? 'LENCO_SECRET_KEY not set — see .env.example' : false;

async function setupApp() {
  const suffix = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dbPath = path.join(os.tmpdir(), `split-test-${suffix}.db`);
  const uploadsPath = path.join(os.tmpdir(), `split-test-uploads-${suffix}`);
  const app = await createServer({ dbPath, uploadsPath, jwtSecret: 'split-test-secret' });
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
  return (await res.json()).token;
}

async function post(base, token, path, body) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

async function get(base, token, path) {
  const res = await fetch(`${base}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json() };
}

test('split payment: cash leg + real sandbox mobile-money leg both settle and link to one sale', { skip }, async () => {
  const app = await setupApp();
  try {
    const token = await login(app.base, 'admin', 'admin');

    // Sale total 25: 10 cash (instant) + 15 mobile money (real sandbox, MTN success number).
    const cashLeg = await post(app.base, token, '/api/payments/initiate', {
      method: 'cash',
      amount: 10,
      currency: 'ZMW',
    });
    assert.equal(cashLeg.status, 200);
    assert.equal(cashLeg.json.status, 'successful');

    const momoLeg = await post(app.base, token, '/api/payments/initiate', {
      method: 'mobile_money',
      amount: 15,
      currency: 'ZMW',
      mobileMoney: { phone: '0961111111', operator: 'mtn', country: 'zm' },
    });
    assert.equal(momoLeg.status, 200);
    assert.equal(momoLeg.json.status, 'pending');

    let momoFinal = null;
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 3000));
      const s = await get(app.base, token, `/api/payments/${momoLeg.json.reference}/status`);
      if (s.json.status === 'successful' || s.json.status === 'failed') {
        momoFinal = s.json;
        break;
      }
    }
    assert.equal(momoFinal?.status, 'successful');

    const sale = await post(app.base, token, '/api/new', {
      items: [{ id: 1, name: 'Split Test Item', price: 25, quantity: 1, stock: 0 }],
      subtotal: 25,
      discount: 0,
      tax: 0,
      total: 25,
      paid: 25,
      change: 0,
      payment_type: 5, // split
      status: 1,
    });
    assert.equal(sale.status, 200);

    await post(app.base, token, `/api/payments/${cashLeg.json.reference}/link`, {
      transactionId: sale.json.id,
    });
    await post(app.base, token, `/api/payments/${momoLeg.json.reference}/link`, {
      transactionId: sale.json.id,
    });

    const forSale = await get(app.base, token, `/api/payments/transaction/${sale.json.id}`);
    assert.equal(forSale.json.length, 2);
    const methods = forSale.json.map((p) => p.method).sort();
    assert.deepEqual(methods, ['cash', 'mobile_money']);
    assert.ok(forSale.json.every((p) => p.status === 'successful'));
    assert.ok(forSale.json.every((p) => p.transaction_id === sale.json.id));
  } finally {
    await app.close();
  }
});
