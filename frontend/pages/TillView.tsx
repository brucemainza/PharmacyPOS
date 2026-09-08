import { useEffect, useMemo, useRef, useState } from 'react';
import { toDataURL as qrToDataURL } from 'qrcode';
import {
  api,
  CartItem,
  Category,
  Customer,
  InitiatePaymentBody,
  PaymentMethods,
  Product,
  Settings,
  Transaction,
} from '../api/client';
import { useAuth } from '../context/AuthContext';
import Modal from '../components/Modal';
import PaymentPad from '../components/PaymentPad';
import CustomerSelect from '../components/CustomerSelect';
import SuccessCheck from '../components/SuccessCheck';

type Props = {
  products: Product[];
  categories: Category[];
  customers: Customer[];
  settings: Settings | null;
  onRefresh: () => Promise<void>;
  holdCount: number;
  onHoldCount: (n: number) => void;
};

export default function TillView({
  products,
  categories,
  customers,
  settings,
  onRefresh,
  holdCount,
  onHoldCount,
}: Props) {
  const { user, apiInfo } = useAuth();
  const scanRef = useRef<HTMLInputElement>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [query, setQuery] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('all');
  const [customerId, setCustomerId] = useState('0');
  const [discount, setDiscount] = useState(0);
  const [activeHoldId, setActiveHoldId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHolds, setShowHolds] = useState(false);
  const [holds, setHolds] = useState<Transaction[]>([]);
  const [showPay, setShowPay] = useState(false);
  const [paid, setPaid] = useState('');
  const [paymentType, setPaymentType] = useState(1);
  const [receipt, setReceipt] = useState('');
  const [receiptQr, setReceiptQr] = useState('');
  const [showSuccess, setShowSuccess] = useState(false);
  const [successSummary, setSuccessSummary] = useState<{
    amount: number;
    method: string;
    customer: string;
    ref: string;
  } | null>(null);

  // Lenco Pay (card / mobile money) — cash above is untouched and always available.
  const [paymentMethods, setPaymentMethods] = useState<PaymentMethods>({
    cash: true,
    card: false,
    mobile_money: false,
  });
  // The reachability check behind getPaymentMethods() is a real network round-trip (checking
  // Lenco's sandbox is actually up), so it takes ~1s. While it's in flight, card/mobile-money
  // must not be shown as flatly "(offline)" — that reads as broken, not "still checking" — so
  // they're rendered as a distinct "Checking…" state instead until the first result lands.
  const [checkingPaymentMethods, setCheckingPaymentMethods] = useState(false);
  const [payStage, setPayStage] = useState<'idle' | 'processing' | 'failed'>('idle');
  const [payError, setPayError] = useState<string | null>(null);
  const [momoPhone, setMomoPhone] = useState('');
  const [momoOperator, setMomoOperator] = useState<'airtel' | 'mtn' | 'tnm' | 'zamtel'>('airtel');
  const [momoCountry, setMomoCountry] = useState<'zm' | 'mw'>('zm');
  const [cardForm, setCardForm] = useState({
    number: '',
    expiryMonth: '',
    expiryYear: '',
    cvv: '',
    firstName: '',
    lastName: '',
    email: '',
    street: '',
    city: '',
    postalCode: '',
    country: '',
  });
  const pollAbortRef = useRef(false);

  // Discount approval — ref for synchronous reads inside buildTransaction (state updates
  // aren't visible until the next render, and approval needs to unblock the *same* click).
  const [discountApprovedBy, setDiscountApprovedBy] = useState<number | null>(null);
  const discountApprovedByRef = useRef<number | null>(null);
  const [showApproval, setShowApproval] = useState(false);
  const [approvalUser, setApprovalUser] = useState('');
  const [approvalPass, setApprovalPass] = useState('');
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [approvalBusy, setApprovalBusy] = useState(false);

  // Split payment: multiple tenders (e.g. part cash, part card) against one sale. Each leg gets
  // its own `payments` row via the same /api/payments/initiate path as a single-method payment;
  // the sale is only created once every leg has actually settled.
  const [splitMode, setSplitMode] = useState(false);
  const [splitLegs, setSplitLegs] = useState<{ method: 'cash' | 'card' | 'mobile_money'; amount: string }[]>([]);
  const [newLegMethod, setNewLegMethod] = useState<'cash' | 'card' | 'mobile_money'>('cash');
  const [newLegAmount, setNewLegAmount] = useState('');

  const symbol = settings?.symbol || 'ZMW ';
  const taxRate = settings?.charge_tax ? Number(settings.percentage) || 0 : 0;
  const discountThreshold = settings?.discount_approval_threshold ?? 10;

  const refreshHolds = async () => {
    const list = await api.getOnHold();
    setHolds(list);
    onHoldCount(list.length);
  };

  useEffect(() => {
    refreshHolds().catch(() => undefined);
    scanRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F2') {
        e.preventDefault();
        if (cart.length) openPay();
      }
      if (e.key === 'F4') {
        e.preventDefault();
        openHolds();
      }
      if (e.key === 'Escape' && showPay) {
        closePay();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [cart, showPay]);

  const filteredProducts = useMemo(() => {
    const q = query.trim().toLowerCase();
    // While typing a barcode, keep the grid browsable by category only if empty query feels better
    return products.filter((p) => {
      const catOk = categoryFilter === 'all' || p.category === categoryFilter;
      if (!q) return catOk;
      return (
        catOk &&
        (p.name.toLowerCase().includes(q) || String(p.id).includes(q))
      );
    });
  }, [products, query, categoryFilter]);

  const subtotal = cart.reduce((sum, i) => sum + i.price * i.quantity, 0);
  const afterDiscount = Math.max(0, subtotal - (Number(discount) || 0));
  const tax = afterDiscount * (taxRate / 100);
  const total = afterDiscount + tax;
  const itemCount = cart.reduce((sum, i) => sum + i.quantity, 0);
  const discountPct = subtotal > 0 ? ((Number(discount) || 0) / subtotal) * 100 : 0;
  const discountNeedsApproval = discountPct > discountThreshold;
  const splitTotal = splitLegs.reduce((sum, l) => sum + (parseFloat(l.amount) || 0), 0);
  const splitRemaining = Math.max(0, total - splitTotal);

  useEffect(() => {
    discountApprovedByRef.current = null;
    setDiscountApprovedBy(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only re-arm when the discount amount itself changes
  }, [discount]);

  const stockLabel = (p: Product) => {
    if (!p.stock) return { text: 'No stock limit', className: 'stock-badge' };
    if (p.quantity <= 0) return { text: 'Out of stock', className: 'stock-badge out' };
    if (p.quantity <= 5) return { text: `${p.quantity} left`, className: 'stock-badge low' };
    return { text: `${p.quantity} in stock`, className: 'stock-badge' };
  };

  const addToCart = (product: Product) => {
    if (product.stock && product.quantity <= 0) {
      setError(`${product.name} is out of stock`);
      return;
    }
    setError(null);
    setCart((prev) => {
      const existing = prev.find((i) => i.id === product.id);
      if (existing) {
        if (product.stock && existing.quantity >= product.quantity) {
          setError(`Only ${product.quantity} available for ${product.name}`);
          return prev;
        }
        return prev.map((i) =>
          i.id === product.id ? { ...i, quantity: i.quantity + 1 } : i
        );
      }
      return [
        ...prev,
        {
          id: product.id,
          name: product.name,
          price: Number(product.price),
          quantity: 1,
          stock: product.quantity,
        },
      ];
    });
  };

  const setQty = (id: number, quantity: number) => {
    setCart((prev) =>
      prev
        .map((i) => (i.id === id ? { ...i, quantity } : i))
        .filter((i) => i.quantity > 0)
    );
  };

  const clearCart = () => {
    setCart([]);
    setDiscount(0);
    setActiveHoldId(null);
    setCustomerId('0');
    setError(null);
    scanRef.current?.focus();
  };

  const onScan = async () => {
    const code = query.trim();
    if (!code) return;
    try {
      const product = await api.findBySku(code);
      if (product) {
        addToCart(product);
        setQuery('');
        scanRef.current?.focus();
        return;
      }
      // fallback local match by id or exact name
      const local =
        products.find((p) => String(p.id) === code) ||
        products.find((p) => p.name.toLowerCase() === code.toLowerCase());
      if (local) {
        addToCart(local);
        setQuery('');
        scanRef.current?.focus();
      } else {
        setError(`No product for “${code}”`);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    }
  };

  const buildTransaction = (status: number, paidAmount: number, changeAmt: number) => {
    const customer = customers.find((c) => String(c.id) === customerId);
    return {
      ref_number: status === 0 ? `H-${Date.now().toString().slice(-6)}` : '',
      customer: customerId,
      customer_name: customer?.name || 'Walk-in',
      status,
      user_id: user?._id || 0,
      user: user?.fullname || '',
      till: apiInfo?.till || settings?.till || 1,
      discount: Number(discount) || 0,
      subtotal,
      tax,
      total,
      paid: paidAmount,
      change: changeAmt,
      payment_type: paymentType,
      discount_approved_by: discountApprovedByRef.current,
      items: cart,
      date: new Date().toISOString(),
    };
  };

  const holdSale = async () => {
    if (!cart.length) return;
    try {
      const body = buildTransaction(0, 0, 0);
      if (activeHoldId) {
        await api.updateTransaction({ ...body, _id: activeHoldId });
      } else {
        await api.createTransaction(body);
      }
      clearCart();
      await refreshHolds();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not hold sale');
    }
  };

  const openPay = () => {
    // Cash starts empty so the numpad builds the tendered amount (not appends to total).
    setPaid('');
    setPaymentType(1);
    setPayStage('idle');
    setPayError(null);
    setSplitMode(false);
    setSplitLegs([]);
    setNewLegAmount('');
    pollAbortRef.current = false;
    setShowPay(true);
    // Never assume card/mobile-money are available — ask on every open so a checkout that
    // started online but went offline mid-flow doesn't keep offering them.
    setCheckingPaymentMethods(true);
    api
      .getPaymentMethods()
      .then(setPaymentMethods)
      .catch(() => setPaymentMethods({ cash: true, card: false, mobile_money: false }))
      .finally(() => setCheckingPaymentMethods(false));
  };

  const closePay = () => {
    pollAbortRef.current = true;
    setShowPay(false);
    setPayStage('idle');
    setPayError(null);
  };

  const sanitizeTendered = (raw: string) => {
    let next = raw.replace(/[^\d.]/g, '');
    const firstDot = next.indexOf('.');
    if (firstDot !== -1) {
      next =
        next.slice(0, firstDot + 1) + next.slice(firstDot + 1).replace(/\./g, '');
      const [whole, dec = ''] = next.split('.');
      next = `${whole}.${dec.slice(0, 2)}`;
    }
    return next;
  };

  // Shared by every payment method — reached only once a payment is actually confirmed (cash is
  // confirmed by construction; card/mobile-money only after the gateway says "successful").
  // Never called speculatively, so a sale never appears paid before it truly is.
  const finalizeSale = async (
    paidAmount: number,
    changeAmt: number,
    methodLabel: string,
    paymentReferences?: string[],
    paymentTypeOverride?: number
  ) => {
    const body = {
      ...buildTransaction(1, paidAmount, changeAmt),
      ...(paymentTypeOverride ? { payment_type: paymentTypeOverride } : {}),
    };
    try {
      let transactionId = activeHoldId;
      if (activeHoldId) {
        await api.updateTransaction({ ...body, _id: activeHoldId, ref_number: '' });
      } else {
        const created = await api.createTransaction(body);
        transactionId = (created as { id?: number } | undefined)?.id ?? null;
      }
      if (paymentReferences?.length && transactionId) {
        // Best-effort: the sale already succeeded, so a failure here shouldn't block checkout —
        // it only means a payment record's transaction_id backfill is missed this one time.
        await Promise.all(
          paymentReferences.map((ref) => api.linkPayment(ref, transactionId!).catch(() => {}))
        );
      }
      const invoiceRef = `INV-${transactionId ?? Date.now()}`;
      const customerName = customers.find((c) => String(c.id) === customerId)?.name || 'Walk-in Customer';
      const lines = [
        settings?.store || 'MediPOS',
        settings?.address_one || '',
        settings?.contact || '',
        '--------------------------------',
        ...cart.map(
          (i) =>
            `${i.quantity} x ${i.name}`.padEnd(22) +
            `${symbol}${(i.price * i.quantity).toFixed(2)}`
        ),
        '--------------------------------',
        `Subtotal ${symbol}${subtotal.toFixed(2)}`,
        taxRate ? `Tax ${taxRate}% ${symbol}${tax.toFixed(2)}` : '',
        discount ? `Discount -${symbol}${Number(discount).toFixed(2)}` : '',
        `TOTAL ${symbol}${total.toFixed(2)}`,
        `${methodLabel} ${symbol}${paidAmount.toFixed(2)}`,
        `Change ${symbol}${changeAmt.toFixed(2)}`,
        `Till ${apiInfo?.till || 1} · ${user?.fullname || ''}`,
        `Invoice ${invoiceRef}`,
        settings?.footer || 'Thank you',
        new Date().toLocaleString(),
      ]
        .filter(Boolean)
        .join('\n');
      setReceipt(lines);
      // Just for show — encodes the invoice reference/total, not a real lookup URL.
      qrToDataURL(`${invoiceRef}|${symbol}${total.toFixed(2)}|${new Date().toISOString()}`, {
        width: 192,
        margin: 1,
        color: { dark: '#0f172a', light: '#ffffff' },
      })
        .then(setReceiptQr)
        .catch(() => setReceiptQr(''));
      setSuccessSummary({ amount: paidAmount, method: methodLabel, customer: customerName, ref: invoiceRef });
      clearCart();
      setShowPay(false);
      setPayStage('idle');
      await onRefresh();
      await refreshHolds();
      setShowSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sale failed');
      throw err;
    }
  };

  const printReceipt = () => {
    setTimeout(() => window.print(), 50);
  };

  const startNewSale = () => {
    setShowSuccess(false);
    setSuccessSummary(null);
  };

  const completeSale = async () => {
    const paidNum = parseFloat(paid) || 0;
    if (paidNum + 0.0001 < total) {
      setError('Amount tendered is less than total');
      return;
    }
    const changeAmt = Math.max(0, paidNum - total);
    await finalizeSale(paidNum, changeAmt, 'Cash').catch(() => {});
  };

  // Polls our own /api/payments/:reference/status (which itself polls Lenco) until the payment
  // reaches a terminal state, or the deadline passes. Never marks the sale paid on our own —
  // only a "successful" status from the gateway does that, via finalizeSale.
  const pollPayment = async (reference: string, methodLabel: string) => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (pollAbortRef.current) return;
      try {
        const status = await api.getPaymentStatus(reference);
        if (status.status === 'successful') {
          await finalizeSale(total, 0, methodLabel, [reference]);
          return;
        }
        if (status.status === 'failed') {
          setPayStage('failed');
          setPayError(status.reason_for_failure || 'Payment failed.');
          return;
        }
      } catch {
        // transient poll failure (e.g. brief disconnect) — keep trying until the deadline
      }
    }
    if (!pollAbortRef.current) {
      setPayStage('failed');
      setPayError(
        'Payment timed out waiting for confirmation. Check the reference before retrying to avoid double-charging.'
      );
    }
  };

  const payWithGateway = async (method: 'card' | 'mobile_money') => {
    setError(null);
    setPayError(null);

    if (method === 'mobile_money' && (!momoPhone || !momoOperator)) {
      setPayError('Enter the customer’s mobile money number and operator.');
      return;
    }
    if (
      method === 'card' &&
      (!cardForm.number || !cardForm.expiryMonth || !cardForm.expiryYear || !cardForm.cvv)
    ) {
      setPayError('Enter the full card number, expiry, and CVV.');
      return;
    }

    setPayStage('processing');
    pollAbortRef.current = false;

    const body: InitiatePaymentBody = {
      transactionId: activeHoldId,
      method,
      amount: total,
      currency: 'ZMW',
    };
    if (method === 'mobile_money') {
      body.mobileMoney = { phone: momoPhone, operator: momoOperator, country: momoCountry };
    } else {
      body.customer = {
        email: cardForm.email,
        firstName: cardForm.firstName || 'Customer',
        lastName: cardForm.lastName || 'Walk-in',
      };
      body.billing = {
        streetAddress: cardForm.street,
        city: cardForm.city,
        postalCode: cardForm.postalCode,
        country: cardForm.country,
      };
      body.card = {
        number: cardForm.number,
        expiryMonth: cardForm.expiryMonth,
        expiryYear: cardForm.expiryYear,
        cvv: cardForm.cvv,
      };
    }

    const methodLabel = method === 'card' ? 'Card' : 'Mobile Money';

    try {
      const initiated = await api.initiatePayment(body);

      if (initiated.status === 'successful') {
        await finalizeSale(total, 0, methodLabel, [initiated.reference]);
        return;
      }
      if (initiated.status === 'failed') {
        setPayStage('failed');
        setPayError('Payment was declined. Try again or use cash.');
        return;
      }
      if (initiated.status === 'action_required') {
        setPayStage('failed');
        setPayError(
          'This card requires additional verification (3D Secure), which this till cannot complete. Use a different card or cash.'
        );
        return;
      }

      await pollPayment(initiated.reference, methodLabel);
    } catch (err) {
      if (!pollAbortRef.current) {
        setPayStage('failed');
        setPayError(err instanceof Error ? err.message : 'Payment failed to start.');
      }
    }
  };

  const addSplitLeg = () => {
    const amt = parseFloat(newLegAmount) || 0;
    if (amt <= 0) return;
    setSplitLegs((legs) => [...legs, { method: newLegMethod, amount: newLegAmount }]);
    setNewLegAmount('');
  };

  const removeSplitLeg = (index: number) => {
    setSplitLegs((legs) => legs.filter((_, i) => i !== index));
  };

  const legLabel = (method: 'cash' | 'card' | 'mobile_money') =>
    method === 'cash' ? 'Cash' : method === 'card' ? 'Card' : 'Mobile Money';

  // Polls a single leg's status and resolves to its terminal status ('successful'/'failed') or
  // 'timeout'/'aborted' — used by paySplit, distinct from pollPayment (single-method flow)
  // because it must return control to the split loop rather than finalizing the sale itself.
  const pollLegStatus = async (reference: string): Promise<string> => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2500));
      if (pollAbortRef.current) return 'aborted';
      const status = await api.getPaymentStatus(reference).catch(() => null);
      if (status?.status === 'successful' || status?.status === 'failed') return status.status;
    }
    return 'timeout';
  };

  const paySplit = async () => {
    if (splitTotal + 0.0001 < total) {
      setPayError('Split amounts do not cover the total due.');
      return;
    }
    setError(null);
    setPayError(null);
    setPayStage('processing');
    pollAbortRef.current = false;

    const settled: { method: string; reference: string; amount: number }[] = [];
    try {
      for (const leg of splitLegs) {
        const amt = parseFloat(leg.amount) || 0;
        if (amt <= 0) continue;

        if (leg.method === 'cash') {
          const initiated = await api.initiatePayment({ method: 'cash', amount: amt, currency: 'ZMW' });
          settled.push({ method: 'cash', reference: initiated.reference, amount: amt });
          continue;
        }

        const body: InitiatePaymentBody = { method: leg.method, amount: amt, currency: 'ZMW' };
        if (leg.method === 'mobile_money') {
          if (!momoPhone || !momoOperator) {
            throw new Error('Enter the mobile money number and network before charging.');
          }
          body.mobileMoney = { phone: momoPhone, operator: momoOperator, country: momoCountry };
        } else {
          if (!cardForm.number || !cardForm.expiryMonth || !cardForm.expiryYear || !cardForm.cvv) {
            throw new Error('Enter the full card details before charging.');
          }
          body.customer = {
            email: cardForm.email,
            firstName: cardForm.firstName || 'Customer',
            lastName: cardForm.lastName || 'Walk-in',
          };
          body.billing = {
            streetAddress: cardForm.street,
            city: cardForm.city,
            postalCode: cardForm.postalCode,
            country: cardForm.country,
          };
          body.card = {
            number: cardForm.number,
            expiryMonth: cardForm.expiryMonth,
            expiryYear: cardForm.expiryYear,
            cvv: cardForm.cvv,
          };
        }

        const initiated = await api.initiatePayment(body);
        if (initiated.status === 'successful') {
          settled.push({ method: leg.method, reference: initiated.reference, amount: amt });
          continue;
        }
        if (initiated.status === 'failed' || initiated.status === 'action_required') {
          throw new Error(`${legLabel(leg.method)} leg of ${symbol}${amt.toFixed(2)} was declined.`);
        }

        const finalStatus = await pollLegStatus(initiated.reference);
        if (finalStatus !== 'successful') {
          throw new Error(`${legLabel(leg.method)} leg of ${symbol}${amt.toFixed(2)} did not complete (${finalStatus}).`);
        }
        settled.push({ method: leg.method, reference: initiated.reference, amount: amt });
      }

      const paidTotal = settled.reduce((sum, l) => sum + l.amount, 0);
      const changeAmt = Math.max(0, paidTotal - total);
      const methodLabel = settled
        .map((l) => `${legLabel(l.method as 'cash' | 'card' | 'mobile_money')} ${symbol}${l.amount.toFixed(2)}`)
        .join(' + ');
      await finalizeSale(paidTotal, changeAmt, methodLabel, settled.map((l) => l.reference), 5);
    } catch (err) {
      if (pollAbortRef.current) return;
      setPayStage('failed');
      const already = settled.reduce((sum, l) => sum + l.amount, 0);
      const alreadyNote =
        already > 0
          ? ` ${symbol}${already.toFixed(2)} was already collected on this attempt — see a manager before retrying rather than charging again.`
          : '';
      setPayError((err instanceof Error ? err.message : 'Split payment failed') + alreadyNote);
    }
  };

  const proceedToCharge = () => {
    if (splitMode) {
      paySplit();
      return;
    }
    if (paymentType === 1) {
      completeSale();
    } else if (paymentType === 3) {
      payWithGateway('card');
    } else if (paymentType === 4) {
      payWithGateway('mobile_money');
    }
  };

  const handlePayClick = () => {
    if (discountNeedsApproval && !discountApprovedByRef.current) {
      setApprovalError(null);
      setApprovalUser('');
      setApprovalPass('');
      setShowApproval(true);
      return;
    }
    proceedToCharge();
  };

  const submitApproval = async () => {
    setApprovalBusy(true);
    setApprovalError(null);
    try {
      const approver = await api.authorizeUser(approvalUser, approvalPass, 'perm_discount_approve');
      discountApprovedByRef.current = approver.id;
      setDiscountApprovedBy(approver.id);
      setShowApproval(false);
      proceedToCharge();
    } catch (err) {
      setApprovalError(err instanceof Error ? err.message : 'Authorization failed');
    } finally {
      setApprovalBusy(false);
    }
  };

  const openHolds = async () => {
    await refreshHolds();
    setShowHolds(true);
  };

  const restoreHold = (order: Transaction) => {
    setCart(order.items || []);
    setCustomerId(String(order.customer || '0'));
    setDiscount(order.discount || 0);
    setActiveHoldId(order.id);
    setShowHolds(false);
    scanRef.current?.focus();
  };

  const discardHold = async (id: number) => {
    if (!confirm('Delete this held sale?')) return;
    await api.deleteTransaction(id);
    await refreshHolds();
  };

  return (
    <>
      {error && (
        <div className="error">
          {error}{' '}
          <button type="button" className="btn btn-ghost" onClick={() => setError(null)}>
            dismiss
          </button>
        </div>
      )}

      <div className="till">
        <section className="panel till-left">
          <div className="scan-bar">
            <input
              ref={scanRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') onScan();
              }}
              placeholder="Scan barcode or search — Enter to add"
              autoFocus
            />
            <button type="button" className="btn btn-primary" onClick={onScan}>
              Add
            </button>
          </div>
          <div className="chips">
            <button
              type="button"
              className={`chip ${categoryFilter === 'all' ? 'active' : ''}`}
              onClick={() => setCategoryFilter('all')}
            >
              All
            </button>
            {categories.map((c) => (
              <button
                key={c.id}
                type="button"
                className={`chip ${categoryFilter === c.name ? 'active' : ''}`}
                onClick={() => setCategoryFilter(c.name)}
              >
                {c.name}
              </button>
            ))}
          </div>
          <div className="product-grid">
            {filteredProducts.map((p) => {
              const stock = stockLabel(p);
              const soldOut = !!p.stock && p.quantity <= 0;
              return (
                <button
                  key={p.id}
                  type="button"
                  className="product-tile"
                  onClick={() => addToCart(p)}
                  disabled={soldOut}
                >
                  {soldOut && (
                    <div className="sold-out-ribbon">
                      <span>Sold out</span>
                    </div>
                  )}
                  <div className="product-tile-body">
                    <strong>{p.name}</strong>
                    {p.generic_group && <span className="product-generic">{p.generic_group}</span>}
                    <span className="price">
                      {symbol}
                      {Number(p.price).toFixed(2)}
                    </span>
                    {!soldOut && <span className={stock.className}>{stock.text}</span>}
                  </div>
                </button>
              );
            })}
            {!filteredProducts.length && (
              <div className="empty">No products here. Add items in Catalog.</div>
            )}
          </div>
        </section>

        <section className="panel till-right">
          <div className="cart-head">
            <CustomerSelect
              customers={customers}
              value={customerId}
              onChange={setCustomerId}
              onCustomersChanged={onRefresh}
            />
            <button type="button" className="btn" onClick={openHolds}>
              Held {holdCount ? `(${holdCount})` : ''}
              <span className="kbd">F4</span>
            </button>
          </div>

          <div className="cart-list">
            {cart.map((item) => (
              <div className="cart-row" key={item.id}>
                <div>
                  <strong>{item.name}</strong>
                  <div className="muted">
                    {symbol}
                    {item.price.toFixed(2)} each
                  </div>
                </div>
                <div className="qty">
                  <button type="button" onClick={() => setQty(item.id, item.quantity - 1)}>
                    −
                  </button>
                  <span>{item.quantity}</span>
                  <button type="button" onClick={() => setQty(item.id, item.quantity + 1)}>
                    +
                  </button>
                </div>
                <strong className="currency">
                  {symbol}
                  {(item.price * item.quantity).toFixed(2)}
                </strong>
              </div>
            ))}
            {!cart.length && (
              <div className="empty">Cart empty — scan or tap a product</div>
            )}
          </div>

          <div className="totals">
            <div className="field" style={{ marginBottom: 0 }}>
              <label>Discount ({symbol})</label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={discount}
                onChange={(e) => setDiscount(Number(e.target.value))}
              />
            </div>
            {discountNeedsApproval && (
              <p className="pay-offline-notice">
                {discountApprovedBy
                  ? `Discount approved (manager sign-off on file).`
                  : `Discount is ${discountPct.toFixed(1)}% — above the ${discountThreshold}% threshold. Manager approval needed at checkout.`}
              </p>
            )}
            <div className="row">
              <span>
                {itemCount} item{itemCount === 1 ? '' : 's'}
              </span>
              <span>
                {symbol}
                {subtotal.toFixed(2)}
              </span>
            </div>
            {!!taxRate && (
              <div className="row">
                <span>Tax {taxRate}%</span>
                <span>
                  {symbol}
                  {tax.toFixed(2)}
                </span>
              </div>
            )}
            <div className="row grand">
              <span>Total</span>
              <span>
                {symbol}
                {total.toFixed(2)}
              </span>
            </div>
          </div>

          <div className="cart-actions">
            <button type="button" className="btn" onClick={clearCart} disabled={!cart.length}>
              Clear
            </button>
            <button type="button" className="btn" onClick={holdSale} disabled={!cart.length}>
              Hold
            </button>
            <button
              type="button"
              className="btn btn-primary btn-lg pay"
              onClick={openPay}
              disabled={!cart.length}
            >
              Charge {symbol}
              {total.toFixed(2)}
              <span className="kbd">F2</span>
            </button>
          </div>
        </section>
      </div>

      <div id="receipt-print" style={{ display: receipt ? 'block' : 'none' }}>
        <pre className="receipt">{receipt}</pre>
        {receiptQr && <img className="receipt-qr" src={receiptQr} alt="Receipt QR code" />}
      </div>

      <Modal title="Payment successful" open={showSuccess} onClose={startNewSale} compact>
        {successSummary && (
          <div className="success-modal-body">
            <SuccessCheck />
            <h2 className="success-heading">Payment successful</h2>
            <p className="success-sub">Invoice {successSummary.ref} has been created</p>
            <div className="success-summary">
              <div className="row">
                <span>Amount paid</span>
                <strong className="currency">
                  {symbol}
                  {successSummary.amount.toFixed(2)}
                </strong>
              </div>
              <div className="row">
                <span>Payment method</span>
                <strong>{successSummary.method}</strong>
              </div>
              <div className="row">
                <span>Customer</span>
                <strong>{successSummary.customer}</strong>
              </div>
            </div>
            <div className="success-actions">
              <button type="button" className="btn" onClick={printReceipt}>
                Print receipt
              </button>
              <button type="button" className="btn btn-primary" onClick={startNewSale}>
                New sale
              </button>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        title="Payment"
        open={showPay}
        onClose={closePay}
        compact
        footer={
          <>
            <button type="button" className="btn" onClick={closePay} disabled={payStage === 'processing'}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handlePayClick}
              disabled={
                payStage === 'processing' ||
                (splitMode
                  ? splitTotal + 0.0001 < total
                  : (paymentType === 3 && !paymentMethods.card) ||
                    (paymentType === 4 && !paymentMethods.mobile_money))
              }
            >
              {payStage === 'processing' ? 'Processing…' : 'Pay'}
            </button>
          </>
        }
      >
        <div className="field">
          <label style={{ display: 'flex', alignItems: 'center', gap: '0.4rem' }}>
            <input
              type="checkbox"
              checked={splitMode}
              onChange={(e) => {
                setSplitMode(e.target.checked);
                setPayError(null);
                setPayStage('idle');
              }}
              disabled={payStage === 'processing'}
            />
            Split payment (multiple tenders)
          </label>
        </div>

        {!splitMode && (
          <div className="field">
            <label>Method</label>
            <select
              value={paymentType}
              disabled={payStage === 'processing'}
              onChange={(e) => {
                const type = Number(e.target.value);
                setPaymentType(type);
                setPayError(null);
                setPayStage('idle');
                setPaid(type === 3 || type === 4 ? total.toFixed(2) : '');
              }}
            >
              <option value={1}>Cash</option>
              <option value={3} disabled={checkingPaymentMethods || !paymentMethods.card}>
                Card{checkingPaymentMethods ? ' (checking…)' : paymentMethods.card ? '' : ' (offline)'}
              </option>
              <option value={4} disabled={checkingPaymentMethods || !paymentMethods.mobile_money}>
                Mobile Money
                {checkingPaymentMethods ? ' (checking…)' : paymentMethods.mobile_money ? '' : ' (offline)'}
              </option>
            </select>
            {checkingPaymentMethods && (
              <p className="pay-gateway-status">Checking card/mobile-money availability…</p>
            )}
          </div>
        )}

        {!splitMode &&
          (paymentType === 3 || paymentType === 4) &&
          !paymentMethods.card &&
          !paymentMethods.mobile_money && (
            <p className="pay-offline-notice">
              Card and Mobile Money are unavailable right now (no connection to the payment
              provider). Use Cash, or try again once you're back online.
            </p>
          )}

        <div className="pay-due">
          Due {symbol}
          {total.toFixed(2)}
        </div>

        {!splitMode ? (
          <>
            <div className="field">
              <label>Tendered</label>
              <input
                value={paid}
                onChange={(e) => setPaid(sanitizeTendered(e.target.value))}
                placeholder={paymentType === 1 ? 'Enter amount received' : total.toFixed(2)}
                inputMode="decimal"
                autoFocus
                readOnly={paymentType === 3 || paymentType === 4}
              />
            </div>
            {paymentType === 1 && (
              <PaymentPad value={paid} onChange={setPaid} due={total} symbol={symbol} />
            )}
          </>
        ) : (
          <div className="pay-gateway-form">
            <div className="field">
              <label>Add tender</label>
              <select
                value={newLegMethod}
                onChange={(e) => setNewLegMethod(e.target.value as typeof newLegMethod)}
                disabled={payStage === 'processing'}
              >
                <option value="cash">Cash</option>
                <option value="card" disabled={checkingPaymentMethods || !paymentMethods.card}>
                  Card{checkingPaymentMethods ? ' (checking…)' : paymentMethods.card ? '' : ' (offline)'}
                </option>
                <option value="mobile_money" disabled={checkingPaymentMethods || !paymentMethods.mobile_money}>
                  Mobile Money
                  {checkingPaymentMethods ? ' (checking…)' : paymentMethods.mobile_money ? '' : ' (offline)'}
                </option>
              </select>
              <input
                type="number"
                min={0}
                step="0.01"
                value={newLegAmount}
                onChange={(e) => setNewLegAmount(e.target.value)}
                placeholder={splitRemaining > 0 ? splitRemaining.toFixed(2) : '0.00'}
                disabled={payStage === 'processing'}
              />
              <button
                type="button"
                className="btn"
                onClick={addSplitLeg}
                disabled={!newLegAmount || payStage === 'processing'}
              >
                Add tender
              </button>
            </div>
            {splitLegs.map((leg, i) => (
              <div className="row" key={i}>
                <span>
                  {legLabel(leg.method)} — {symbol}
                  {(parseFloat(leg.amount) || 0).toFixed(2)}
                </span>
                <button
                  type="button"
                  className="btn btn-ghost"
                  onClick={() => removeSplitLeg(i)}
                  disabled={payStage === 'processing'}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="row">
              <span>Remaining</span>
              <strong>
                {symbol}
                {splitRemaining.toFixed(2)}
              </strong>
            </div>
            {payStage === 'processing' && (
              <p className="pay-gateway-status">Charging each tender in order…</p>
            )}
          </div>
        )}

        {((!splitMode && paymentType === 4) ||
          (splitMode && splitLegs.some((l) => l.method === 'mobile_money'))) && (
          <div className="pay-gateway-form">
            <div className="field">
              <label>Mobile number</label>
              <input
                value={momoPhone}
                onChange={(e) => setMomoPhone(e.target.value.replace(/[^\d]/g, ''))}
                placeholder="0971111111"
                inputMode="numeric"
                disabled={payStage === 'processing'}
              />
            </div>
            <div className="field">
              <label>Network</label>
              <select
                value={momoOperator}
                onChange={(e) => setMomoOperator(e.target.value as typeof momoOperator)}
                disabled={payStage === 'processing'}
              >
                <option value="airtel">Airtel</option>
                <option value="mtn">MTN</option>
                <option value="tnm">TNM</option>
                <option value="zamtel">Zamtel</option>
              </select>
            </div>
            <div className="field">
              <label>Country</label>
              <select
                value={momoCountry}
                onChange={(e) => setMomoCountry(e.target.value as typeof momoCountry)}
                disabled={payStage === 'processing'}
              >
                <option value="zm">Zambia</option>
                <option value="mw">Malawi</option>
              </select>
            </div>
            {payStage === 'processing' && (
              <p className="pay-gateway-status">
                Waiting for the customer to approve on their phone…
              </p>
            )}
          </div>
        )}

        {((!splitMode && paymentType === 3) ||
          (splitMode && splitLegs.some((l) => l.method === 'card'))) && (
          <div className="pay-gateway-form">
            <div className="field">
              <label>Card number</label>
              <input
                value={cardForm.number}
                onChange={(e) =>
                  setCardForm((f) => ({ ...f, number: e.target.value.replace(/[^\d]/g, '') }))
                }
                placeholder="4111 1111 1111 1111"
                inputMode="numeric"
                disabled={payStage === 'processing'}
              />
            </div>
            <div className="field">
              <label>Expiry (MM / YYYY)</label>
              <input
                value={cardForm.expiryMonth}
                onChange={(e) => setCardForm((f) => ({ ...f, expiryMonth: e.target.value }))}
                placeholder="MM"
                inputMode="numeric"
                disabled={payStage === 'processing'}
              />
              <input
                value={cardForm.expiryYear}
                onChange={(e) => setCardForm((f) => ({ ...f, expiryYear: e.target.value }))}
                placeholder="YYYY"
                inputMode="numeric"
                disabled={payStage === 'processing'}
              />
            </div>
            <div className="field">
              <label>CVV</label>
              <input
                value={cardForm.cvv}
                onChange={(e) =>
                  setCardForm((f) => ({ ...f, cvv: e.target.value.replace(/[^\d]/g, '') }))
                }
                placeholder="123"
                inputMode="numeric"
                disabled={payStage === 'processing'}
              />
            </div>
            <div className="field">
              <label>Billing address</label>
              <input
                value={cardForm.street}
                onChange={(e) => setCardForm((f) => ({ ...f, street: e.target.value }))}
                placeholder="Street address"
                disabled={payStage === 'processing'}
              />
              <input
                value={cardForm.city}
                onChange={(e) => setCardForm((f) => ({ ...f, city: e.target.value }))}
                placeholder="City"
                disabled={payStage === 'processing'}
              />
              <input
                value={cardForm.postalCode}
                onChange={(e) => setCardForm((f) => ({ ...f, postalCode: e.target.value }))}
                placeholder="Postal code"
                disabled={payStage === 'processing'}
              />
              <input
                value={cardForm.country}
                onChange={(e) =>
                  setCardForm((f) => ({ ...f, country: e.target.value.toUpperCase().slice(0, 2) }))
                }
                placeholder="Country (e.g. US)"
                disabled={payStage === 'processing'}
              />
            </div>
            {payStage === 'processing' && <p className="pay-gateway-status">Processing card payment…</p>}
          </div>
        )}

        {payError && <p className="pay-error">{payError}</p>}

        {!splitMode && (
          <p className="pay-change">
            {(parseFloat(paid) || 0) + 0.0001 < total ? 'Still due' : 'Change'}{' '}
            <strong>
              {symbol}
              {Math.abs((parseFloat(paid) || 0) - total).toFixed(2)}
            </strong>
          </p>
        )}
      </Modal>

      <Modal
        title="Manager approval required"
        open={showApproval}
        onClose={() => setShowApproval(false)}
        compact
        footer={
          <>
            <button type="button" className="btn" onClick={() => setShowApproval(false)} disabled={approvalBusy}>
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
          This discount ({discountPct.toFixed(1)}%) is above the {discountThreshold}% threshold.
          A manager must enter their own credentials to authorize it.
        </p>
        <div className="field">
          <label>Manager username</label>
          <input
            value={approvalUser}
            onChange={(e) => setApprovalUser(e.target.value)}
            autoFocus
            disabled={approvalBusy}
          />
        </div>
        <div className="field">
          <label>Manager password</label>
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
        {approvalError && <p className="pay-error">{approvalError}</p>}
      </Modal>

      <Modal title="Held sales" open={showHolds} onClose={() => setShowHolds(false)} wide>
        <table className="table">
          <thead>
            <tr>
              <th>Ref</th>
              <th>Customer</th>
              <th>Items</th>
              <th>Total</th>
              <th>When</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {holds.map((h) => (
              <tr key={h.id}>
                <td>{h.ref_number || h.id}</td>
                <td>{h.customer_name}</td>
                <td>{(h.items || []).reduce((n, i) => n + i.quantity, 0)}</td>
                <td>
                  {symbol}
                  {Number(h.total).toFixed(2)}
                </td>
                <td>{new Date(h.date).toLocaleString()}</td>
                <td>
                  <button type="button" className="btn btn-primary" onClick={() => restoreHold(h)}>
                    Resume
                  </button>{' '}
                  <button type="button" className="btn btn-danger" onClick={() => discardHold(h.id)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!holds.length && <div className="empty">No held sales</div>}
      </Modal>
    </>
  );
}
