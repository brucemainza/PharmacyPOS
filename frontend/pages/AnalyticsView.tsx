import { useEffect, useState } from 'react';
import { DollarSign, Receipt, Percent, TrendingUp, Package, Wallet } from 'lucide-react';
import {
  api,
  CashierPerformanceRow,
  ControlledRegisterRow,
  DailySales,
  MonthlySalesRow,
  MoverRow,
  ProductBatch,
  ProfitMarginRow,
  StockValuationRow,
} from '../api/client';
import StatCard from '../components/StatCard';
import BarChart from '../components/BarChart';

type Props = { symbol: string };

type Tab = 'sales' | 'margin' | 'cashiers' | 'movers' | 'valuation' | 'expiry' | 'controlled';

const TABS: { id: Tab; label: string }[] = [
  { id: 'sales', label: 'Daily sales' },
  { id: 'margin', label: 'Profit & margin' },
  { id: 'cashiers', label: 'Cashier performance' },
  { id: 'movers', label: 'Fast / slow movers' },
  { id: 'valuation', label: 'Stock valuation' },
  { id: 'expiry', label: 'Near-expiry alerts' },
  { id: 'controlled', label: 'Controlled-items register' },
];

function todayMinus(days: number) {
  return new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
}

export default function AnalyticsView({ symbol }: Props) {
  const [tab, setTab] = useState<Tab>('sales');
  const [start, setStart] = useState(() => todayMinus(30));
  const [end, setEnd] = useState(() => new Date().toISOString().slice(0, 10));

  const range = { start: `${start}T00:00:00.000Z`, end: `${end}T23:59:59.999Z` };

  return (
    <div>
      <div className="row" style={{ gap: '0.5rem', marginBottom: '1rem', flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`btn ${tab === t.id ? 'btn-primary' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab !== 'valuation' && tab !== 'expiry' && (
        <div className="row" style={{ gap: '1rem', marginBottom: '1rem' }}>
          <div className="field">
            <label>From</label>
            <input type="date" value={start} onChange={(e) => setStart(e.target.value)} />
          </div>
          <div className="field">
            <label>To</label>
            <input type="date" value={end} onChange={(e) => setEnd(e.target.value)} />
          </div>
        </div>
      )}

      {tab === 'sales' && <DailySalesTab symbol={symbol} range={range} />}
      {tab === 'margin' && <ProfitMarginTab symbol={symbol} range={range} />}
      {tab === 'cashiers' && <CashierPerformanceTab symbol={symbol} range={range} />}
      {tab === 'movers' && <MoversTab range={range} />}
      {tab === 'valuation' && <StockValuationTab symbol={symbol} />}
      {tab === 'expiry' && <ExpiryAlertsTab />}
      {tab === 'controlled' && <ControlledRegisterTab range={range} />}
    </div>
  );
}

function MonthlySalesChart({ symbol }: { symbol: string }) {
  const [year, setYear] = useState(() => new Date().getFullYear());
  const [months, setMonths] = useState<MonthlySalesRow[]>([]);

  useEffect(() => {
    api
      .getMonthlySales(year)
      .then((res) => setMonths(res.months))
      .catch(() => setMonths([]));
  }, [year]);

  const yearTotal = months.reduce((sum, m) => sum + m.sales_total, 0);

  return (
    <div className="panel" style={{ padding: '1rem', marginBottom: '1rem' }}>
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: '0.5rem' }}>
        <h3 style={{ margin: 0 }}>Sales by month — {year}</h3>
        <div className="row" style={{ gap: '0.5rem', alignItems: 'baseline' }}>
          <span className="muted" style={{ fontSize: '0.85rem' }}>
            Year total: {symbol}
            {yearTotal.toFixed(2)}
          </span>
          <button type="button" className="btn" onClick={() => setYear((y) => y - 1)}>
            ‹
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => setYear((y) => Math.min(y + 1, new Date().getFullYear()))}
            disabled={year >= new Date().getFullYear()}
          >
            ›
          </button>
        </div>
      </div>
      {months.length > 0 ? (
        <BarChart
          data={months.map((m) => ({ label: m.month_label, value: m.sales_total }))}
          formatValue={(v) => `${symbol}${v.toFixed(2)}`}
        />
      ) : (
        <div className="empty">No sales recorded for {year}</div>
      )}
    </div>
  );
}

function DailySalesTab({ symbol, range }: { symbol: string; range: { start: string; end: string } }) {
  const [rows, setRows] = useState<DailySales[]>([]);
  useEffect(() => {
    api.getDailySales(range).then(setRows).catch(() => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end]);

  const totalSales = rows.reduce((sum, r) => sum + r.sales_total, 0);
  const totalTx = rows.reduce((sum, r) => sum + r.transaction_count, 0);
  const totalDiscount = rows.reduce((sum, r) => sum + r.discount_total, 0);
  const avgSale = totalTx > 0 ? totalSales / totalTx : 0;

  return (
    <div>
      <div className="stat-grid">
        <StatCard icon={<DollarSign size={18} />} value={`${symbol}${totalSales.toFixed(2)}`} label="Total sales" sub={`${rows.length} day(s) in range`} />
        <StatCard icon={<Receipt size={18} />} value={totalTx} label="Transactions" tone="info" />
        <StatCard icon={<TrendingUp size={18} />} value={`${symbol}${avgSale.toFixed(2)}`} label="Average sale" tone="accent" />
        <StatCard icon={<Percent size={18} />} value={`${symbol}${totalDiscount.toFixed(2)}`} label="Discounts given" tone="warn" />
      </div>
      <MonthlySalesChart symbol={symbol} />
      <div className="panel" style={{ padding: '1rem' }}>
      <table className="table">
        <thead>
          <tr>
            <th>Day</th>
            <th>Transactions</th>
            <th>Sales</th>
            <th>Discounts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.day}>
              <td>{r.day}</td>
              <td>{r.transaction_count}</td>
              <td>
                {symbol}
                {r.sales_total.toFixed(2)}
              </td>
              <td>
                {symbol}
                {r.discount_total.toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">No sales in this range</div>}
      </div>
    </div>
  );
}

function ProfitMarginTab({ symbol, range }: { symbol: string; range: { start: string; end: string } }) {
  const [rows, setRows] = useState<ProfitMarginRow[]>([]);
  useEffect(() => {
    api.getProfitMargin(range).then(setRows).catch(() => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end]);

  return (
    <div className="panel" style={{ padding: '1rem' }}>
      <p style={{ fontSize: '0.85rem', opacity: 0.75 }}>
        Cost is a weighted average of goods-receipt unit costs, not attributed to specific batches
        sold. Rows without cost data have never had a costed GRN.
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Qty sold</th>
            <th>Revenue</th>
            <th>Cost of goods</th>
            <th>Profit</th>
            <th>Margin</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.product_id}>
              <td>{r.product_name}</td>
              <td>{r.qty_sold}</td>
              <td>
                {symbol}
                {r.revenue.toFixed(2)}
              </td>
              <td>{r.has_cost_data ? `${symbol}${r.cost_of_goods.toFixed(2)}` : '—'}</td>
              <td className={r.has_cost_data && r.profit < 0 ? 'pay-error' : ''}>
                {r.has_cost_data ? `${symbol}${r.profit.toFixed(2)}` : '—'}
              </td>
              <td>{r.has_cost_data ? `${r.margin_pct.toFixed(1)}%` : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">No sales in this range</div>}
    </div>
  );
}

function CashierPerformanceTab({ symbol, range }: { symbol: string; range: { start: string; end: string } }) {
  const [rows, setRows] = useState<CashierPerformanceRow[]>([]);
  useEffect(() => {
    api.getCashierPerformance(range).then(setRows).catch(() => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end]);

  return (
    <div className="panel" style={{ padding: '1rem' }}>
      <table className="table">
        <thead>
          <tr>
            <th>Cashier</th>
            <th>Transactions</th>
            <th>Sales total</th>
            <th>Average sale</th>
            <th>Refunds/voids</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.user_id}>
              <td>{r.user_name || `#${r.user_id}`}</td>
              <td>{r.transaction_count}</td>
              <td>
                {symbol}
                {r.sales_total.toFixed(2)}
              </td>
              <td>
                {symbol}
                {r.average_sale.toFixed(2)}
              </td>
              <td>{r.refund_void_count}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">No sales in this range</div>}
    </div>
  );
}

function MoversTab({ range }: { range: { start: string; end: string } }) {
  const [data, setData] = useState<{ fast_movers: MoverRow[]; slow_movers: MoverRow[] }>({
    fast_movers: [],
    slow_movers: [],
  });
  useEffect(() => {
    api.getMovers(range).then(setData).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end]);

  const table = (rows: MoverRow[]) => (
    <table className="table">
      <thead>
        <tr>
          <th>Product</th>
          <th>Qty sold</th>
          <th>On hand</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.product_id}>
            <td>{r.product_name}</td>
            <td>{r.qty_sold}</td>
            <td>{r.on_hand}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <div className="page-grid">
      <div className="panel" style={{ padding: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Fast movers</h3>
        {table(data.fast_movers)}
        {!data.fast_movers.length && <div className="empty">No sales in this range</div>}
      </div>
      <div className="panel" style={{ padding: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Slow movers (no sales in range)</h3>
        {table(data.slow_movers)}
        {!data.slow_movers.length && <div className="empty">Nothing stagnant right now</div>}
      </div>
    </div>
  );
}

function StockValuationTab({ symbol }: { symbol: string }) {
  const [data, setData] = useState<{
    products: StockValuationRow[];
    totals: { retail_value: number; cost_value: number };
  }>({ products: [], totals: { retail_value: 0, cost_value: 0 } });

  useEffect(() => {
    api.getStockValuation().then(setData).catch(() => undefined);
  }, []);

  return (
    <div>
      <div className="stat-grid">
        <StatCard icon={<Wallet size={18} />} value={`${symbol}${data.totals.retail_value.toFixed(2)}`} label="Retail value" />
        <StatCard icon={<Package size={18} />} value={`${symbol}${data.totals.cost_value.toFixed(2)}`} label="Cost value" tone="info" />
        <StatCard
          icon={<TrendingUp size={18} />}
          value={`${symbol}${(data.totals.retail_value - data.totals.cost_value).toFixed(2)}`}
          label="Potential margin"
          tone="accent"
        />
      </div>
      <div className="panel" style={{ padding: '1rem' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Qty</th>
              <th>Retail value</th>
              <th>Cost value</th>
            </tr>
          </thead>
          <tbody>
            {data.products.map((p) => (
              <tr key={p.product_id}>
                <td>{p.product_name}</td>
                <td>{p.quantity}</td>
                <td>
                  {symbol}
                  {p.retail_value.toFixed(2)}
                </td>
                <td>{p.has_cost_data ? `${symbol}${p.cost_value.toFixed(2)}` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ExpiryAlertsTab() {
  const [days, setDays] = useState('30');
  const [batches, setBatches] = useState<ProductBatch[]>([]);

  const load = () =>
    api
      .getBatches({ nearExpiryDays: Number(days) || 30 })
      .then(setBatches)
      .catch(() => setBatches([]));

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days]);

  const isExpired = (dateStr: string) => new Date(dateStr).getTime() < Date.now();

  return (
    <div className="panel" style={{ padding: '1rem' }}>
      <div className="field" style={{ maxWidth: '12rem' }}>
        <label>Alert window (days)</label>
        <input type="number" min="1" value={days} onChange={(e) => setDays(e.target.value)} />
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Batch</th>
            <th>Expiry</th>
            <th>Qty</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id}>
              <td>{b.product_name}</td>
              <td>{b.batch_no}</td>
              <td>{b.expiry_date}</td>
              <td>{b.qty_on_hand}</td>
              <td className="pay-error">{isExpired(b.expiry_date) ? 'Expired' : 'Near expiry'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!batches.length && <div className="empty">Nothing expiring within this window</div>}
    </div>
  );
}

function ControlledRegisterTab({ range }: { range: { start: string; end: string } }) {
  const [rows, setRows] = useState<ControlledRegisterRow[]>([]);
  useEffect(() => {
    api.getControlledRegister(range).then(setRows).catch(() => setRows([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.start, range.end]);

  return (
    <div className="panel" style={{ padding: '1rem' }}>
      <table className="table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Product</th>
            <th>Qty</th>
            <th>Patient</th>
            <th>Dispensed by</th>
            <th>Approved by</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td>{new Date(r.created_at).toLocaleString()}</td>
              <td>{r.product_name}</td>
              <td>{r.qty}</td>
              <td>{r.patient_name}</td>
              <td>{r.dispensing_user_name}</td>
              <td>{r.approving_user_name}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">No controlled-substance dispensing in this range</div>}
    </div>
  );
}
