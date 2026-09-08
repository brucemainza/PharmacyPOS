import initSqlJs from 'sql.js';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import bcrypt from 'bcryptjs';
import { getOrCreateKey, encryptBuffer, decryptBuffer, isEncrypted } from './encryption.js';

const require = createRequire(import.meta.url);

let SQL = null;
let db = null;
let rawDb = null;
let dbPath = null;
let dbKey = null;
let persistTimer = null;

function persist() {
  if (!rawDb || !dbPath) return;
  const data = Buffer.from(rawDb.export());
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.writeFileSync(dbPath, encryptBuffer(data, dbKey));
}

function schedulePersist() {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persist();
    persistTimer = null;
  }, 50);
}

function wrapDb(raw) {
  return {
    exec(sql) {
      raw.exec(sql);
      schedulePersist();
    },
    prepare(sql) {
      return {
        run(...params) {
          raw.run(sql, params);
          schedulePersist();
          const changes = raw.getRowsModified();
          let lastInsertRowid = 0;
          try {
            const stmt = raw.prepare('SELECT last_insert_rowid() AS id');
            if (stmt.step()) {
              lastInsertRowid = stmt.getAsObject().id;
            }
            stmt.free();
          } catch {
            /* ignore */
          }
          return { changes, lastInsertRowid };
        },
        get(...params) {
          const stmt = raw.prepare(sql);
          stmt.bind(params);
          let row = null;
          if (stmt.step()) {
            row = stmt.getAsObject();
          }
          stmt.free();
          return row || undefined;
        },
        all(...params) {
          const stmt = raw.prepare(sql);
          stmt.bind(params);
          const rows = [];
          while (stmt.step()) {
            rows.push(stmt.getAsObject());
          }
          stmt.free();
          return rows;
        },
      };
    },
    transaction(fn) {
      return (...args) => {
        raw.run('BEGIN');
        try {
          const result = fn(...args);
          raw.run('COMMIT');
          schedulePersist();
          return result;
        } catch (err) {
          raw.run('ROLLBACK');
          throw err;
        }
      };
    },
    pragma() {
      /* no-op for sql.js compatibility */
    },
  };
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

// Versioned schema migrations. Each migration runs exactly once, in order, tracked in
// `schema_migrations`. Migration 1 is the pre-existing generic-POS baseline (kept CREATE TABLE
// IF NOT EXISTS / column-existence-checked so it's a safe no-op against a database that already
// has these tables from before migrations were tracked). Later migrations are additive-only.
const MIGRATIONS = [
  {
    version: 1,
    description: 'baseline generic-POS schema',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT NOT NULL UNIQUE,
          password TEXT NOT NULL,
          fullname TEXT NOT NULL DEFAULT '',
          perm_products INTEGER NOT NULL DEFAULT 0,
          perm_categories INTEGER NOT NULL DEFAULT 0,
          perm_transactions INTEGER NOT NULL DEFAULT 0,
          perm_users INTEGER NOT NULL DEFAULT 0,
          perm_settings INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS categories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS products (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          price REAL NOT NULL DEFAULT 0,
          category TEXT NOT NULL DEFAULT '',
          quantity INTEGER NOT NULL DEFAULT 0,
          stock INTEGER NOT NULL DEFAULT 1,
          img TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS customers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          phone TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          address TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS settings (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          app TEXT NOT NULL DEFAULT 'Standalone Point of Sale',
          store TEXT NOT NULL DEFAULT '',
          address_one TEXT NOT NULL DEFAULT '',
          address_two TEXT NOT NULL DEFAULT '',
          contact TEXT NOT NULL DEFAULT '',
          tax TEXT NOT NULL DEFAULT '',
          symbol TEXT NOT NULL DEFAULT 'ZMW ',
          percentage REAL NOT NULL DEFAULT 0,
          charge_tax INTEGER NOT NULL DEFAULT 0,
          footer TEXT NOT NULL DEFAULT '',
          img TEXT NOT NULL DEFAULT '',
          till INTEGER NOT NULL DEFAULT 1,
          server_ip TEXT NOT NULL DEFAULT '',
          pexels_api_key TEXT NOT NULL DEFAULT ''
        );

        CREATE TABLE IF NOT EXISTS media_library (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          filename TEXT NOT NULL UNIQUE,
          source TEXT NOT NULL DEFAULT 'upload',
          pexels_id INTEGER,
          photographer TEXT NOT NULL DEFAULT '',
          alt TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS transactions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          ref_number TEXT NOT NULL DEFAULT '',
          customer TEXT NOT NULL DEFAULT '0',
          customer_name TEXT NOT NULL DEFAULT '',
          status INTEGER NOT NULL DEFAULT 1,
          user_id INTEGER NOT NULL DEFAULT 0,
          user_name TEXT NOT NULL DEFAULT '',
          till INTEGER NOT NULL DEFAULT 1,
          discount REAL NOT NULL DEFAULT 0,
          subtotal REAL NOT NULL DEFAULT 0,
          tax REAL NOT NULL DEFAULT 0,
          total REAL NOT NULL DEFAULT 0,
          paid REAL NOT NULL DEFAULT 0,
          change REAL NOT NULL DEFAULT 0,
          payment_type INTEGER NOT NULL DEFAULT 1,
          items_json TEXT NOT NULL DEFAULT '[]',
          date TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
        CREATE INDEX IF NOT EXISTS idx_transactions_status ON transactions(status);
        CREATE INDEX IF NOT EXISTS idx_transactions_user ON transactions(user_id);
        CREATE INDEX IF NOT EXISTS idx_transactions_till ON transactions(till);
        CREATE INDEX IF NOT EXISTS idx_products_name ON products(name);
      `);

      const cols = db.prepare('PRAGMA table_info(settings)').all();
      const names = new Set(cols.map((c) => c.name));
      if (!names.has('pexels_api_key')) {
        db.exec(`ALTER TABLE settings ADD COLUMN pexels_api_key TEXT NOT NULL DEFAULT ''`);
      }
    },
  },
  {
    version: 2,
    description: 'pharmacy product/supplier extensions',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS suppliers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          contact TEXT NOT NULL DEFAULT '',
          email TEXT NOT NULL DEFAULT '',
          phone TEXT NOT NULL DEFAULT '',
          address TEXT NOT NULL DEFAULT ''
        );

        ALTER TABLE products ADD COLUMN batch_tracked INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE products ADD COLUMN controlled_substance INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE products ADD COLUMN generic_group TEXT NOT NULL DEFAULT '';
        ALTER TABLE products ADD COLUMN reorder_level INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE products ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id);
      `);
    },
  },
  {
    version: 3,
    description: 'batch/lot + expiry tracking',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS product_batches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL REFERENCES products(id),
          batch_no TEXT NOT NULL,
          expiry_date TEXT NOT NULL DEFAULT '',
          qty_on_hand INTEGER NOT NULL DEFAULT 0,
          supplier_id INTEGER REFERENCES suppliers(id),
          received_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_product_batches_product ON product_batches(product_id);
        CREATE INDEX IF NOT EXISTS idx_product_batches_expiry ON product_batches(expiry_date);
      `);
    },
  },
  {
    version: 4,
    description: 'append-only stock movement ledger',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS stock_movements (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          product_id INTEGER NOT NULL REFERENCES products(id),
          batch_id INTEGER REFERENCES product_batches(id),
          movement_type TEXT NOT NULL,
          qty_delta INTEGER NOT NULL,
          ref_type TEXT NOT NULL DEFAULT '',
          ref_id INTEGER,
          user_id INTEGER NOT NULL DEFAULT 0,
          branch_id INTEGER NOT NULL DEFAULT 1,
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_stock_movements_product ON stock_movements(product_id);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_created ON stock_movements(created_at);
        CREATE INDEX IF NOT EXISTS idx_stock_movements_ref ON stock_movements(ref_type, ref_id);
      `);
    },
  },
  {
    version: 5,
    description: 'customer/patient extensions',
    up(db) {
      db.exec(`
        ALTER TABLE customers ADD COLUMN date_of_birth TEXT NOT NULL DEFAULT '';
        ALTER TABLE customers ADD COLUMN allergies TEXT NOT NULL DEFAULT '';
        ALTER TABLE customers ADD COLUMN loyalty_points INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE customers ADD COLUMN corporate_account_id INTEGER;
        ALTER TABLE customers ADD COLUMN insurance_ref TEXT NOT NULL DEFAULT '';
      `);
    },
  },
  {
    version: 6,
    description: 'prescriptions + prescription line items',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS prescriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          patient_id INTEGER NOT NULL REFERENCES customers(id),
          prescriber_name TEXT NOT NULL DEFAULT '',
          prescriber_reg_no TEXT NOT NULL DEFAULT '',
          date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_prescriptions_patient ON prescriptions(patient_id);

        CREATE TABLE IF NOT EXISTS prescription_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prescription_id INTEGER NOT NULL REFERENCES prescriptions(id),
          product_id INTEGER NOT NULL REFERENCES products(id),
          prescribed_qty INTEGER NOT NULL DEFAULT 0,
          dispensed_qty INTEGER NOT NULL DEFAULT 0,
          substituted_product_id INTEGER REFERENCES products(id),
          partial_fill_state TEXT NOT NULL DEFAULT 'none',
          pharmacist_user_id INTEGER,
          approved_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_prescription_items_prescription ON prescription_items(prescription_id);
      `);
    },
  },
  {
    version: 7,
    description: 'immutable controlled-substance dispensing log',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS controlled_substance_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          prescription_item_id INTEGER REFERENCES prescription_items(id),
          transaction_id INTEGER REFERENCES transactions(id),
          product_id INTEGER NOT NULL REFERENCES products(id),
          batch_id INTEGER REFERENCES product_batches(id),
          qty INTEGER NOT NULL,
          dispensing_user_id INTEGER NOT NULL,
          approving_user_id INTEGER NOT NULL,
          patient_id INTEGER REFERENCES customers(id),
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_controlled_log_product ON controlled_substance_log(product_id);
        CREATE INDEX IF NOT EXISTS idx_controlled_log_created ON controlled_substance_log(created_at);
      `);
    },
  },
  {
    version: 8,
    description: 'immutable generic audit log',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS audit_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL,
          entity_id INTEGER,
          action TEXT NOT NULL,
          user_id INTEGER NOT NULL DEFAULT 0,
          before_json TEXT NOT NULL DEFAULT '',
          after_json TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON audit_log(entity_type, entity_id);
        CREATE INDEX IF NOT EXISTS idx_audit_log_created ON audit_log(created_at);
      `);
    },
  },
  {
    version: 9,
    description: 'user roles + workflow approval permissions',
    up(db) {
      db.exec(`
        ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'cashier';
        ALTER TABLE users ADD COLUMN perm_discount_approve INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN perm_refund_void INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN perm_controlled_approve INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN perm_price_override INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 10,
    description: 'offline sync outbox + pull cursor',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sync_outbox (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          op TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          idempotency_key TEXT NOT NULL,
          created_at TEXT NOT NULL,
          synced INTEGER NOT NULL DEFAULT 0,
          synced_at TEXT
        );

        CREATE INDEX IF NOT EXISTS idx_sync_outbox_synced ON sync_outbox(synced);
        CREATE UNIQUE INDEX IF NOT EXISTS idx_sync_outbox_idempotency ON sync_outbox(idempotency_key);

        CREATE TABLE IF NOT EXISTS sync_cursor (
          entity_type TEXT PRIMARY KEY,
          last_pulled_at TEXT
        );
      `);
    },
  },
  {
    version: 11,
    description: 'payment gateway records (cash + Lenco card/mobile money)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS payments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          transaction_id INTEGER REFERENCES transactions(id),
          provider TEXT NOT NULL,
          method TEXT NOT NULL,
          reference TEXT NOT NULL,
          provider_reference TEXT,
          amount REAL NOT NULL,
          currency TEXT NOT NULL DEFAULT 'ZMW',
          status TEXT NOT NULL DEFAULT 'pending',
          reason_for_failure TEXT,
          redirect_url TEXT,
          raw_response_json TEXT NOT NULL DEFAULT '{}',
          webhook_payload_json TEXT,
          idempotency_key TEXT NOT NULL,
          initiated_at TEXT NOT NULL,
          confirmed_at TEXT
        );

        CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_reference ON payments(reference);
        CREATE INDEX IF NOT EXISTS idx_payments_transaction ON payments(transaction_id);
        CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
      `);
    },
  },
  {
    version: 12,
    description: 'discount approval, refund/void tracking, cash-up (Z-report)',
    up(db) {
      db.exec(`
        ALTER TABLE settings ADD COLUMN discount_approval_threshold REAL NOT NULL DEFAULT 10;
        ALTER TABLE transactions ADD COLUMN discount_approved_by INTEGER;
        ALTER TABLE transactions ADD COLUMN void_refund_reason TEXT NOT NULL DEFAULT '';

        CREATE TABLE IF NOT EXISTS cash_ups (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          till INTEGER NOT NULL,
          business_date TEXT NOT NULL,
          opened_by INTEGER NOT NULL,
          sales_total REAL NOT NULL DEFAULT 0,
          cash_total REAL NOT NULL DEFAULT 0,
          card_total REAL NOT NULL DEFAULT 0,
          mobile_money_total REAL NOT NULL DEFAULT 0,
          refunds_total REAL NOT NULL DEFAULT 0,
          transaction_count INTEGER NOT NULL DEFAULT 0,
          expected_cash REAL NOT NULL DEFAULT 0,
          counted_cash REAL NOT NULL DEFAULT 0,
          variance REAL NOT NULL DEFAULT 0,
          notes TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_cash_ups_till_date ON cash_ups(till, business_date);
      `);
    },
  },
  {
    version: 13,
    description: 'inventory: branches, stock transfers, stock takes',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS branches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          is_local INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS stock_transfers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          from_branch_id INTEGER NOT NULL REFERENCES branches(id),
          to_branch_id INTEGER NOT NULL REFERENCES branches(id),
          status TEXT NOT NULL DEFAULT 'pending',
          notes TEXT NOT NULL DEFAULT '',
          created_by INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          received_by INTEGER,
          received_at TEXT
        );

        CREATE TABLE IF NOT EXISTS stock_transfer_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          stock_transfer_id INTEGER NOT NULL REFERENCES stock_transfers(id),
          product_id INTEGER NOT NULL REFERENCES products(id),
          batch_id INTEGER REFERENCES product_batches(id),
          qty INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_stock_transfer_items_transfer ON stock_transfer_items(stock_transfer_id);

        CREATE TABLE IF NOT EXISTS stock_takes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          business_date TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'open',
          created_by INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          completed_at TEXT
        );

        CREATE TABLE IF NOT EXISTS stock_take_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          stock_take_id INTEGER NOT NULL REFERENCES stock_takes(id),
          product_id INTEGER NOT NULL REFERENCES products(id),
          expected_qty INTEGER NOT NULL DEFAULT 0,
          counted_qty INTEGER,
          variance INTEGER
        );

        CREATE INDEX IF NOT EXISTS idx_stock_take_items_take ON stock_take_items(stock_take_id);
      `);
    },
  },
  {
    version: 14,
    description: 'corporate accounts + loyalty point accrual',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS corporate_accounts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          discount_percent REAL NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );

        ALTER TABLE settings ADD COLUMN loyalty_earn_rate REAL NOT NULL DEFAULT 0.1;
        ALTER TABLE transactions ADD COLUMN loyalty_points_earned INTEGER NOT NULL DEFAULT 0;
      `);
    },
  },
  {
    version: 15,
    description: 'batch unit cost (for profit/margin and stock valuation reporting)',
    up(db) {
      db.exec(`ALTER TABLE product_batches ADD COLUMN unit_cost REAL NOT NULL DEFAULT 0;`);
    },
  },
];

function runMigrations(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      description TEXT NOT NULL DEFAULT '',
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map((row) => row.version)
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    migration.up(db);
    db.prepare(
      'INSERT INTO schema_migrations (version, description, applied_at) VALUES (?, ?, ?)'
    ).run(migration.version, migration.description, new Date().toISOString());
  }
}

export async function initDatabase(filePath) {
  dbPath = filePath;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  dbKey = getOrCreateKey(filePath);

  if (!SQL) {
    const wasmPath = path.join(
      path.dirname(require.resolve('sql.js')),
      'sql-wasm.wasm'
    );
    SQL = await initSqlJs({
      locateFile: () => wasmPath,
    });
  }

  if (fs.existsSync(filePath)) {
    const fileBuffer = fs.readFileSync(filePath);
    // Transparently loads a pre-encryption plaintext SQLite file too (no migration step
    // needed) — it gets re-persisted encrypted the moment anything writes to it.
    const raw = isEncrypted(fileBuffer) ? decryptBuffer(fileBuffer, dbKey) : fileBuffer;
    rawDb = new SQL.Database(raw);
  } else {
    rawDb = new SQL.Database();
  }
  db = wrapDb(rawDb);

  runMigrations(db);
  seedDefaults();
  persist();
  return db;
}

function seedDefaults() {
  const admin = db.prepare('SELECT id FROM users WHERE id = 1').get();
  if (!admin) {
    const hash = bcrypt.hashSync('admin', 10);
    db.prepare(
      `INSERT INTO users (id, username, password, fullname, perm_products, perm_categories, perm_transactions, perm_users, perm_settings, role)
       VALUES (1, 'admin', ?, 'Administrator', 1, 1, 1, 1, 1, 'manager')`
    ).run(hash);
  }

  const settings = db.prepare('SELECT id FROM settings WHERE id = 1').get();
  if (!settings) {
    db.prepare(
      `INSERT INTO settings (id, app, store, symbol, percentage, charge_tax, till)
       VALUES (1, 'Standalone Point of Sale', 'My Store', 'ZMW ', 0, 0, 1)`
    ).run();
  }

  const walkIn = db.prepare("SELECT id FROM customers WHERE name = 'Walk-in Customer'").get();
  if (!walkIn) {
    db.prepare(
      `INSERT INTO customers (name, phone, email, address) VALUES ('Walk-in Customer', '', '', '')`
    ).run();
  }

  const localBranch = db.prepare('SELECT id FROM branches WHERE is_local = 1').get();
  if (!localBranch) {
    db.prepare(
      `INSERT INTO branches (name, is_local, created_at) VALUES ('Main Branch', 1, ?)`
    ).run(new Date().toISOString());
  }
}

// Appends a stock movement to the ledger. Current stock is derived from the sum of movements
// per product (and per batch, where batch-tracked) rather than an absolute overwrite — callers
// never decrement `products.quantity`/`product_batches.qty_on_hand` directly for anything that
// should be auditable; they record the movement here instead.
export function recordStockMovement(db, {
  productId,
  batchId = null,
  movementType,
  qtyDelta,
  refType = '',
  refId = null,
  userId = 0,
  branchId = 1,
  notes = '',
}) {
  const createdAt = new Date().toISOString();
  const result = db
    .prepare(
      `INSERT INTO stock_movements
        (product_id, batch_id, movement_type, qty_delta, ref_type, ref_id, user_id, branch_id, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(productId, batchId, movementType, qtyDelta, refType, refId, userId, branchId, notes, createdAt);
  return result.lastInsertRowid;
}

export function mapUser(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    username: row.username,
    fullname: row.fullname,
    role: row.role,
    perm_products: row.perm_products,
    perm_categories: row.perm_categories,
    perm_transactions: row.perm_transactions,
    perm_users: row.perm_users,
    perm_settings: row.perm_settings,
    perm_discount_approve: row.perm_discount_approve,
    perm_refund_void: row.perm_refund_void,
    perm_controlled_approve: row.perm_controlled_approve,
    perm_price_override: row.perm_price_override,
    status: row.status,
  };
}

export function mapProduct(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    price: row.price,
    category: row.category,
    quantity: row.quantity,
    stock: row.stock,
    img: row.img,
    batch_tracked: !!row.batch_tracked,
    controlled_substance: !!row.controlled_substance,
    generic_group: row.generic_group,
    reorder_level: row.reorder_level,
    supplier_id: row.supplier_id,
  };
}

export function mapCategory(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
  };
}

export function mapCustomer(row) {
  if (!row) return null;
  return {
    _id: String(row.id),
    id: row.id,
    name: row.name,
    phone: row.phone,
    email: row.email,
    address: row.address,
    date_of_birth: row.date_of_birth,
    allergies: row.allergies,
    loyalty_points: row.loyalty_points,
    corporate_account_id: row.corporate_account_id,
    insurance_ref: row.insurance_ref,
  };
}

export function mapTransaction(row) {
  if (!row) return null;
  let items = [];
  try {
    items = JSON.parse(row.items_json || '[]');
  } catch {
    items = [];
  }
  return {
    _id: row.id,
    id: row.id,
    ref_number: row.ref_number,
    customer: row.customer,
    customer_name: row.customer_name,
    status: row.status,
    user_id: row.user_id,
    user: row.user_name,
    till: row.till,
    discount: row.discount,
    subtotal: row.subtotal,
    tax: row.tax,
    total: row.total,
    paid: row.paid,
    change: row.change,
    payment_type: row.payment_type,
    discount_approved_by: row.discount_approved_by,
    void_refund_reason: row.void_refund_reason,
    loyalty_points_earned: row.loyalty_points_earned,
    items,
    date: row.date,
  };
}

export function mapSettings(row) {
  if (!row) return null;
  return {
    _id: 1,
    settings: {
      app: row.app,
      store: row.store,
      address_one: row.address_one,
      address_two: row.address_two,
      contact: row.contact,
      tax: row.tax,
      symbol: row.symbol,
      percentage: row.percentage,
      charge_tax: !!row.charge_tax,
      footer: row.footer,
      img: row.img,
      till: row.till,
      ip: row.server_ip,
      pexels_api_key: row.pexels_api_key || '',
      discount_approval_threshold: row.discount_approval_threshold,
      loyalty_earn_rate: row.loyalty_earn_rate,
    },
  };
}

export function mapCorporateAccount(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    discount_percent: row.discount_percent,
    created_at: row.created_at,
  };
}

export function mapCashUp(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    till: row.till,
    business_date: row.business_date,
    opened_by: row.opened_by,
    sales_total: row.sales_total,
    cash_total: row.cash_total,
    card_total: row.card_total,
    mobile_money_total: row.mobile_money_total,
    refunds_total: row.refunds_total,
    transaction_count: row.transaction_count,
    expected_cash: row.expected_cash,
    counted_cash: row.counted_cash,
    variance: row.variance,
    notes: row.notes,
    created_at: row.created_at,
  };
}

export function mapSupplier(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    contact: row.contact,
    email: row.email,
    phone: row.phone,
    address: row.address,
  };
}

export function mapProductBatch(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    product_id: row.product_id,
    batch_no: row.batch_no,
    expiry_date: row.expiry_date,
    qty_on_hand: row.qty_on_hand,
    unit_cost: row.unit_cost,
    supplier_id: row.supplier_id,
    received_at: row.received_at,
  };
}

export function mapStockMovement(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    product_id: row.product_id,
    batch_id: row.batch_id,
    movement_type: row.movement_type,
    qty_delta: row.qty_delta,
    ref_type: row.ref_type,
    ref_id: row.ref_id,
    user_id: row.user_id,
    branch_id: row.branch_id,
    notes: row.notes,
    created_at: row.created_at,
  };
}

export function mapBranch(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    name: row.name,
    is_local: !!row.is_local,
    created_at: row.created_at,
  };
}

export function mapStockTransfer(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    from_branch_id: row.from_branch_id,
    to_branch_id: row.to_branch_id,
    status: row.status,
    notes: row.notes,
    created_by: row.created_by,
    created_at: row.created_at,
    received_by: row.received_by,
    received_at: row.received_at,
  };
}

export function mapStockTake(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    business_date: row.business_date,
    status: row.status,
    created_by: row.created_by,
    created_at: row.created_at,
    completed_at: row.completed_at,
  };
}

export function mapPrescription(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    patient_id: row.patient_id,
    prescriber_name: row.prescriber_name,
    prescriber_reg_no: row.prescriber_reg_no,
    date: row.date,
    status: row.status,
    notes: row.notes,
    created_at: row.created_at,
  };
}

export function mapPrescriptionItem(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    prescription_id: row.prescription_id,
    product_id: row.product_id,
    prescribed_qty: row.prescribed_qty,
    dispensed_qty: row.dispensed_qty,
    substituted_product_id: row.substituted_product_id,
    partial_fill_state: row.partial_fill_state,
    pharmacist_user_id: row.pharmacist_user_id,
    approved_at: row.approved_at,
  };
}

export function mapPayment(row) {
  if (!row) return null;
  return {
    _id: row.id,
    id: row.id,
    transaction_id: row.transaction_id,
    provider: row.provider,
    method: row.method,
    reference: row.reference,
    provider_reference: row.provider_reference,
    amount: row.amount,
    currency: row.currency,
    status: row.status,
    reason_for_failure: row.reason_for_failure,
    redirect_url: row.redirect_url,
    initiated_at: row.initiated_at,
    confirmed_at: row.confirmed_at,
  };
}
