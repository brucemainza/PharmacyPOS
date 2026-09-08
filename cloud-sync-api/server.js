import express from 'express';
import { applyPush, getChangesSince } from './store.js';
import { getPool } from './db.js';
import { runMigrations } from './migrate.js';

export function createSyncApiServer() {
  const app = express();
  app.use(express.json({ limit: '5mb' }));

  app.get('/health', async (_req, res) => {
    try {
      await getPool().query('SELECT 1');
      res.json({ status: 'ok', db: 'ok' });
    } catch (err) {
      res.status(503).json({ status: 'error', db: 'unreachable', error: err.message });
    }
  });

  app.post('/sync/push', async (req, res, next) => {
    const records = req.body?.records;
    if (!Array.isArray(records)) {
      return res.status(400).json({ error: 'records must be an array' });
    }
    try {
      const result = await applyPush(records);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.get('/sync/pull', async (req, res, next) => {
    const { entityType, cursor } = req.query;
    if (!entityType) {
      return res.status(400).json({ error: 'entityType is required' });
    }
    try {
      const result = await getChangesSince(String(entityType), cursor ? String(cursor) : null);
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: err.message || 'sync-api error' });
  });

  return app;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = process.env.PORT || 8787;
  runMigrations()
    .then(() => {
      const app = createSyncApiServer();
      app.listen(port, () => {
        console.log(`MediPOS cloud sync API listening on :${port}`);
      });
    })
    .catch((err) => {
      console.error('sync-api: failed to start (migration error)', err);
      process.exit(1);
    });
}
