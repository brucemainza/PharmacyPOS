import { Router } from 'express';
import { getDb, mapUser } from '../db.js';
import {
  authenticate,
  requirePerm,
  loginUser,
  signToken,
  hashPassword,
} from '../auth.js';

const router = Router();

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password required' });
  }
  const user = loginUser(username, password);
  if (!user) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  const token = signToken(user);
  res.json({ user, token });
});

router.get('/check', (_req, res) => {
  const admin = getDb().prepare('SELECT id FROM users WHERE id = 1').get();
  res.json({ ready: !!admin });
});

router.use(authenticate);

router.get('/user/:userId', (req, res) => {
  const row = getDb()
    .prepare('SELECT * FROM users WHERE id = ?')
    .get(parseInt(req.params.userId, 10));
  res.json(mapUser(row));
});

router.get('/logout/:userId', (req, res) => {
  getDb()
    .prepare('UPDATE users SET status = ? WHERE id = ?')
    .run(`Logged Out_${new Date().toISOString()}`, parseInt(req.params.userId, 10));
  res.sendStatus(200);
});

router.get('/all', requirePerm('perm_users'), (_req, res) => {
  const rows = getDb().prepare('SELECT * FROM users ORDER BY id').all();
  res.json(rows.map(mapUser));
});

router.delete(
  '/user/:userId',
  requirePerm('perm_users'),
  (req, res) => {
    const id = parseInt(req.params.userId, 10);
    if (id === 1) {
      return res.status(400).json({ error: 'Cannot delete the default admin' });
    }
    getDb().prepare('DELETE FROM users WHERE id = ?').run(id);
    res.sendStatus(200);
  }
);

router.post('/post', requirePerm('perm_users'), (req, res) => {
  const body = req.body || {};
  const perms = {
    perm_products: body.perm_products ? 1 : 0,
    perm_categories: body.perm_categories ? 1 : 0,
    perm_transactions: body.perm_transactions ? 1 : 0,
    perm_users: body.perm_users ? 1 : 0,
    perm_settings: body.perm_settings ? 1 : 0,
    perm_discount_approve: body.perm_discount_approve ? 1 : 0,
    perm_refund_void: body.perm_refund_void ? 1 : 0,
    perm_controlled_approve: body.perm_controlled_approve ? 1 : 0,
    perm_price_override: body.perm_price_override ? 1 : 0,
  };
  const role = ['cashier', 'pharmacist', 'manager', 'admin', 'tech'].includes(body.role)
    ? body.role
    : 'cashier';

  if (!body.id) {
    const result = getDb()
      .prepare(
        `INSERT INTO users (
          username, password, fullname, role,
          perm_products, perm_categories, perm_transactions, perm_users, perm_settings,
          perm_discount_approve, perm_refund_void, perm_controlled_approve, perm_price_override
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        body.username,
        hashPassword(body.password || 'password'),
        body.fullname || '',
        role,
        perms.perm_products,
        perms.perm_categories,
        perms.perm_transactions,
        perms.perm_users,
        perms.perm_settings,
        perms.perm_discount_approve,
        perms.perm_refund_void,
        perms.perm_controlled_approve,
        perms.perm_price_override
      );
    const row = getDb().prepare('SELECT * FROM users WHERE id = ?').get(result.lastInsertRowid);
    return res.json(mapUser(row));
  }

  const id = parseInt(body.id, 10);
  if (body.password) {
    getDb()
      .prepare(
        `UPDATE users SET username = ?, password = ?, fullname = ?, role = ?,
         perm_products = ?, perm_categories = ?, perm_transactions = ?, perm_users = ?, perm_settings = ?,
         perm_discount_approve = ?, perm_refund_void = ?, perm_controlled_approve = ?, perm_price_override = ?
         WHERE id = ?`
      )
      .run(
        body.username,
        hashPassword(body.password),
        body.fullname || '',
        role,
        perms.perm_products,
        perms.perm_categories,
        perms.perm_transactions,
        perms.perm_users,
        perms.perm_settings,
        perms.perm_discount_approve,
        perms.perm_refund_void,
        perms.perm_controlled_approve,
        perms.perm_price_override,
        id
      );
  } else {
    getDb()
      .prepare(
        `UPDATE users SET username = ?, fullname = ?, role = ?,
         perm_products = ?, perm_categories = ?, perm_transactions = ?, perm_users = ?, perm_settings = ?,
         perm_discount_approve = ?, perm_refund_void = ?, perm_controlled_approve = ?, perm_price_override = ?
         WHERE id = ?`
      )
      .run(
        body.username,
        body.fullname || '',
        role,
        perms.perm_products,
        perms.perm_categories,
        perms.perm_transactions,
        perms.perm_users,
        perms.perm_settings,
        perms.perm_discount_approve,
        perms.perm_refund_void,
        perms.perm_controlled_approve,
        perms.perm_price_override,
        id
      );
  }
  res.sendStatus(200);
});

// Verifies a *different* user's credentials + a required permission, without switching the
// caller's session — used for supervisor overrides (e.g. a manager authorizing a cashier's
// above-threshold discount) right at the till.
router.post('/authorize', (req, res) => {
  const { username, password, perm } = req.body || {};
  if (!username || !password || !perm) {
    return res.status(400).json({ error: 'username, password, and perm are required' });
  }
  const user = loginUser(username, password);
  if (!user) {
    return res.status(401).json({ error: 'Incorrect username or password' });
  }
  if (user.id !== 1 && !user[perm]) {
    return res.status(403).json({ error: `${user.fullname || user.username} cannot approve this` });
  }
  res.json({ id: user.id, fullname: user.fullname, username: user.username });
});

export default router;
