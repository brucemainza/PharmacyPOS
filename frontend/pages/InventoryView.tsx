import { useEffect, useState } from 'react';
import { Boxes, CheckCircle2, AlertTriangle, XCircle } from 'lucide-react';
import {
  api,
  Branch,
  Product,
  ProductBatch,
  StockMovement,
  StockTake,
  StockTransfer,
  Supplier,
} from '../api/client';
import StatCard from '../components/StatCard';

type Props = {
  products: Product[];
  onChanged: () => Promise<void>;
};

type Tab = 'grn' | 'batches' | 'reorder' | 'transfers' | 'stocktake';

const TABS: { id: Tab; label: string }[] = [
  { id: 'grn', label: 'Goods receiving' },
  { id: 'batches', label: 'Batches & expiry' },
  { id: 'reorder', label: 'Reorder suggestions' },
  { id: 'transfers', label: 'Branch transfers' },
  { id: 'stocktake', label: 'Stock take' },
];

export default function InventoryView({ products, onChanged }: Props) {
  const [tab, setTab] = useState<Tab>('grn');

  const trackedProducts = products.filter((p) => p.stock);
  const inStock = trackedProducts.filter((p) => p.quantity > 0).length;
  const outOfStock = trackedProducts.filter((p) => p.quantity === 0).length;
  const lowStock = trackedProducts.filter(
    (p) => (p.reorder_level || 0) > 0 && p.quantity > 0 && p.quantity <= (p.reorder_level || 0)
  ).length;

  return (
    <div>
      <div className="stat-grid">
        <StatCard icon={<Boxes size={18} />} value={products.length} label="Total products" />
        <StatCard icon={<CheckCircle2 size={18} />} value={inStock} label="In stock" />
        <StatCard icon={<AlertTriangle size={18} />} value={lowStock} label="Low stock" tone="warn" />
        <StatCard icon={<XCircle size={18} />} value={outOfStock} label="Out of stock" tone="danger" />
      </div>
      <div className="row" style={{ gap: '0.5rem', marginBottom: '1rem' }}>
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

      {tab === 'grn' && <GrnTab products={products} onChanged={onChanged} />}
      {tab === 'batches' && <BatchesTab products={products} />}
      {tab === 'reorder' && <ReorderTab onGoToGrn={() => setTab('grn')} />}
      {tab === 'transfers' && <TransfersTab products={products} onChanged={onChanged} />}
      {tab === 'stocktake' && <StockTakeTab />}
    </div>
  );
}

type GrnLine = { product_id: string; batch_no: string; expiry_date: string; qty: string; unit_cost: string };

function GrnTab({ products, onChanged }: { products: Product[]; onChanged: () => Promise<void> }) {
  const [suppliers, setSuppliers] = useState<Supplier[]>([]);
  const [supplierId, setSupplierId] = useState('');
  const [newSupplierName, setNewSupplierName] = useState('');
  const [lines, setLines] = useState<GrnLine[]>([{ product_id: '', batch_no: '', expiry_date: '', qty: '', unit_cost: '' }]);
  const [movements, setMovements] = useState<StockMovement[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadSuppliers = () => api.getSuppliers().then(setSuppliers).catch(() => undefined);
  const loadMovements = () =>
    api
      .getStockMovements()
      .then((rows) => setMovements(rows.filter((r) => r.movement_type === 'goods_receipt').slice(0, 20)))
      .catch(() => undefined);

  useEffect(() => {
    loadSuppliers();
    loadMovements();
  }, []);

  const productName = (id: number) => products.find((p) => p.id === id)?.name || `#${id}`;

  const addLine = () => setLines([...lines, { product_id: '', batch_no: '', expiry_date: '', qty: '', unit_cost: '' }]);
  const removeLine = (idx: number) => setLines(lines.filter((_, i) => i !== idx));
  const updateLine = (idx: number, patch: Partial<GrnLine>) =>
    setLines(lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const addSupplier = async () => {
    if (!newSupplierName.trim()) return;
    const created = await api.saveSupplier({ name: newSupplierName.trim() });
    setNewSupplierName('');
    await loadSuppliers();
    setSupplierId(String(created.id));
  };

  const submit = async () => {
    setError(null);
    const items = lines
      .filter((l) => l.product_id && l.qty)
      .map((l) => ({
        product_id: Number(l.product_id),
        batch_no: l.batch_no || undefined,
        expiry_date: l.expiry_date || undefined,
        qty: Number(l.qty),
        unit_cost: l.unit_cost ? Number(l.unit_cost) : undefined,
      }));
    if (!items.length) {
      setError('Add at least one line item');
      return;
    }
    setBusy(true);
    try {
      await api.receiveGrn({ supplier_id: supplierId ? Number(supplierId) : null, items });
      setLines([{ product_id: '', batch_no: '', expiry_date: '', qty: '', unit_cost: '' }]);
      await Promise.all([loadMovements(), onChanged()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record GRN');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page-grid">
      <div className="panel" style={{ padding: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Receive stock (GRN)</h3>
        {error && <div className="error">{error}</div>}
        <div className="field">
          <label>Supplier</label>
          <select value={supplierId} onChange={(e) => setSupplierId(e.target.value)}>
            <option value="">— none —</option>
            {suppliers.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ gap: '0.5rem', marginBottom: '0.75rem' }}>
          <input
            placeholder="New supplier name"
            value={newSupplierName}
            onChange={(e) => setNewSupplierName(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn" onClick={addSupplier}>
            + Add supplier
          </button>
        </div>

        <label>Line items</label>
        {lines.map((line, idx) => (
          <div key={idx} className="row" style={{ gap: '0.4rem', marginBottom: '0.4rem', flexWrap: 'wrap' }}>
            <select
              value={line.product_id}
              onChange={(e) => updateLine(idx, { product_id: e.target.value })}
              style={{ flex: 2 }}
            >
              <option value="">Product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              placeholder="Batch no."
              value={line.batch_no}
              onChange={(e) => updateLine(idx, { batch_no: e.target.value })}
              style={{ flex: 1 }}
            />
            <input
              type="date"
              value={line.expiry_date}
              onChange={(e) => updateLine(idx, { expiry_date: e.target.value })}
              style={{ flex: 1 }}
            />
            <input
              type="number"
              min="1"
              placeholder="Qty"
              value={line.qty}
              onChange={(e) => updateLine(idx, { qty: e.target.value })}
              style={{ flex: '1 1 4rem', minWidth: '4rem' }}
            />
            <input
              type="number"
              step="0.01"
              placeholder="Cost"
              value={line.unit_cost}
              onChange={(e) => updateLine(idx, { unit_cost: e.target.value })}
              style={{ flex: '1 1 4rem', minWidth: '4rem' }}
            />
            <button type="button" className="btn btn-ghost" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn" onClick={addLine} style={{ marginBottom: '0.75rem' }}>
          + Add line
        </button>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy}>
          {busy ? 'Receiving…' : 'Receive stock'}
        </button>
      </div>

      <div className="panel" style={{ padding: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Recent goods receipts</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Qty</th>
              <th>Date</th>
            </tr>
          </thead>
          <tbody>
            {movements.map((m) => (
              <tr key={m.id}>
                <td>{productName(m.product_id)}</td>
                <td>+{m.qty_delta}</td>
                <td>{new Date(m.created_at).toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!movements.length && <div className="empty">No goods receipts yet</div>}
      </div>
    </div>
  );
}

function BatchesTab({ products }: { products: Product[] }) {
  const [productId, setProductId] = useState('');
  const [nearExpiryDays, setNearExpiryDays] = useState('');
  const [batches, setBatches] = useState<ProductBatch[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    setError(null);
    try {
      const rows = await api.getBatches({
        productId: productId ? Number(productId) : undefined,
        nearExpiryDays: nearExpiryDays ? Number(nearExpiryDays) : undefined,
      });
      setBatches(rows);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load batches');
    }
  };

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId, nearExpiryDays]);

  const expiryClass = (dateStr: string) => {
    if (!dateStr) return '';
    const days = (new Date(dateStr).getTime() - Date.now()) / 86400000;
    if (days < 0) return 'pay-error';
    if (days <= 30) return 'pay-error';
    return '';
  };

  return (
    <div className="panel" style={{ padding: '1rem' }}>
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ gap: '1rem', marginBottom: '0.75rem' }}>
        <div className="field" style={{ flex: 1 }}>
          <label>Product</label>
          <select value={productId} onChange={(e) => setProductId(e.target.value)}>
            <option value="">All products</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field" style={{ flex: 1 }}>
          <label>Expiring within (days)</label>
          <input
            type="number"
            min="1"
            placeholder="e.g. 30"
            value={nearExpiryDays}
            onChange={(e) => setNearExpiryDays(e.target.value)}
          />
        </div>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Product</th>
            <th>Batch no.</th>
            <th>Expiry</th>
            <th>Qty on hand</th>
            <th>Received</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((b) => (
            <tr key={b.id}>
              <td>{b.product_name}</td>
              <td>{b.batch_no}</td>
              <td className={expiryClass(b.expiry_date)}>{b.expiry_date || '—'}</td>
              <td>{b.qty_on_hand}</td>
              <td>{new Date(b.received_at).toLocaleDateString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!batches.length && <div className="empty">No batches found</div>}
    </div>
  );
}

function ReorderTab({ onGoToGrn }: { onGoToGrn: () => void }) {
  const [rows, setRows] = useState<(Product & { suggested_qty: number })[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api
      .getReorderSuggestions()
      .then(setRows)
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'));

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="panel" style={{ padding: '1rem' }}>
      {error && <div className="error">{error}</div>}
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: '0.5rem' }}>
        <h3 style={{ margin: 0 }}>Products at or below reorder level</h3>
        <button type="button" className="btn" onClick={onGoToGrn}>
          Go to goods receiving
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Product</th>
            <th>On hand</th>
            <th>Reorder level</th>
            <th>Suggested order qty</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.quantity}</td>
              <td>{p.reorder_level}</td>
              <td>{p.suggested_qty}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <div className="empty">Nothing needs reordering right now</div>}
    </div>
  );
}

function TransfersTab({ products, onChanged }: { products: Product[]; onChanged: () => Promise<void> }) {
  const [branches, setBranches] = useState<Branch[]>([]);
  const [newBranchName, setNewBranchName] = useState('');
  const [toBranchId, setToBranchId] = useState('');
  const [lines, setLines] = useState([{ product_id: '', qty: '' }]);
  const [transfers, setTransfers] = useState<StockTransfer[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadBranches = () => api.getBranches().then(setBranches).catch(() => undefined);
  const loadTransfers = () => api.getTransfers().then(setTransfers).catch(() => undefined);

  useEffect(() => {
    loadBranches();
    loadTransfers();
  }, []);

  const branchName = (id: number) => branches.find((b) => b.id === id)?.name || `#${id}`;
  const productName = (id: number) => products.find((p) => p.id === id)?.name || `#${id}`;
  const otherBranches = branches.filter((b) => !b.is_local);

  const addBranch = async () => {
    if (!newBranchName.trim()) return;
    await api.createBranch(newBranchName.trim());
    setNewBranchName('');
    await loadBranches();
  };

  const addLine = () => setLines([...lines, { product_id: '', qty: '' }]);
  const removeLine = (idx: number) => setLines(lines.filter((_, i) => i !== idx));
  const updateLine = (idx: number, patch: Partial<{ product_id: string; qty: string }>) =>
    setLines(lines.map((l, i) => (i === idx ? { ...l, ...patch } : l)));

  const createTransfer = async () => {
    setError(null);
    if (!toBranchId) {
      setError('Select a destination branch');
      return;
    }
    const items = lines
      .filter((l) => l.product_id && l.qty)
      .map((l) => ({ product_id: Number(l.product_id), qty: Number(l.qty) }));
    if (!items.length) {
      setError('Add at least one line item');
      return;
    }
    setBusy(true);
    try {
      await api.createTransfer({ to_branch_id: Number(toBranchId), items });
      setLines([{ product_id: '', qty: '' }]);
      await Promise.all([loadTransfers(), onChanged()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create transfer');
    } finally {
      setBusy(false);
    }
  };

  const receive = async (id: number) => {
    await api.receiveTransfer(id);
    await Promise.all([loadTransfers(), onChanged()]);
  };

  return (
    <div className="page-grid">
      <div className="panel" style={{ padding: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>New branch transfer</h3>
        <p style={{ fontSize: '0.85rem', opacity: 0.75 }}>
          Creating a transfer removes stock from this branch immediately. The receiving branch
          confirms with &ldquo;Receive&rdquo; once the goods arrive.
        </p>
        {error && <div className="error">{error}</div>}
        <div className="row" style={{ gap: '0.5rem', marginBottom: '0.75rem' }}>
          <input
            placeholder="New branch name"
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            style={{ flex: 1 }}
          />
          <button type="button" className="btn" onClick={addBranch}>
            + Add branch
          </button>
        </div>
        <div className="field">
          <label>Destination branch</label>
          <select value={toBranchId} onChange={(e) => setToBranchId(e.target.value)}>
            <option value="">Select…</option>
            {otherBranches.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </select>
        </div>
        {lines.map((line, idx) => (
          <div key={idx} className="row" style={{ gap: '0.5rem', marginBottom: '0.4rem' }}>
            <select
              value={line.product_id}
              onChange={(e) => updateLine(idx, { product_id: e.target.value })}
              style={{ flex: 2 }}
            >
              <option value="">Product…</option>
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <input
              type="number"
              min="1"
              placeholder="Qty"
              value={line.qty}
              onChange={(e) => updateLine(idx, { qty: e.target.value })}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-ghost" onClick={() => removeLine(idx)} disabled={lines.length === 1}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn" onClick={addLine} style={{ marginBottom: '0.75rem' }}>
          + Add line
        </button>
        <button type="button" className="btn btn-primary" onClick={createTransfer} disabled={busy}>
          {busy ? 'Sending…' : 'Send transfer'}
        </button>
      </div>

      <div className="panel" style={{ padding: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Transfers</h3>
        <table className="table">
          <thead>
            <tr>
              <th>From</th>
              <th>To</th>
              <th>Status</th>
              <th>Date</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {transfers.map((t) => (
              <tr key={t.id}>
                <td>{branchName(t.from_branch_id)}</td>
                <td>{branchName(t.to_branch_id)}</td>
                <td>{t.status}</td>
                <td>{new Date(t.created_at).toLocaleDateString()}</td>
                <td>
                  {t.status === 'pending' && (
                    <button type="button" className="btn" onClick={() => receive(t.id)}>
                      Receive
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!transfers.length && <div className="empty">No transfers yet</div>}
      </div>
    </div>
  );
}

function StockTakeTab() {
  const [history, setHistory] = useState<StockTake[]>([]);
  const [active, setActive] = useState<StockTake | null>(null);
  const [businessDate, setBusinessDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [error, setError] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<number, string>>({});

  const loadHistory = () => api.getStockTakes().then(setHistory).catch(() => undefined);

  useEffect(() => {
    loadHistory();
  }, []);

  const start = async () => {
    setError(null);
    try {
      const take = await api.startStockTake(businessDate);
      setActive(take);
      setCounts({});
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start stock take');
    }
  };

  const view = async (id: number) => {
    const take = await api.getStockTake(id);
    setActive(take);
    setCounts({});
  };

  const saveCount = async (itemId: number) => {
    if (!active) return;
    const value = counts[itemId];
    if (value === undefined || value === '') return;
    const updated = await api.countStockTakeItem(active.id, itemId, Number(value));
    setActive(updated);
  };

  const complete = async () => {
    if (!active) return;
    setError(null);
    try {
      const result = await api.completeStockTake(active.id);
      setActive(result);
      await loadHistory();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to complete stock take');
    }
  };

  return (
    <div className="page-grid">
      <div className="panel" style={{ padding: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Start a stock take</h3>
        {error && <div className="error">{error}</div>}
        <div className="field">
          <label>Business date</label>
          <input type="date" value={businessDate} onChange={(e) => setBusinessDate(e.target.value)} />
        </div>
        <button type="button" className="btn btn-primary" onClick={start}>
          Start new stock take
        </button>

        <h3>History</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td>{h.business_date}</td>
                <td>{h.status}</td>
                <td>
                  <button type="button" className="btn" onClick={() => view(h.id)}>
                    View
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!history.length && <div className="empty">No stock takes yet</div>}
      </div>

      <div className="panel" style={{ padding: '1rem' }}>
        {!active && <div className="empty">Start or select a stock take to count items</div>}
        {active && (
          <>
            <h3 style={{ marginTop: 0 }}>
              Stock take #{active.id} — {active.business_date} ({active.status})
            </h3>
            <table className="table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th>Expected</th>
                  <th>Counted</th>
                  <th>Variance</th>
                  {active.status === 'open' && <th />}
                </tr>
              </thead>
              <tbody>
                {active.items.map((item) => (
                  <tr key={item.id}>
                    <td>{item.product_name}</td>
                    <td>{item.expected_qty}</td>
                    <td>
                      {active.status === 'open' ? (
                        <input
                          type="number"
                          min="0"
                          style={{ width: '5rem' }}
                          value={counts[item.id] ?? (item.counted_qty ?? '')}
                          onChange={(e) => setCounts({ ...counts, [item.id]: e.target.value })}
                        />
                      ) : (
                        item.counted_qty ?? '—'
                      )}
                    </td>
                    <td className={item.variance ? (item.variance < 0 ? 'pay-error' : '') : ''}>
                      {item.variance ?? '—'}
                    </td>
                    {active.status === 'open' && (
                      <td>
                        <button type="button" className="btn" onClick={() => saveCount(item.id)}>
                          Save
                        </button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            {active.status === 'open' && (
              <button type="button" className="btn btn-primary" onClick={complete} style={{ marginTop: '0.75rem' }}>
                Complete stock take
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
