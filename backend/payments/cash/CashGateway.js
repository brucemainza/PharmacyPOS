import { PaymentGateway } from '../PaymentGateway.js';

// Cash needs no network, no encryption, no webhook — it exists as a gateway purely so checkout
// code can treat every tender type through one interface instead of special-casing cash.
export class CashGateway extends PaymentGateway {
  async initiatePayment({ reference, amount, currency }) {
    return {
      reference,
      providerReference: null,
      status: 'successful',
      redirectUrl: null,
      raw: { method: 'cash', amount, currency },
    };
  }

  async checkStatus(reference) {
    return { reference, providerReference: null, status: 'successful', raw: { method: 'cash' } };
  }

  async refund(reference, amount) {
    return { reference, providerReference: null, status: 'refunded', raw: { method: 'cash', amount } };
  }
}
