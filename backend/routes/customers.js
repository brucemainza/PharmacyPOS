import { Router } from 'express';
import { getDb, mapCustomer, mapCorporateAccount, mapTransaction } from '../db.js';

const router = Router();

router.get('/all', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM customers ORDER BY name').all();
  res.json(rows.map(mapCustomer));
});

router.get('/customer/:customerId', (req, res) => {
  const row = getDb()
    .prepare('SELECT * FROM customers WHERE id = ?')
    .get(parseInt(req.params.customerId, 10));
  res.json(mapCustomer(row));
});

router.get('/customer/:customerId/history', (req, res) => {
  const rows = getDb()
    .prepare(
      `SELECT * FROM transactions WHERE customer = ? AND status = 1 ORDER BY date DESC LIMIT 100`
    )
    .all(String(parseInt(req.params.customerId, 10)));
  res.json(rows.map(mapTransaction));
});

router.post('/customer', (req, res) => {
  const body = req.body || {};
  const db = getDb();
  const result = db
    .prepare(
      `INSERT INTO customers
        (name, phone, email, address, date_of_birth, allergies, loyalty_points, corporate_account_id, insurance_ref)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      body.name || '',
      body.phone || '',
      body.email || '',
      body.address || '',
      body.date_of_birth || '',
      body.allergies || '',
      parseInt(body.loyalty_points, 10) || 0,
      body.corporate_account_id ? parseInt(body.corporate_account_id, 10) : null,
      body.insurance_ref || ''
    );
  res.json(mapCustomer(db.prepare('SELECT * FROM customers WHERE id = ?').get(result.lastInsertRowid)));
});

router.put('/customer', (req, res) => {
  const body = req.body || {};
  const db = getDb();
  const id = parseInt(body._id ?? body.id, 10);
  db.prepare(
    `UPDATE customers SET
      name = ?, phone = ?, email = ?, address = ?, date_of_birth = ?, allergies = ?,
      loyalty_points = ?, corporate_account_id = ?, insurance_ref = ?
     WHERE id = ?`
  ).run(
    body.name || '',
    body.phone || '',
    body.email || '',
    body.address || '',
    body.date_of_birth || '',
    body.allergies || '',
    parseInt(body.loyalty_points, 10) || 0,
    body.corporate_account_id ? parseInt(body.corporate_account_id, 10) : null,
    body.insurance_ref || '',
    id
  );
  res.json(mapCustomer(db.prepare('SELECT * FROM customers WHERE id = ?').get(id)));
});

router.delete('/customer/:customerId', (req, res) => {
  getDb()
    .prepare('DELETE FROM customers WHERE id = ?')
    .run(parseInt(req.params.customerId, 10));
  res.sendStatus(200);
});

// ---- Corporate accounts (contracted discount rates for corporate/insurance-billed customers) ----

router.get('/corporate-accounts', (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM corporate_accounts ORDER BY name').all();
  res.json(rows.map(mapCorporateAccount));
});

router.post('/corporate-account', (req, res) => {
  const db = getDb();
  const body = req.body || {};
  if (!body.name) return res.status(400).json({ error: 'name is required' });
  const discountPercent = parseFloat(body.discount_percent) || 0;
  const now = new Date().toISOString();

  if (!body.id) {
    const result = db
      .prepare('INSERT INTO corporate_accounts (name, discount_percent, created_at) VALUES (?, ?, ?)')
      .run(body.name, discountPercent, now);
    return res.json(mapCorporateAccount(db.prepare('SELECT * FROM corporate_accounts WHERE id = ?').get(result.lastInsertRowid)));
  }
  db.prepare('UPDATE corporate_accounts SET name = ?, discount_percent = ? WHERE id = ?').run(
    body.name,
    discountPercent,
    parseInt(body.id, 10)
  );
  res.json(mapCorporateAccount(db.prepare('SELECT * FROM corporate_accounts WHERE id = ?').get(parseInt(body.id, 10))));
});

router.delete('/corporate-account/:id', (req, res) => {
  getDb().prepare('DELETE FROM corporate_accounts WHERE id = ?').run(parseInt(req.params.id, 10));
  res.sendStatus(200);
});

export default router;
