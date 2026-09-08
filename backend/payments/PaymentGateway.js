// Common contract every payment provider implements, so checkout code never branches on
// "is this Lenco or cash" — it just calls the gateway. See cash/CashGateway.js and
// lenco/LencoGateway.js for the two implementations Phase 2 ships.
export class PaymentGateway {
  /**
   * @param {{ reference: string, amount: number, currency: string, method: string, [key: string]: unknown }} params
   * @returns {Promise<{ reference: string, providerReference: string|null, status: string, redirectUrl?: string|null, raw: unknown }>}
   */
  async initiatePayment(_params) {
    throw new Error(`${this.constructor.name}.initiatePayment is not implemented`);
  }

  /** @param {string} reference */
  async checkStatus(_reference) {
    throw new Error(`${this.constructor.name}.checkStatus is not implemented`);
  }

  /**
   * @param {string} rawBody
   * @param {Record<string, string>} headers
   */
  async handleWebhook(_rawBody, _headers) {
    throw new Error(`${this.constructor.name}.handleWebhook is not implemented`);
  }

  /**
   * @param {string} reference
   * @param {number} amount
   */
  async refund(_reference, _amount) {
    throw new Error(`${this.constructor.name}.refund is not implemented`);
  }
}
