import { useEffect, useMemo, useState } from 'react';
import {
  api,
  Category,
  Customer,
  Product,
  Settings,
  Transaction,
} from '../api/client';
import { useAuth } from '../context/AuthContext';
import AppShell, { NavView } from '../layout/AppShell';
import TillView from './TillView';
import CatalogView from './CatalogView';
import SettingsView from './SettingsView';
import TransactionsModal from '../components/TransactionsModal';
import PrescriptionsView from './PrescriptionsView';
import InventoryView from './InventoryView';
import CustomersView from './CustomersView';
import AnalyticsView from './AnalyticsView';

export default function PosPage() {
  const { hasPerm } = useAuth();
  const [view, setView] = useState<NavView>('till');
  const [products, setProducts] = useState<Product[]>([]);
  const [categories, setCategories] = useState<Category[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [holdCount, setHoldCount] = useState(0);
  const [todayTotal, setTodayTotal] = useState(0);

  const symbol = settings?.symbol || 'ZMW ';

  const loadAll = async () => {
    const [p, c, cust, s] = await Promise.all([
      api.getProducts(),
      api.getCategories(),
      api.getCustomers(),
      api.getSettings(),
    ]);
    setProducts(p);
    setCategories(c);
    setCustomers(cust);
    setSettings(s.settings);

    if (hasPerm('perm_transactions')) {
      try {
        const start = new Date();
        start.setHours(0, 0, 0, 0);
        const sales = await api.getByDate({
          start: start.toISOString(),
          end: new Date().toISOString(),
          user: 0,
          till: 0,
          status: 1,
        });
        setTodayTotal(sales.reduce((sum: number, t: Transaction) => sum + Number(t.total || 0), 0));
      } catch {
        /* cashiers without perm already filtered */
      }
    }

    try {
      const holds = await api.getOnHold();
      setHoldCount(holds.length);
    } catch {
      /* ignore */
    }
  };

  useEffect(() => {
    loadAll().catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!settings?.store && hasPerm('perm_settings')) {
      setView('settings');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings]);

  const title = useMemo(() => {
    switch (view) {
      case 'till':
        return settings?.store ? `${settings.store} · Till` : 'Till';
      case 'catalog':
        return 'Catalog';
      case 'sales':
        return 'Sales history';
      case 'cashup':
        return 'Cash-up';
      case 'prescriptions':
        return 'Prescriptions';
      case 'inventory':
        return 'Inventory';
      case 'analytics':
        return 'Analytics';
      case 'customers':
        return 'Customers';
      case 'team':
        return 'Team';
      case 'settings':
        return 'Settings';
      default:
        return 'MediPOS';
    }
  }, [view, settings]);

  const subtitle = useMemo(() => {
    switch (view) {
      case 'till':
        return 'Scan or search products, then take payment';
      case 'catalog':
        return 'Manage products, categories, and medicine details';
      case 'sales':
        return 'Browse and manage past transactions';
      case 'cashup':
        return 'Reconcile the drawer and close out the day';
      case 'prescriptions':
        return 'Capture and dispense patient prescriptions';
      case 'inventory':
        return 'Goods receiving, batches, transfers, and stock takes';
      case 'analytics':
        return 'Sales, margin, and stock performance reports';
      case 'customers':
        return 'Patient profiles, purchase history, and loyalty';
      case 'team':
        return 'Manage staff accounts and permissions';
      case 'settings':
        return 'Store details, register mode, and preferences';
      default:
        return undefined;
    }
  }, [view]);

  return (
    <AppShell
      view={view}
      onNavigate={setView}
      title={title}
      subtitle={subtitle}
      logo={settings?.img || ''}
      todaySales={
        hasPerm('perm_transactions')
          ? `${symbol}${todayTotal.toFixed(2)}`
          : undefined
      }
      navBadges={holdCount > 0 ? { till: holdCount } : undefined}
      stats={
        view === 'till' && holdCount > 0 ? (
          <span className="stat-pill">{holdCount} held</span>
        ) : null
      }
    >
      {error && (
        <div className="error">
          {error}{' '}
          <button type="button" className="btn btn-ghost" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      {view === 'till' && (
        <TillView
          products={products}
          categories={categories}
          customers={customers}
          settings={settings}
          holdCount={holdCount}
          onHoldCount={setHoldCount}
          onRefresh={loadAll}
        />
      )}

      {view === 'catalog' && (
        <CatalogView
          products={products}
          categories={categories}
          symbol={symbol}
          canProducts={hasPerm('perm_products')}
          canCategories={hasPerm('perm_categories')}
          onChanged={loadAll}
        />
      )}

      {view === 'sales' && (
        <TransactionsModal
          embedded
          open
          symbol={symbol}
          onClose={() => setView('till')}
        />
      )}

      {view === 'cashup' && (
        <CashUpView till={settings?.till || 1} symbol={symbol} />
      )}

      {view === 'prescriptions' && (
        <PrescriptionsView customers={customers} products={products} />
      )}

      {view === 'inventory' && (
        <InventoryView products={products} onChanged={loadAll} />
      )}

      {view === 'analytics' && <AnalyticsView symbol={symbol} />}

      {view === 'customers' && (
        <CustomersView customers={customers} symbol={symbol} onChanged={loadAll} />
      )}

      {view === 'team' && <TeamView />}

      {view === 'settings' && (
        <SettingsView settings={settings} onSaved={loadAll} />
      )}
    </AppShell>
  );
}

function TeamView() {
  return <UsersPanel />;
}

function CashUpView({ till, symbol }: { till: number; symbol: string }) {
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof api.getCashUpPreview>> | null>(null);
  const [counted, setCounted] = useState('');
  const [notes, setNotes] = useState('');
  const [history, setHistory] = useState<Awaited<ReturnType<typeof api.getCashUpHistory>>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    setError(null);
    try {
      const [p, h] = await Promise.all([
        api.getCashUpPreview(till, date),
        api.getCashUpHistory(till),
      ]);
      setPreview(p);
      setHistory(h);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load');
    }
  };

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reload when till/date change
  }, [till, date]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.recordCashUp({ till, date, counted_cash: parseFloat(counted) || 0, notes });
      setCounted('');
      setNotes('');
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to record cash-up');
    } finally {
      setBusy(false);
    }
  };

  const variance = preview ? (parseFloat(counted) || 0) - preview.expected_cash : 0;

  return (
    <div className="page-grid">
      <div className="panel" style={{ padding: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>End-of-day cash-up — Till {till}</h3>
        {error && <div className="error">{error}</div>}
        <div className="field">
          <label>Business date</label>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        {preview && (
          <>
            <div className="row">
              <span>Sales ({preview.transaction_count} txns)</span>
              <span>{symbol}{preview.sales_total.toFixed(2)}</span>
            </div>
            <div className="row">
              <span>Cash</span>
              <span>{symbol}{preview.cash_total.toFixed(2)}</span>
            </div>
            <div className="row">
              <span>Card</span>
              <span>{symbol}{preview.card_total.toFixed(2)}</span>
            </div>
            <div className="row">
              <span>Mobile Money</span>
              <span>{symbol}{preview.mobile_money_total.toFixed(2)}</span>
            </div>
            <div className="row">
              <span>Refunds</span>
              <span>-{symbol}{preview.refunds_total.toFixed(2)}</span>
            </div>
            <div className="row">
              <strong>Expected cash in drawer</strong>
              <strong>{symbol}{preview.expected_cash.toFixed(2)}</strong>
            </div>
          </>
        )}
        <div className="field">
          <label>Counted cash</label>
          <input
            type="number"
            step="0.01"
            value={counted}
            onChange={(e) => setCounted(e.target.value)}
          />
        </div>
        {counted && preview && (
          <p className={variance === 0 ? 'pay-gateway-status' : 'pay-error'}>
            Variance: {symbol}{variance.toFixed(2)} {variance === 0 ? '(balanced)' : variance > 0 ? '(over)' : '(short)'}
          </p>
        )}
        <div className="field">
          <label>Notes</label>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>
        <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !counted}>
          {busy ? 'Recording…' : 'Record cash-up'}
        </button>
      </div>

      <div className="panel" style={{ padding: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>Recent cash-ups</h3>
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Expected</th>
              <th>Counted</th>
              <th>Variance</th>
              <th>Notes</th>
            </tr>
          </thead>
          <tbody>
            {history.map((h) => (
              <tr key={h.id}>
                <td>{h.business_date}</td>
                <td>{symbol}{h.expected_cash.toFixed(2)}</td>
                <td>{symbol}{h.counted_cash.toFixed(2)}</td>
                <td>{symbol}{h.variance.toFixed(2)}</td>
                <td>{h.notes}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!history.length && <div className="empty">No cash-ups recorded yet</div>}
      </div>
    </div>
  );
}

function UsersPanel() {
  const [list, setList] = useState<Awaited<ReturnType<typeof api.getUsers>>>([]);
  const emptyForm = {
    id: '',
    username: '',
    password: '',
    fullname: '',
    role: 'cashier' as 'cashier' | 'pharmacist' | 'manager' | 'admin' | 'tech',
    perm_products: true,
    perm_categories: true,
    perm_transactions: true,
    perm_users: false,
    perm_settings: false,
    perm_discount_approve: false,
    perm_refund_void: false,
    perm_controlled_approve: false,
    perm_price_override: false,
  };
  const [form, setForm] = useState(emptyForm);
  const [error, setError] = useState<string | null>(null);

  const load = async () => setList(await api.getUsers());

  useEffect(() => {
    load().catch((err) => setError(err.message));
  }, []);

  const save = async () => {
    setError(null);
    if (!form.username.trim() || !form.fullname.trim()) {
      setError('Username and full name are required');
      return;
    }
    if (!form.id && !form.password) {
      setError('Password is required for new users');
      return;
    }
    try {
      await api.saveUser({ ...form });
      await load();
      setForm(emptyForm);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Save failed');
    }
  };

  return (
    <div className="page-grid">
      <div className="panel" style={{ padding: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>{form.id ? 'Edit user' : 'New user'}</h3>
        {error && <div className="error">{error}</div>}
        <div className="field">
          <label>Username</label>
          <input
            value={form.username}
            onChange={(e) => setForm({ ...form, username: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Full name</label>
          <input
            value={form.fullname}
            onChange={(e) => setForm({ ...form, fullname: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Password {form.id ? '(blank = keep)' : ''}</label>
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Role</label>
          <select
            value={form.role}
            onChange={(e) => setForm({ ...form, role: e.target.value as typeof form.role })}
          >
            <option value="cashier">Cashier (Till operator)</option>
            <option value="pharmacist">Pharmacist</option>
            <option value="manager">Manager</option>
            <option value="admin">Administrator</option>
            <option value="tech">Tech</option>
          </select>
          <p className="field-hint">
            {form.role === 'cashier' && 'Sees only the Till — no other views.'}
            {form.role === 'admin' && 'Sees every view except the Till.'}
            {form.role === 'tech' && 'Sees every view, including the Till, for support and fixes.'}
          </p>
        </div>
        {(
          [
            ['perm_products', 'Catalog products'],
            ['perm_categories', 'Categories'],
            ['perm_transactions', 'Sales history'],
            ['perm_users', 'Team'],
            ['perm_settings', 'Settings'],
            ['perm_discount_approve', 'Approve above-threshold discounts'],
            ['perm_refund_void', 'Void / refund sales'],
            ['perm_controlled_approve', 'Approve controlled-substance dispensing'],
            ['perm_price_override', 'Override prices'],
          ] as const
        ).map(([key, label]) => (
          <label
            key={key}
            style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.4rem', alignItems: 'center' }}
          >
            <input
              type="checkbox"
              checked={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.checked })}
            />
            {label}
          </label>
        ))}
        <button type="button" className="btn btn-primary" onClick={save} style={{ marginTop: '0.75rem' }}>
          {form.id ? 'Update' : 'Add'} user
        </button>
      </div>
      <div className="panel" style={{ padding: '1rem' }}>
        <table className="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Name</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td>
                <td>{u.fullname}</td>
                <td>
                  <button
                    type="button"
                    className="btn"
                    onClick={() =>
                      setForm({
                        id: String(u.id),
                        username: u.username,
                        password: '',
                        fullname: u.fullname,
                        role: u.role || 'cashier',
                        perm_products: !!u.perm_products,
                        perm_categories: !!u.perm_categories,
                        perm_transactions: !!u.perm_transactions,
                        perm_users: !!u.perm_users,
                        perm_settings: !!u.perm_settings,
                        perm_discount_approve: !!u.perm_discount_approve,
                        perm_refund_void: !!u.perm_refund_void,
                        perm_controlled_approve: !!u.perm_controlled_approve,
                        perm_price_override: !!u.perm_price_override,
                      })
                    }
                  >
                    Edit
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
