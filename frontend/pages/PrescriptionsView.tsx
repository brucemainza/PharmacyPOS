import { useEffect, useState } from 'react';
import { api, Customer, Prescription, Product } from '../api/client';
import { useAuth } from '../context/AuthContext';
import Modal from '../components/Modal';

type Props = {
  customers: Customer[];
  products: Product[];
};

type DraftItem = { product_id: string; prescribed_qty: string };

export default function PrescriptionsView({ customers, products }: Props) {
  const { user } = useAuth();
  const [list, setList] = useState<Prescription[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState('');

  const [patientId, setPatientId] = useState('');
  const [prescriberName, setPrescriberName] = useState('');
  const [prescriberRegNo, setPrescriberRegNo] = useState('');
  const [notes, setNotes] = useState('');
  const [draftItems, setDraftItems] = useState<DraftItem[]>([{ product_id: '', prescribed_qty: '' }]);
  const [creating, setCreating] = useState(false);

  const [active, setActive] = useState<Prescription | null>(null);

  const canSubstitute =
    user?.role === 'pharmacist' ||
    user?.role === 'manager' ||
    user?.role === 'admin' ||
    user?.role === 'tech';

  const load = async () => {
    setError(null);
    try {
      const rows = await api.getPrescriptions(statusFilter ? { status: statusFilter } : undefined);
      setList(rows);
      if (active) {
        const refreshed = rows.find((r) => r.id === active.id);
        setActive(refreshed || null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load prescriptions');
    }
  };

  useEffect(() => {
    load().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  const addLine = () => setDraftItems([...draftItems, { product_id: '', prescribed_qty: '' }]);
  const removeLine = (idx: number) => setDraftItems(draftItems.filter((_, i) => i !== idx));
  const updateLine = (idx: number, patch: Partial<DraftItem>) =>
    setDraftItems(draftItems.map((it, i) => (i === idx ? { ...it, ...patch } : it)));

  const resetForm = () => {
    setPatientId('');
    setPrescriberName('');
    setPrescriberRegNo('');
    setNotes('');
    setDraftItems([{ product_id: '', prescribed_qty: '' }]);
  };

  const createPrescription = async () => {
    setError(null);
    const items = draftItems
      .filter((it) => it.product_id && it.prescribed_qty)
      .map((it) => ({ product_id: Number(it.product_id), prescribed_qty: Number(it.prescribed_qty) }));

    if (!patientId) {
      setError('Select a patient');
      return;
    }
    if (!items.length) {
      setError('Add at least one line item');
      return;
    }

    setCreating(true);
    try {
      await api.createPrescription({
        patient_id: Number(patientId),
        prescriber_name: prescriberName,
        prescriber_reg_no: prescriberRegNo,
        notes,
        items,
      });
      resetForm();
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create prescription');
    } finally {
      setCreating(false);
    }
  };

  const patientName = (id: number) => customers.find((c) => c.id === id)?.name || `#${id}`;

  return (
    <div className="page-grid">
      <div className="panel" style={{ padding: '1rem' }}>
        <h3 style={{ marginTop: 0 }}>New prescription</h3>
        {error && <div className="error">{error}</div>}
        <div className="field">
          <label>Patient</label>
          <select value={patientId} onChange={(e) => setPatientId(e.target.value)}>
            <option value="">Select patient…</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label>Prescriber name</label>
          <input value={prescriberName} onChange={(e) => setPrescriberName(e.target.value)} />
        </div>
        <div className="field">
          <label>Prescriber reg. no.</label>
          <input value={prescriberRegNo} onChange={(e) => setPrescriberRegNo(e.target.value)} />
        </div>
        <div className="field">
          <label>Notes</label>
          <textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
        </div>

        <label>Items</label>
        {draftItems.map((line, idx) => (
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
              value={line.prescribed_qty}
              onChange={(e) => updateLine(idx, { prescribed_qty: e.target.value })}
              style={{ flex: 1 }}
            />
            <button type="button" className="btn btn-ghost" onClick={() => removeLine(idx)} disabled={draftItems.length === 1}>
              Remove
            </button>
          </div>
        ))}
        <button type="button" className="btn" onClick={addLine} style={{ marginBottom: '0.75rem' }}>
          + Add line
        </button>

        <button type="button" className="btn btn-primary" onClick={createPrescription} disabled={creating}>
          {creating ? 'Creating…' : 'Create prescription'}
        </button>
      </div>

      <div className="panel" style={{ padding: '1rem' }}>
        <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.5rem' }}>
          <h3 style={{ margin: 0 }}>Prescriptions</h3>
          <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="">All statuses</option>
            <option value="open">Open</option>
            <option value="partially_filled">Partially filled</option>
            <option value="completed">Completed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <table className="table">
          <thead>
            <tr>
              <th>Patient</th>
              <th>Prescriber</th>
              <th>Date</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {list.map((rx) => (
              <tr key={rx.id}>
                <td>{patientName(rx.patient_id)}</td>
                <td>{rx.prescriber_name}</td>
                <td>{new Date(rx.date).toLocaleDateString()}</td>
                <td>{rx.status.replace('_', ' ')}</td>
                <td>
                  <button type="button" className="btn" onClick={() => setActive(rx)}>
                    View / Dispense
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!list.length && <div className="empty">No prescriptions yet</div>}
      </div>

      {active && (
        <DispenseModal
          prescription={active}
          products={products}
          canSubstitute={canSubstitute}
          onClose={() => setActive(null)}
          onChanged={load}
        />
      )}
    </div>
  );
}

function DispenseModal({
  prescription,
  products,
  canSubstitute,
  onClose,
  onChanged,
}: {
  prescription: Prescription;
  products: Product[];
  canSubstitute: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
}) {
  const [qtyByItem, setQtyByItem] = useState<Record<number, string>>({});
  const [subByItem, setSubByItem] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busyItem, setBusyItem] = useState<number | null>(null);

  const [pendingItem, setPendingItem] = useState<Prescription['items'][number] | null>(null);
  const [approvalUser, setApprovalUser] = useState('');
  const [approvalPass, setApprovalPass] = useState('');
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);

  const qtyFor = (itemId: number, remaining: number) =>
    qtyByItem[itemId] !== undefined ? qtyByItem[itemId] : String(remaining);

  const dispenseItem = async (
    item: Prescription['items'][number],
    approvingUserId?: number
  ) => {
    setError(null);
    const qty = Number(qtyFor(item.id, item.remaining_qty));
    if (!qty || qty <= 0) {
      setError('Enter a quantity to dispense');
      return;
    }
    const subId = subByItem[item.id] ? Number(subByItem[item.id]) : null;

    if (item.product_controlled && !approvingUserId) {
      setPendingItem(item);
      setApprovalUser('');
      setApprovalPass('');
      setApprovalError(null);
      return;
    }

    setBusyItem(item.id);
    try {
      await api.dispensePrescriptionItem(prescription.id, item.id, {
        dispensed_qty: qty,
        substituted_product_id: subId,
        approving_user_id: approvingUserId || null,
      });
      setQtyByItem({ ...qtyByItem, [item.id]: '' });
      setSubByItem({ ...subByItem, [item.id]: '' });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Dispense failed');
    } finally {
      setBusyItem(null);
    }
  };

  const submitApproval = async () => {
    if (!pendingItem) return;
    setApprovalBusy(true);
    setApprovalError(null);
    try {
      const approver = await api.authorizeUser(approvalUser, approvalPass, 'perm_controlled_approve');
      const item = pendingItem;
      setPendingItem(null);
      await dispenseItem(item, approver.id);
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : 'Authorization failed');
    } finally {
      setApprovalBusy(false);
    }
  };

  return (
    <>
      <Modal title={`Prescription #${prescription.id}`} open onClose={onClose} wide>
        {error && <div className="error">{error}</div>}
        <p>
          <strong>Prescriber:</strong> {prescription.prescriber_name || '—'} {prescription.prescriber_reg_no}
          <br />
          <strong>Status:</strong> {prescription.status.replace('_', ' ')}
          {prescription.notes && (
            <>
              <br />
              <strong>Notes:</strong> {prescription.notes}
            </>
          )}
        </p>
        <table className="table">
          <thead>
            <tr>
              <th>Product</th>
              <th>Prescribed</th>
              <th>Dispensed</th>
              <th>Remaining</th>
              <th>Dispense qty</th>
              {canSubstitute && <th>Substitute</th>}
              <th />
            </tr>
          </thead>
          <tbody>
            {prescription.items.map((item) => (
              <tr key={item.id}>
                <td>
                  {item.product_name}
                  {item.product_controlled && <span className="stat-pill" style={{ marginLeft: '0.4rem' }}>controlled</span>}
                </td>
                <td>{item.prescribed_qty}</td>
                <td>{item.dispensed_qty}</td>
                <td>{item.remaining_qty}</td>
                <td>
                  <input
                    type="number"
                    min="1"
                    max={item.remaining_qty}
                    style={{ width: '5rem' }}
                    value={qtyFor(item.id, item.remaining_qty)}
                    onChange={(e) => setQtyByItem({ ...qtyByItem, [item.id]: e.target.value })}
                    disabled={item.remaining_qty === 0}
                  />
                </td>
                {canSubstitute && (
                  <td>
                    <select
                      value={subByItem[item.id] || ''}
                      onChange={(e) => setSubByItem({ ...subByItem, [item.id]: e.target.value })}
                      disabled={item.remaining_qty === 0}
                    >
                      <option value="">—</option>
                      {products
                        .filter((p) => p.id !== item.product_id)
                        .map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                    </select>
                  </td>
                )}
                <td>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => dispenseItem(item)}
                    disabled={item.remaining_qty === 0 || busyItem === item.id}
                  >
                    {busyItem === item.id ? 'Dispensing…' : 'Dispense'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </Modal>

      <Modal
        title="Controlled-substance approval required"
        open={!!pendingItem}
        onClose={() => setPendingItem(null)}
        compact
        footer={
          <>
            <button type="button" className="btn" onClick={() => setPendingItem(null)} disabled={approvalBusy}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={submitApproval}
              disabled={approvalBusy || !approvalUser || !approvalPass}
            >
              {approvalBusy ? 'Checking…' : 'Approve'}
            </button>
          </>
        }
      >
        <p>
          {pendingItem?.product_name} is a controlled substance. A second authorized user (pharmacist or
          manager) must enter their own credentials to approve this dispense.
        </p>
        {approvalError && <div className="error">{approvalError}</div>}
        <div className="field">
          <label>Approver username</label>
          <input value={approvalUser} onChange={(e) => setApprovalUser(e.target.value)} autoFocus disabled={approvalBusy} />
        </div>
        <div className="field">
          <label>Approver password</label>
          <input
            type="password"
            value={approvalPass}
            onChange={(e) => setApprovalPass(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && approvalUser && approvalPass) submitApproval();
            }}
            disabled={approvalBusy}
          />
        </div>
      </Modal>
    </>
  );
}
