import { PaymentGateway } from './PaymentGateway.js';
import { CashGateway } from './cash/CashGateway.js';
import { LencoGateway } from './lenco/LencoGateway.js';
import { getLencoConfig } from '../config.js';

let registry = null;

// Stands in for Lenco when it can't be constructed (e.g. LENCO_SECRET_KEY unset) — fails only
// when actually used, with a clear reason, rather than crashing the whole registry (and cash
// along with it) at startup.
class UnconfiguredGateway extends PaymentGateway {
  constructor(reason) {
    super();
    this.reason = reason;
  }

  async initiatePayment() {
    throw new Error(`Lenco payment gateway unavailable: ${this.reason}`);
  }

  async checkStatus() {
    throw new Error(`Lenco payment gateway unavailable: ${this.reason}`);
  }

  async handleWebhook() {
    throw new Error(`Lenco payment gateway unavailable: ${this.reason}`);
  }

  async isReachable() {
    return false;
  }
}

// One gateway instance per method, built lazily (so a missing LENCO_SECRET_KEY only breaks
// card/mobile-money, never cash — checkout must keep working offline/unconfigured for cash).
export function getPaymentRegistry() {
  if (registry) return registry;

  const cash = new CashGateway();

  let lenco;
  try {
    lenco = new LencoGateway(getLencoConfig());
  } catch (err) {
    lenco = new UnconfiguredGateway(err.message);
  }

  registry = {
    cash,
    card: lenco,
    mobile_money: lenco,
    lenco,
  };
  return registry;
}

export function getGateway(method) {
  const reg = getPaymentRegistry();
  const gateway = reg[method];
  if (!gateway) throw new Error(`No payment gateway registered for method "${method}"`);
  return gateway;
}

// Test-only: lets tests inject a fresh registry (e.g. a fake Lenco gateway) without the module
// singleton leaking state between test files.
export function _resetRegistryForTests(next) {
  registry = next || null;
}
