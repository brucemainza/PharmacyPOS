const TOKEN_KEY = 'pos_token';
const USER_KEY = 'pos_user';

export type User = {
  _id: number;
  id: number;
  username: string;
  fullname: string;
  role?: 'cashier' | 'pharmacist' | 'manager' | 'admin' | 'tech';
  perm_products: number;
  perm_categories: number;
  perm_transactions: number;
  perm_users: number;
  perm_settings: number;
  perm_discount_approve?: number;
  perm_refund_void?: number;
  perm_controlled_approve?: number;
  perm_price_override?: number;
  status?: string;
};

export type Product = {
  _id: number;
  id: number;
  name: string;
  price: number;
  category: string;
  quantity: number;
  stock: number;
  img: string;
  batch_tracked?: boolean;
  controlled_substance?: boolean;
  generic_group?: string;
  reorder_level?: number;
  supplier_id?: number | null;
};

export type Category = {
  _id: number;
  id: number;
  name: string;
};

export type Customer = {
  _id: string;
  id: number;
  name: string;
  phone: string;
  email: string;
  address: string;
  date_of_birth?: string;
  allergies?: string;
  loyalty_points?: number;
  corporate_account_id?: number | null;
  insurance_ref?: string;
};

export type CorporateAccount = {
  _id: number;
  id: number;
  name: string;
  discount_percent: number;
  created_at: string;
};

export type Settings = {
  app: string;
  store: string;
  address_one: string;
  address_two: string;
  contact: string;
  tax: string;
  symbol: string;
  percentage: number;
  charge_tax: boolean;
  footer: string;
  img: string;
  till: number;
  ip: string;
  pexels_api_key?: string;
  discount_approval_threshold?: number;
  loyalty_earn_rate?: number;
};

export type MediaItem = {
  id: number;
  filename: string;
  path: string;
  source: string;
  pexels_id?: number | null;
  photographer: string;
  alt: string;
  created_at: string;
};

export type PexelsPhoto = {
  id: number;
  photographer: string;
  alt: string;
  preview: string;
  download: string;
  url: string;
};

export type CartItem = {
  id: number;
  name: string;
  price: number;
  quantity: number;
  stock: number;
};

export type PrescriptionItem = {
  _id: number;
  id: number;
  prescription_id: number;
  product_id: number;
  product_name: string;
  product_controlled: boolean;
  generic_group: string;
  prescribed_qty: number;
  dispensed_qty: number;
  remaining_qty: number;
  substituted_product_id: number | null;
  partial_fill_state: 'none' | 'partial' | 'complete';
  pharmacist_user_id: number | null;
  approved_at: string | null;
};

export type Prescription = {
  _id: number;
  id: number;
  patient_id: number;
  prescriber_name: string;
  prescriber_reg_no: string;
  date: string;
  status: 'open' | 'partially_filled' | 'completed' | 'cancelled';
  notes: string;
  created_at: string;
  items: PrescriptionItem[];
};

export type Supplier = {
  _id: number;
  id: number;
  name: string;
  contact: string;
  email: string;
  phone: string;
  address: string;
};

export type ProductBatch = {
  _id: number;
  id: number;
  product_id: number;
  product_name?: string;
  batch_no: string;
  expiry_date: string;
  qty_on_hand: number;
  supplier_id: number | null;
  received_at: string;
};

export type StockMovement = {
  _id: number;
  id: number;
  product_id: number;
  batch_id: number | null;
  movement_type: string;
  qty_delta: number;
  ref_type: string;
  ref_id: number | null;
  user_id: number;
  branch_id: number;
  notes: string;
  created_at: string;
};

export type Branch = {
  _id: number;
  id: number;
  name: string;
  is_local: boolean;
  created_at: string;
};

export type StockTransferItem = {
  id: number;
  stock_transfer_id: number;
  product_id: number;
  product_name?: string;
  batch_id: number | null;
  qty: number;
};

export type StockTransfer = {
  _id: number;
  id: number;
  from_branch_id: number;
  to_branch_id: number;
  status: 'pending' | 'received';
  notes: string;
  created_by: number;
  created_at: string;
  received_by: number | null;
  received_at: string | null;
  items?: StockTransferItem[];
};

export type StockTakeItem = {
  id: number;
  stock_take_id: number;
  product_id: number;
  product_name?: string;
  expected_qty: number;
  counted_qty: number | null;
  variance: number | null;
};

export type StockTake = {
  _id: number;
  id: number;
  business_date: string;
  status: 'open' | 'completed';
  created_by: number;
  created_at: string;
  completed_at: string | null;
  items: StockTakeItem[];
  variance_report?: { productId: number; expected: number; counted: number; variance: number }[];
};

export type DailySales = { day: string; transaction_count: number; sales_total: number; discount_total: number };

export type ProfitMarginRow = {
  product_id: number;
  product_name: string;
  qty_sold: number;
  revenue: number;
  cost_of_goods: number;
  profit: number;
  margin_pct: number;
  has_cost_data: boolean;
};

export type CashierPerformanceRow = {
  user_id: number;
  user_name: string;
  transaction_count: number;
  sales_total: number;
  average_sale: number;
  refund_void_count: number;
};

export type MoverRow = { product_id: number; product_name: string; on_hand: number; qty_sold: number };

export type StockValuationRow = {
  product_id: number;
  product_name: string;
  quantity: number;
  retail_value: number;
  cost_value: number;
  has_cost_data: boolean;
};

export type ControlledRegisterRow = {
  id: number;
  prescription_item_id: number;
  transaction_id: number | null;
  product_id: number;
  product_name: string;
  qty: number;
  dispensing_user_id: number;
  dispensing_user_name: string;
  approving_user_id: number;
  approving_user_name: string;
  patient_id: number;
  patient_name: string;
  created_at: string;
};

export type Transaction = {
  _id: number;
  id: number;
  ref_number: string;
  customer: string;
  customer_name: string;
  status: number;
  user_id: number;
  user: string;
  till: number;
  discount: number;
  subtotal: number;
  tax: number;
  total: number;
  paid: number;
  change: number;
  payment_type: number;
  discount_approved_by?: number | null;
  void_refund_reason?: string;
  loyalty_points_earned?: number;
  items: CartItem[];
  date: string;
};

export type CashUp = {
  _id: number;
  id: number;
  till: number;
  business_date: string;
  opened_by: number;
  sales_total: number;
  cash_total: number;
  card_total: number;
  mobile_money_total: number;
  refunds_total: number;
  transaction_count: number;
  expected_cash: number;
  counted_cash: number;
  variance: number;
  notes: string;
  created_at: string;
};

export type CashUpPreview = {
  till: number;
  date: string;
  sales_total: number;
  cash_total: number;
  card_total: number;
  mobile_money_total: number;
  refunds_total: number;
  transaction_count: number;
  expected_cash: number;
};

export type PaymentMethods = { cash: boolean; card: boolean; mobile_money: boolean };

export type PaymentStatus = 'pending' | 'successful' | 'failed' | 'action_required' | 'refunded';

export type Payment = {
  _id: number;
  id: number;
  transaction_id: number | null;
  provider: string;
  method: string;
  reference: string;
  provider_reference: string | null;
  amount: number;
  currency: string;
  status: PaymentStatus;
  reason_for_failure: string | null;
  redirect_url: string | null;
  initiated_at: string;
  confirmed_at: string | null;
};

export type InitiatePaymentBody = {
  transactionId?: number | null;
  method: 'cash' | 'card' | 'mobile_money';
  amount: number;
  currency?: string;
  bearer?: 'merchant' | 'customer';
  customer?: { email?: string; firstName?: string; lastName?: string };
  billing?: {
    streetAddress: string;
    city: string;
    state?: string;
    postalCode: string;
    country: string;
  };
  card?: { number: string; expiryMonth: string; expiryYear: string; cvv: string };
  mobileMoney?: {
    phone: string;
    operator: 'airtel' | 'mtn' | 'tnm' | 'zamtel';
    country?: 'zm' | 'mw';
  };
};

export type InitiatePaymentResult = {
  reference: string;
  status: PaymentStatus;
  redirectUrl: string | null;
  transactionId: number | null;
};

let baseUrl = 'http://127.0.0.1:8001/api';

export function setBaseUrl(url: string) {
  baseUrl = url.replace(/\/$/, '');
}

export function getBaseUrl() {
  return baseUrl;
}

export function getUploadsBase() {
  return baseUrl.replace(/\/api$/, '') + '/uploads';
}

export function getStoredToken() {
  return localStorage.getItem(TOKEN_KEY);
}

export function getStoredUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function storeSession(token: string, user: User) {
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
}

export function clearSession() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function request<T>(
  path: string,
  options: RequestInit = {},
  auth = true
): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!(options.body instanceof FormData) && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  if (auth) {
    const token = getStoredToken();
    if (token) headers.set('Authorization', `Bearer ${token}`);
  }

  const res = await fetch(`${baseUrl}${path}`, { ...options, headers });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const data = await res.json();
      message = data.error || message;
    } catch {
      /* ignore */
    }
    throw new Error(message || `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as T;
  }
}

export async function healthCheck(healthUrl: string) {
  const res = await fetch(healthUrl, { method: 'GET' });
  if (!res.ok) throw new Error('Server unreachable');
  return res.json();
}

export const api = {
  login: (username: string, password: string) =>
    request<{ user: User; token: string }>(
      '/users/login',
      { method: 'POST', body: JSON.stringify({ username, password }) },
      false
    ),

  checkUsers: () => request<{ ready: boolean }>('/users/check', {}, false),

  getUser: (id: number) => request<User>(`/users/user/${id}`),

  logout: (id: number) => request(`/users/logout/${id}`),

  getUsers: () => request<User[]>('/users/all'),

  saveUser: (body: Record<string, unknown>) =>
    request('/users/post', { method: 'POST', body: JSON.stringify(body) }),

  deleteUser: (id: number) =>
    request(`/users/user/${id}`, { method: 'DELETE' }),

  getProducts: () => request<Product[]>('/inventory/products'),

  saveProduct: (form: FormData) =>
    request('/inventory/product', { method: 'POST', body: form }),

  deleteProduct: (id: number) =>
    request(`/inventory/product/${id}`, { method: 'DELETE' }),

  deleteProducts: (ids: number[]) =>
    request<{ ok: boolean; deleted: number }>('/inventory/products/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  findBySku: (skuCode: string) =>
    request<Product | null>('/inventory/product/sku', {
      method: 'POST',
      body: JSON.stringify({ skuCode }),
    }),

  getCategories: () => request<Category[]>('/categories/all'),

  saveCategory: (body: { name: string }) =>
    request('/categories/category', { method: 'POST', body: JSON.stringify(body) }),

  updateCategory: (body: { id: number; name: string }) =>
    request('/categories/category', { method: 'PUT', body: JSON.stringify(body) }),

  deleteCategory: (id: number) =>
    request(`/categories/category/${id}`, { method: 'DELETE' }),

  getCustomers: () => request<Customer[]>('/customers/all'),

  saveCustomer: (body: Partial<Customer>) =>
    request('/customers/customer', { method: 'POST', body: JSON.stringify(body) }),

  updateCustomer: (body: Partial<Customer>) =>
    request('/customers/customer', { method: 'PUT', body: JSON.stringify(body) }),

  deleteCustomer: (id: number) =>
    request(`/customers/customer/${id}`, { method: 'DELETE' }),

  getCustomerHistory: (id: number) => request<Transaction[]>(`/customers/customer/${id}/history`),

  getCorporateAccounts: () => request<CorporateAccount[]>('/customers/corporate-accounts'),

  saveCorporateAccount: (body: { id?: number; name: string; discount_percent: number }) =>
    request<CorporateAccount>('/customers/corporate-account', { method: 'POST', body: JSON.stringify(body) }),

  deleteCorporateAccount: (id: number) =>
    request<void>(`/customers/corporate-account/${id}`, { method: 'DELETE' }),

  getSettings: () => request<{ _id: number; settings: Settings }>('/settings/get'),

  saveSettings: (form: FormData) =>
    request<{ _id: number; settings: Settings }>('/settings/post', {
      method: 'POST',
      body: form,
    }),

  getOnHold: () => request<Transaction[]>('/on-hold'),

  getCustomerOrders: () => request<Transaction[]>('/customer-orders'),

  getByDate: (params: {
    start: string;
    end: string;
    user: number;
    till: number;
    status: number;
  }) => {
    const q = new URLSearchParams({
      start: params.start,
      end: params.end,
      user: String(params.user),
      till: String(params.till),
      status: String(params.status),
    });
    return request<Transaction[]>(`/by-date?${q}`);
  },

  createTransaction: (body: Record<string, unknown>) =>
    request('/new', { method: 'POST', body: JSON.stringify(body) }),

  updateTransaction: (body: Record<string, unknown>) =>
    request('/new', { method: 'PUT', body: JSON.stringify(body) }),

  deleteTransaction: (orderId: number) =>
    request('/delete', { method: 'POST', body: JSON.stringify({ orderId }) }),

  authorizeUser: (username: string, password: string, perm: string) =>
    request<{ id: number; fullname: string; username: string }>(
      '/users/authorize',
      { method: 'POST', body: JSON.stringify({ username, password, perm }) }
    ),

  voidTransaction: (transactionId: number, reason: string) =>
    request<{ ok: boolean }>('/void', {
      method: 'POST',
      body: JSON.stringify({ transactionId, reason }),
    }),

  refundTransaction: (
    transactionId: number,
    reason: string,
    items?: { id: number; quantity: number }[]
  ) =>
    request<{ ok: boolean }>('/refund', {
      method: 'POST',
      body: JSON.stringify({ transactionId, reason, items }),
    }),

  getCashUpPreview: (till: number, date: string) =>
    request<CashUpPreview>(`/cash-up?till=${till}&date=${date}`),

  recordCashUp: (body: { till: number; date: string; counted_cash: number; notes?: string }) =>
    request<CashUp>('/cash-up', { method: 'POST', body: JSON.stringify(body) }),

  getCashUpHistory: (till?: number) =>
    request<CashUp[]>(`/cash-up/history${till ? `?till=${till}` : ''}`),

  getPaymentMethods: () => request<PaymentMethods>('/payments/methods'),

  initiatePayment: (body: InitiatePaymentBody) =>
    request<InitiatePaymentResult>('/payments/initiate', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getPaymentStatus: (reference: string) =>
    request<Payment>(`/payments/${encodeURIComponent(reference)}/status`),

  linkPayment: (reference: string, transactionId: number) =>
    request<Payment>(`/payments/${encodeURIComponent(reference)}/link`, {
      method: 'POST',
      body: JSON.stringify({ transactionId }),
    }),

  getMediaLibrary: () => request<MediaItem[]>('/media/library'),

  uploadMedia: (file: File, alt = '') => {
    const fd = new FormData();
    fd.append('image', file);
    if (alt) fd.append('alt', alt);
    return request<MediaItem>('/media/upload', { method: 'POST', body: fd });
  },

  deleteMedia: (id: number) =>
    request(`/media/library/${id}`, { method: 'DELETE' }),

  seedDemo: () =>
    request<{
      ok: boolean;
      message: string;
      categoriesAdded: number;
      productsAdded: number;
      customersAdded: number;
    }>('/demo/seed', { method: 'POST', body: '{}' }),

  clearDemo: (options?: {
    products?: boolean;
    categories?: boolean;
    customers?: boolean;
    transactions?: boolean;
  }) =>
    request<{ ok: boolean; message: string; deleted: Record<string, number> }>(
      '/demo/clear',
      { method: 'POST', body: JSON.stringify(options || {}) }
    ),

  searchPexels: (q: string, page = 1) => {
    const params = new URLSearchParams({ q, page: String(page), per_page: '20' });
    return request<{
      page: number;
      per_page: number;
      total_results: number;
      photos: PexelsPhoto[];
    }>(`/media/pexels/search?${params}`);
  },

  downloadPexels: (body: {
    photoId: number;
    imageUrl: string;
    photographer?: string;
    alt?: string;
  }) =>
    request<MediaItem>('/media/pexels/download', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getPrescriptions: (params?: { patientId?: number; status?: string }) => {
    const q = new URLSearchParams();
    if (params?.patientId) q.set('patientId', String(params.patientId));
    if (params?.status) q.set('status', params.status);
    const qs = q.toString();
    return request<Prescription[]>(`/prescriptions/all${qs ? `?${qs}` : ''}`);
  },

  getPrescription: (id: number) => request<Prescription>(`/prescriptions/${id}`),

  createPrescription: (body: {
    patient_id: number;
    prescriber_name?: string;
    prescriber_reg_no?: string;
    date?: string;
    notes?: string;
    items: { product_id: number; prescribed_qty: number }[];
  }) =>
    request<Prescription>('/prescriptions/', { method: 'POST', body: JSON.stringify(body) }),

  updatePrescription: (id: number, body: { notes?: string; status?: string }) =>
    request<Prescription>(`/prescriptions/${id}`, { method: 'PUT', body: JSON.stringify(body) }),

  dispensePrescriptionItem: (
    prescriptionId: number,
    itemId: number,
    body: {
      dispensed_qty: number;
      substituted_product_id?: number | null;
      transaction_id?: number | null;
      approving_user_id?: number | null;
    }
  ) =>
    request<Prescription>(`/prescriptions/${prescriptionId}/items/${itemId}/dispense`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  getSuppliers: () => request<Supplier[]>('/inventory/suppliers'),

  saveSupplier: (body: { id?: number; name: string; contact?: string; email?: string; phone?: string; address?: string }) =>
    request<Supplier>('/inventory/supplier', { method: 'POST', body: JSON.stringify(body) }),

  deleteSupplier: (id: number) => request<void>(`/inventory/supplier/${id}`, { method: 'DELETE' }),

  getBatches: (params?: { productId?: number; nearExpiryDays?: number }) => {
    const q = new URLSearchParams();
    if (params?.productId) q.set('productId', String(params.productId));
    if (params?.nearExpiryDays != null) q.set('nearExpiryDays', String(params.nearExpiryDays));
    const qs = q.toString();
    return request<ProductBatch[]>(`/inventory/batches${qs ? `?${qs}` : ''}`);
  },

  receiveGrn: (body: {
    supplier_id?: number | null;
    items: { product_id: number; batch_no?: string; expiry_date?: string; qty: number; unit_cost?: number }[];
  }) => request<{ ok: true; batches: number[] }>('/inventory/grn', { method: 'POST', body: JSON.stringify(body) }),

  getReorderSuggestions: () => request<(Product & { suggested_qty: number })[]>('/inventory/reorder-suggestions'),

  adjustStock: (body: { product_id: number; qty_delta: number; reason: string }) =>
    request<Product>('/inventory/adjustment', { method: 'POST', body: JSON.stringify(body) }),

  getStockMovements: (productId?: number) =>
    request<StockMovement[]>(`/inventory/movements${productId ? `?productId=${productId}` : ''}`),

  getBranches: () => request<Branch[]>('/inventory/branches'),

  createBranch: (name: string) => request<Branch>('/inventory/branch', { method: 'POST', body: JSON.stringify({ name }) }),

  getTransfers: (status?: string) => request<StockTransfer[]>(`/inventory/transfers${status ? `?status=${status}` : ''}`),

  getTransfer: (id: number) => request<StockTransfer>(`/inventory/transfer/${id}`),

  createTransfer: (body: { to_branch_id: number; notes?: string; items: { product_id: number; batch_id?: number | null; qty: number }[] }) =>
    request<StockTransfer>('/inventory/transfer', { method: 'POST', body: JSON.stringify(body) }),

  receiveTransfer: (id: number) => request<StockTransfer>(`/inventory/transfer/${id}/receive`, { method: 'POST' }),

  getStockTakes: () => request<StockTake[]>('/inventory/stock-takes'),

  getStockTake: (id: number) => request<StockTake>(`/inventory/stock-take/${id}`),

  startStockTake: (business_date?: string) =>
    request<StockTake>('/inventory/stock-take', { method: 'POST', body: JSON.stringify({ business_date }) }),

  countStockTakeItem: (stockTakeId: number, itemId: number, counted_qty: number) =>
    request<StockTake>(`/inventory/stock-take/${stockTakeId}/item/${itemId}`, {
      method: 'PUT',
      body: JSON.stringify({ counted_qty }),
    }),

  completeStockTake: (id: number) => request<StockTake>(`/inventory/stock-take/${id}/complete`, { method: 'POST' }),

  getDailySales: (params?: { start?: string; end?: string }) =>
    request<DailySales[]>(`/analytics/daily-sales${dateQuery(params)}`),

  getProfitMargin: (params?: { start?: string; end?: string }) =>
    request<ProfitMarginRow[]>(`/analytics/profit-margin${dateQuery(params)}`),

  getCashierPerformance: (params?: { start?: string; end?: string }) =>
    request<CashierPerformanceRow[]>(`/analytics/cashier-performance${dateQuery(params)}`),

  getMovers: (params?: { start?: string; end?: string; limit?: number }) => {
    const q = new URLSearchParams();
    if (params?.start) q.set('start', params.start);
    if (params?.end) q.set('end', params.end);
    if (params?.limit) q.set('limit', String(params.limit));
    const qs = q.toString();
    return request<{ fast_movers: MoverRow[]; slow_movers: MoverRow[] }>(`/analytics/movers${qs ? `?${qs}` : ''}`);
  },

  getStockValuation: () =>
    request<{ products: StockValuationRow[]; totals: { retail_value: number; cost_value: number } }>(
      '/analytics/stock-valuation'
    ),

  getControlledRegister: (params?: { start?: string; end?: string }) =>
    request<ControlledRegisterRow[]>(`/analytics/controlled-register${dateQuery(params)}`),
};

function dateQuery(params?: { start?: string; end?: string }) {
  const q = new URLSearchParams();
  if (params?.start) q.set('start', params.start);
  if (params?.end) q.set('end', params.end);
  const qs = q.toString();
  return qs ? `?${qs}` : '';
}
