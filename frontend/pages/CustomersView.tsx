import { useEffect, useState } from 'react';
import { api, CorporateAccount, Customer, Transaction } from '../api/client';
import Modal from '../components/Modal';

type Props = {
  customers: Customer[];
  symbol: string;
  onChanged: () => Promise<void>;
};

const emptyForm = {
  id: '',
  name: '',
  phone: '',
  email: '',
  address: '',
  date_of_birth: '',
  allergies: '',
  insurance_ref: '',
  corporate_account_id: '',
};

export default function CustomersView({ customers, symbol, onChanged }: Props) {
  const [form, setForm] = useState(emptyForm);
  const [corporateAccounts, setCorporateAccounts] = useState<CorporateAccount[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [historyFor, setHistoryFor] = useState<Customer | null>(null);
  const [history, setHistory] = useState<Transaction[]>([]);
  const [showCorporate, setShowCorporate] = useState(false);

  const loadCorporateAccounts = () => api.getCorporateAccounts().then(setCorporateAccounts).catch(() => undefined);

  useEffect(() => {
    loadCorporateAccounts();
  }, []);

  const corporateName = (id?: number | null) =>
    id ? corporateAccounts.find((c) => c.id === id)?.name || `#${id}` : '';

  const save = async () => {
    setError(null);
    if (!form.name.trim()) return;
    const body = {
      name: form.name,
      phone: form.phone,
      email: form.email,
      address: form.address,
      date_of_birth: form.date_of_birth,
      allergies: form.allergies,
      insurance_ref: form.insurance_ref,
      corporate_account_id: form.corporate_account_id ? Number(form.corporate_account_id) : null,
    };
    try {
      if (form.id) {
        await api.updateCustomer({ _id: form.id, id: Number(form.id), ...body });
      } else {
        await api.saveCustomer(body);
      }
      setForm(emptyForm);
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save customer');
    }
  };

  const edit = (c: Customer) =>
    setForm({
      id: String(c.id),
      name: c.name,
      phone: c.phone,
      email: c.email,
      address: c.address,
      date_of_birth: c.date_of_birth || '',
      allergies: c.allergies || '',
      insurance_ref: c.insurance_ref || '',
      corporate_account_id: c.corporate_account_id ? String(c.corporate_account_id) : '',
    });

  const remove = async (id: number) => {
    if (!confirm('Delete customer?')) return;
    await api.deleteCustomer(id);
    await onChanged();
  };

  const viewHistory = async (c: Customer) => {
    setHistoryFor(c);
    const rows = await api.getCustomerHistory(c.id).catch(() => []);
    setHistory(rows);
  };

  return (
    <div className="page-grid">
      <div className="panel" style={{ padding: '1rem' }}>
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <h3 style={{ marginTop: 0 }}>{form.id ? 'Edit patient' : 'New patient'}</h3>
          <button type="button" className="btn" onClick={() => setShowCorporate(true)}>
            Corporate accounts
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="field">
          <label>Name</label>
          <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </div>
        <div className="field">
          <label>Phone</label>
          <input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        </div>
        <div className="field">
          <label>Email</label>
          <input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        </div>
        <div className="field">
          <label>Address</label>
          <textarea rows={2} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
        </div>
        <div className="field">
          <label>Date of birth</label>
          <input
            type="date"
            value={form.date_of_birth}
            onChange={(e) => setForm({ ...form, date_of_birth: e.target.value })}
          />
        </div>
        <div className="field">
          <label>Allergies</label>
          <textarea rows={2} value={form.allergies} onChange={(e) => setForm({ ...form, allergies: e.target.value })} />
        </div>
        <div className="field">
          <label>Insurance reference</label>
          <input value={form.insurance_ref} onChange={(e) => setForm({ ...form, insurance_ref: e.target.value })} />
        </div>
        <div className="field">
          <label>Corporate account</label>
          <select
            value={form.corporate_account_id}
            onChange={(e) => setForm({ ...form, corporate_account_id: e.target.value })}
          >
            <option value="">— none —</option>
            {corporateAccounts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.discount_percent}% off)
              </option>
            ))}
          </select>
        </div>
        <div className="row" style={{ gap: '0.5rem' }}>
          <button type="button" className="btn btn-primary" onClick={save}>
            {form.id ? 'Update' : 'Add'} patient
          </button>
          {form.id && (
            <button type="button" className="btn btn-ghost" onClick={() => setForm(emptyForm)}>
              Cancel
            </button>
          )}
        </div>
      </div>

      <div className="panel" style={{ padding: '1rem' }}>
        <table className="table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Loyalty pts</th>
              <th>Corporate</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {customers.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td>{c.phone}</td>
                <td>{c.loyalty_points ?? 0}</td>
                <td>{corporateName(c.corporate_account_id)}</td>
                <td>
                  <button type="button" className="btn" onClick={() => viewHistory(c)}>
                    History
                  </button>{' '}
                  <button type="button" className="btn" onClick={() => edit(c)}>
                    Edit
                  </button>{' '}
                  <button type="button" className="btn btn-danger" onClick={() => remove(c.id)}>
                    Del
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Modal
        title={historyFor ? `Purchase history — ${historyFor.name}` : 'Purchase history'}
        open={!!historyFor}
        onClose={() => setHistoryFor(null)}
        wide
      >
        <table className="table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Total</th>
              <th>Points earned</th>
            </tr>
          </thead>
          <tbody>
            {history.map((t) => (
              <tr key={t.id}>
                <td>{new Date(t.date).toLocaleString()}</td>
                <td>
                  {symbol}
                  {t.total.toFixed(2)}
                </td>
                <td>{t.loyalty_points_earned ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!history.length && <div className="empty">No purchases yet</div>}
      </Modal>

      <Modal title="Corporate accounts" open={showCorporate} onClose={() => setShowCorporate(false)}>
        <CorporateAccountsPanel accounts={corporateAccounts} onChanged={loadCorporateAccounts} />
      </Modal>
    </div>
  );
}

function CorporateAccountsPanel({
  accounts,
  onChanged,
}: {
  accounts: CorporateAccount[];
  onChanged: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [discountPercent, setDiscountPercent] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);

  const save = async () => {
    if (!name.trim()) return;
    await api.saveCorporateAccount({
      id: editingId || undefined,
      name,
      discount_percent: Number(discountPercent) || 0,
    });
    setName('');
    setDiscountPercent('');
    setEditingId(null);
    await onChanged();
  };

  const remove = async (id: number) => {
    if (!confirm('Delete corporate account?')) return;
    await api.deleteCorporateAccount(id);
    await onChanged();
  };

  return (
    <div>
      <div className="row" style={{ gap: '0.5rem', marginBottom: '0.75rem' }}>
        <input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} style={{ flex: 2 }} />
        <input
          type="number"
          step="0.1"
          placeholder="Discount %"
          value={discountPercent}
          onChange={(e) => setDiscountPercent(e.target.value)}
          style={{ flex: 1 }}
        />
        <button type="button" className="btn btn-primary" onClick={save}>
          {editingId ? 'Update' : 'Add'}
        </button>
      </div>
      <table className="table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Discount %</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {accounts.map((a) => (
            <tr key={a.id}>
              <td>{a.name}</td>
              <td>{a.discount_percent}%</td>
              <td>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    setEditingId(a.id);
                    setName(a.name);
                    setDiscountPercent(String(a.discount_percent));
                  }}
                >
                  Edit
                </button>{' '}
                <button type="button" className="btn btn-danger" onClick={() => remove(a.id)}>
                  Del
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {!accounts.length && <div className="empty">No corporate accounts yet</div>}
    </div>
  );
}
