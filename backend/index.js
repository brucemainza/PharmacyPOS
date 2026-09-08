import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { initDatabase } from './db.js';
import { setJwtSecret, authenticate, requirePerm } from './auth.js';
import usersRouter from './routes/users.js';
import inventoryRouter from './routes/inventory.js';
import categoriesRouter from './routes/categories.js';
import customersRouter from './routes/customers.js';
import settingsRouter from './routes/settings.js';
import transactionsRouter from './routes/transactions.js';
import mediaRouter from './routes/media.js';
import demoRouter from './routes/demo.js';
import paymentsRouter, { paymentsWebhookRouter } from './routes/payments.js';
import prescriptionsRouter from './routes/prescriptions.js';
import analyticsRouter from './routes/analytics.js';

export async function createServer({ dbPath, uploadsPath, jwtSecret }) {
  fs.mkdirSync(uploadsPath, { recursive: true });
  fs.mkdirSync(path.join(uploadsPath, 'library'), { recursive: true });
  await initDatabase(dbPath);
  setJwtSecret(jwtSecret);

  const app = express();

  app.use(
    cors({
      origin: true,
      credentials: true,
    })
  );
  app.use(
    express.json({
      limit: '10mb',
      // Retained verbatim (not re-derived from req.body) so Lenco webhook signature
      // verification hashes the exact bytes Lenco signed — see server/routes/payments.js.
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );
  app.use(express.urlencoded({ extended: true }));
  app.use('/uploads', express.static(uploadsPath));

  app.get('/', (_req, res) => {
    res.json({ status: 'ok', message: 'POS Server Online.' });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/api/users', usersRouter);
  app.use('/api/payments/webhook', paymentsWebhookRouter);
  app.use('/api/payments', authenticate, paymentsRouter);
  app.use('/api/inventory', authenticate, inventoryRouter(uploadsPath));
  app.use('/api/categories', authenticate, categoriesRouter);
  app.use('/api/customers', authenticate, customersRouter);
  app.use('/api/settings', authenticate, settingsRouter(uploadsPath));
  app.use('/api/media', authenticate, mediaRouter(uploadsPath));
  app.use('/api/demo', authenticate, demoRouter);
  app.use('/api/prescriptions', authenticate, prescriptionsRouter);
  app.use('/api/analytics', authenticate, requirePerm('perm_transactions'), analyticsRouter);
  app.use('/api', authenticate, transactionsRouter);

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'Server error' });
  });

  return app;
}
