import { Router } from 'express';
import { getDb } from '../db.js';

const router = Router();

function parseItems(itemsJson) {
  try {
    const items = JSON.parse(itemsJson || '[]');
    return Array.isArray(items) ? items : [];
  } catch {
    return [];
  }
}

function dateRange(req) {
  const start = req.query.start ? String(req.query.start) : new Date(0).toISOString();
  const end = req.query.end ? String(req.query.end) : new Date().toISOString();
  return { start, end };
}

// Weighted-average unit cost per product, derived from every goods receipt batch recorded for
// it (see server/routes/inventory.js — every GRN line creates a product_batches row, whether or
// not the product is lot/expiry tracked). This is an approximation: sales aren't attributed to
// specific batches, so margin here is "revenue vs. average landed cost," not FIFO/LIFO-exact.
function averageCostByProduct(db) {
  const rows = db
    .prepare(
      `SELECT product_id, SUM(unit_cost * qty_on_hand) AS cost_total, SUM(qty_on_hand) AS qty_total
       FROM product_batches GROUP BY product_id`
    )
    .all();
  const map = new Map();
  for (const row of rows) {
    map.set(row.product_id, row.qty_total > 0 ? row.cost_total / row.qty_total : 0);
  }
  return map;
}

router.get('/daily-sales', (req, res) => {
  const db = getDb();
  const { start, end } = dateRange(req);
  const rows = db
    .prepare(
      `SELECT substr(date, 1, 10) AS day, COUNT(*) AS transaction_count, SUM(total) AS sales_total,
              SUM(discount) AS discount_total
       FROM transactions
       WHERE status = 1 AND date >= ? AND date <= ?
       GROUP BY day ORDER BY day ASC`
    )
    .all(start, end);
  res.json(rows);
});

router.get('/profit-margin', (req, res) => {
  const db = getDb();
  const { start, end } = dateRange(req);
  const costByProduct = averageCostByProduct(db);
  const products = new Map(db.prepare('SELECT id, name FROM products').all().map((p) => [p.id, p.name]));

  const sales = db
    .prepare(`SELECT items_json FROM transactions WHERE status = 1 AND date >= ? AND date <= ?`)
    .all(start, end);

  const byProduct = new Map();
  for (const row of sales) {
    for (const item of parseItems(row.items_json)) {
      const id = parseInt(item.id ?? item._id, 10);
      const qty = parseInt(item.quantity, 10) || 0;
      const price = parseFloat(item.price) || 0;
      if (!id || !qty) continue;
      const entry = byProduct.get(id) || { productId: id, qty_sold: 0, revenue: 0 };
      entry.qty_sold += qty;
      entry.revenue += price * qty;
      byProduct.set(id, entry);
    }
  }

  const report = Array.from(byProduct.values()).map((entry) => {
    const avgCost = costByProduct.get(entry.productId) ?? 0;
    const costOfGoods = avgCost * entry.qty_sold;
    const profit = entry.revenue - costOfGoods;
    return {
      product_id: entry.productId,
      product_name: products.get(entry.productId) || `#${entry.productId}`,
      qty_sold: entry.qty_sold,
      revenue: entry.revenue,
      cost_of_goods: costOfGoods,
      profit,
      margin_pct: entry.revenue > 0 ? (profit / entry.revenue) * 100 : 0,
      has_cost_data: avgCost > 0,
    };
  });

  report.sort((a, b) => b.revenue - a.revenue);
  res.json(report);
});

router.get('/cashier-performance', (req, res) => {
  const db = getDb();
  const { start, end } = dateRange(req);
  const sales = db
    .prepare(
      `SELECT user_id, user_name, COUNT(*) AS transaction_count, SUM(total) AS sales_total
       FROM transactions WHERE status = 1 AND date >= ? AND date <= ? GROUP BY user_id`
    )
    .all(start, end);
  const refunds = db
    .prepare(
      `SELECT user_id, COUNT(*) AS refund_void_count
       FROM transactions WHERE status IN (2, 3) AND date >= ? AND date <= ? GROUP BY user_id`
    )
    .all(start, end);
  const refundMap = new Map(refunds.map((r) => [r.user_id, r.refund_void_count]));

  const report = sales.map((row) => ({
    user_id: row.user_id,
    user_name: row.user_name,
    transaction_count: row.transaction_count,
    sales_total: row.sales_total,
    average_sale: row.transaction_count > 0 ? row.sales_total / row.transaction_count : 0,
    refund_void_count: refundMap.get(row.user_id) || 0,
  }));
  report.sort((a, b) => b.sales_total - a.sales_total);
  res.json(report);
});

router.get('/movers', (req, res) => {
  const db = getDb();
  const { start, end } = dateRange(req);
  const limit = parseInt(req.query.limit, 10) || 10;
  const products = db.prepare('SELECT id, name, quantity FROM products').all();
  const sales = db
    .prepare(`SELECT items_json FROM transactions WHERE status = 1 AND date >= ? AND date <= ?`)
    .all(start, end);

  const qtySoldByProduct = new Map();
  for (const row of sales) {
    for (const item of parseItems(row.items_json)) {
      const id = parseInt(item.id ?? item._id, 10);
      const qty = parseInt(item.quantity, 10) || 0;
      if (!id || !qty) continue;
      qtySoldByProduct.set(id, (qtySoldByProduct.get(id) || 0) + qty);
    }
  }

  const rows = products.map((p) => ({
    product_id: p.id,
    product_name: p.name,
    on_hand: p.quantity,
    qty_sold: qtySoldByProduct.get(p.id) || 0,
  }));

  const fastMovers = [...rows].sort((a, b) => b.qty_sold - a.qty_sold).slice(0, limit);
  const slowMovers = [...rows]
    .filter((r) => r.qty_sold === 0)
    .sort((a, b) => b.on_hand - a.on_hand)
    .slice(0, limit);

  res.json({ fast_movers: fastMovers, slow_movers: slowMovers });
});

router.get('/stock-valuation', (_req, res) => {
  const db = getDb();
  const costByProduct = averageCostByProduct(db);
  const products = db.prepare('SELECT id, name, price, quantity FROM products').all();

  const rows = products.map((p) => {
    const avgCost = costByProduct.get(p.id) ?? 0;
    return {
      product_id: p.id,
      product_name: p.name,
      quantity: p.quantity,
      retail_value: p.price * p.quantity,
      cost_value: avgCost * p.quantity,
      has_cost_data: avgCost > 0,
    };
  });

  const totals = rows.reduce(
    (acc, r) => ({
      retail_value: acc.retail_value + r.retail_value,
      cost_value: acc.cost_value + r.cost_value,
    }),
    { retail_value: 0, cost_value: 0 }
  );

  res.json({ products: rows, totals });
});

router.get('/controlled-register', (req, res) => {
  const db = getDb();
  const { start, end } = dateRange(req);
  const rows = db
    .prepare(
      `SELECT csl.*, p.name AS product_name, c.name AS patient_name,
              du.fullname AS dispensing_user_name, au.fullname AS approving_user_name
       FROM controlled_substance_log csl
       JOIN products p ON p.id = csl.product_id
       LEFT JOIN customers c ON c.id = csl.patient_id
       LEFT JOIN users du ON du.id = csl.dispensing_user_id
       LEFT JOIN users au ON au.id = csl.approving_user_id
       WHERE csl.created_at >= ? AND csl.created_at <= ?
       ORDER BY csl.created_at DESC`
    )
    .all(start, end);
  res.json(rows);
});

export default router;
