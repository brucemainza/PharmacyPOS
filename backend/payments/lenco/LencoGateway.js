import crypto from 'crypto';
import { PaymentGateway } from '../PaymentGateway.js';
import { createLencoClient } from './client.js';
import { encryptCardPayload } from './encryption.js';

// Maps Lenco's collection status vocabulary onto our internal status vocabulary (see the
// `payments.status` column in server/db.js). Kept as its own function so tests can exercise it
// without a live API call.
export function mapLencoStatus(lencoStatus) {
  switch (lencoStatus) {
    case 'successful':
      return 'successful';
    case 'failed':
      return 'failed';
    case '3ds-auth-required':
      return 'action_required';
    case 'pending':
    case 'pay-offline':
    default:
      return 'pending';
  }
}

function mapCollectionResponse(data, meta) {
  if (!data) return null;
  return {
    providerReference: data.lencoReference || null,
    reference: data.reference,
    status: mapLencoStatus(data.status),
    rawStatus: data.status,
    amount: data.amount,
    currency: data.currency,
    type: data.type,
    reasonForFailure: data.reasonForFailure ?? null,
    redirectUrl: meta?.authorization?.redirect ?? null,
    raw: data,
  };
}

// Bearer-secret-key API client for Lenco Pay's card + mobile money "collections" — see
// https://lenco-api.readme.io/v2.0/reference/accept-payments and the linked endpoint pages.
// Fetched and confirmed against the live docs before writing this (ground rule: never invent
// API behavior) — endpoint paths, field names, and status vocabularies below are copied from
// those pages, not guessed.
export class LencoGateway extends PaymentGateway {
  constructor({ baseUrl, secretKey }) {
    super();
    this.baseUrl = baseUrl;
    this.secretKey = secretKey;
    this.client = createLencoClient({ baseUrl, secretKey });
  }

  async initiatePayment(params) {
    const { method, reference, amount, currency = 'ZMW', bearer } = params;

    if (method === 'card') {
      return this._initiateCard({
        reference,
        amount,
        currency,
        bearer,
        customer: params.customer,
        billing: params.billing,
        card: params.card,
      });
    }
    if (method === 'mobile_money') {
      return this._initiateMobileMoney({ reference, amount, currency, bearer, ...params.mobileMoney });
    }
    throw new Error(`LencoGateway.initiatePayment: unsupported method "${method}"`);
  }

  async _initiateCard({ reference, amount, currency, bearer, customer, billing, card }) {
    if (!customer?.firstName || !customer?.lastName) {
      throw new Error('LencoGateway: card payments require customer.firstName and customer.lastName');
    }
    if (!card?.number || !card?.expiryMonth || !card?.expiryYear || !card?.cvv) {
      throw new Error('LencoGateway: card payments require card.number, expiryMonth, expiryYear, cvv');
    }
    if (!billing?.streetAddress || !billing?.city || !billing?.postalCode || !billing?.country) {
      throw new Error(
        'LencoGateway: card payments require billing.streetAddress, city, postalCode, country'
      );
    }

    const unencryptedPayload = {
      reference,
      email: customer.email,
      amount: String(amount),
      currency,
      ...(bearer ? { bearer } : {}),
      customer: { firstName: customer.firstName, lastName: customer.lastName },
      billing,
      card: {
        number: card.number,
        expiryMonth: card.expiryMonth,
        expiryYear: card.expiryYear,
        cvv: card.cvv,
      },
    };

    const encryptedPayload = await encryptCardPayload(this.client, unencryptedPayload);
    const res = await this.client.post('/collections/card', { encryptedPayload });
    return mapCollectionResponse(res.data, res.meta);
  }

  async _initiateMobileMoney({ reference, amount, currency, bearer, phone, operator, country }) {
    if (!phone || !operator) {
      throw new Error('LencoGateway: mobile money payments require phone and operator');
    }

    const res = await this.client.post('/collections/mobile-money', {
      amount,
      reference,
      phone,
      operator,
      ...(country ? { country } : {}),
      ...(bearer ? { bearer } : {}),
    });
    // currency isn't part of the mobile-money request per the docs (ZMW/MWK implied by
    // country+operator) — keep it in our own record from what the caller asked for.
    return { ...mapCollectionResponse(res.data), currency: res.data?.currency || currency };
  }

  async checkStatus(reference) {
    const res = await this.client.get(`/collections/status/${encodeURIComponent(reference)}`);
    return mapCollectionResponse(res.data);
  }

  // HMAC-SHA512 of the raw request body, keyed by SHA256(secretKey) hex digest — exactly as
  // specified at https://lenco-api.readme.io/v2.0/reference/webhooks. `rawBody` must be the
  // exact bytes Lenco sent (see server/routes/payments.js's raw-body capture) rather than a
  // re-`JSON.stringify`'d object, which can differ in key order/whitespace from what was signed.
  verifyWebhookSignature(rawBody, signatureHeader) {
    if (!signatureHeader) return false;
    const hashKey = crypto.createHash('sha256').update(this.secretKey).digest('hex');
    const computed = crypto.createHmac('sha512', hashKey).update(rawBody).digest('hex');
    return timingSafeEqualHex(computed, signatureHeader);
  }

  async handleWebhook(rawBody, headers) {
    const signature = headers['x-lenco-signature'];
    if (!this.verifyWebhookSignature(rawBody, signature)) {
      const err = new Error('Invalid Lenco webhook signature');
      err.statusCode = 401;
      throw err;
    }

    const event = JSON.parse(rawBody);
    return {
      event: event.event,
      record: mapCollectionResponse(event.data),
    };
  }

  // Lenco's v2.0 API (confirmed via https://lenco-api.readme.io/v2.0/llms.txt) has no
  // "refund a collection" endpoint — only outbound transfers exist, which are a materially
  // different flow (recipient creation, a separate payout, no link back to the original
  // collection). Rather than fake a refund with a transfer, this surfaces the limitation so
  // callers handle it explicitly — see docs/payments/lenco-integration.md.
  async refund() {
    throw new Error(
      'LencoGateway.refund: Lenco Pay has no collections-refund endpoint as of API v2.0 — ' +
        'card/mobile-money refunds must be reconciled manually. See docs/payments/lenco-integration.md.'
    );
  }

  async isReachable(timeoutMs = 3000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.baseUrl}/encryption-key`, {
        headers: { Authorization: `Bearer ${this.secretKey}` },
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

function timingSafeEqualHex(a, b) {
  try {
    const bufA = Buffer.from(a, 'hex');
    const bufB = Buffer.from(b, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  } catch {
    return false;
  }
}
