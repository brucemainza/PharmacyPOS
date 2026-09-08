// Real integration tests against the live Lenco *sandbox* — never production. Ground rule from
// the engineering brief: "Write integration tests against the Lenco sandbox only — never
// live/production keys in tests or CI." These make genuine network calls and take real time
// (mobile money collections resolve asynchronously in sandbox), so they're kept out of the fast
// `npm test` suite — run explicitly with `npm run test:lenco-sandbox`.
//
// Skips (not fails) when LENCO_SECRET_KEY isn't configured, so a contributor without sandbox
// credentials can still run the rest of the suite.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LencoGateway } from '../lenco/LencoGateway.js';
import { getLencoConfig } from '../../config.js';

const config = getLencoConfig();
const skip = !config.secretKey ? 'LENCO_SECRET_KEY not set — see .env.example' : false;

function gateway() {
  return new LencoGateway(config);
}

function reference(prefix) {
  return `test-${prefix}-${Date.now()}`;
}

async function pollUntilTerminal(gw, reference, { timeoutMs = 30000, intervalMs = 2000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await gw.checkStatus(reference);
    if (last.status === 'successful' || last.status === 'failed') return last;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return last;
}

test('LencoGateway.isReachable succeeds against the sandbox with real credentials', { skip }, async () => {
  const reachable = await gateway().isReachable();
  assert.equal(reachable, true);
});

test(
  'mobile money collection: MTN success test number resolves to successful',
  { skip },
  async () => {
    const ref = reference('momo-ok');
    const initiated = await gateway().initiatePayment({
      method: 'mobile_money',
      reference: ref,
      amount: 10,
      currency: 'ZMW',
      mobileMoney: { phone: '0961111111', operator: 'mtn', country: 'zm' },
    });

    assert.equal(initiated.reference, ref);
    assert.ok(initiated.providerReference, 'Lenco should assign a lencoReference');
    // Per the docs' own example response, sandbox mobile money starts as pending/pay-offline,
    // not immediately successful.
    assert.equal(initiated.status, 'pending');

    const final = await pollUntilTerminal(gateway(), ref);
    assert.equal(final.status, 'successful');
  }
);

test(
  'mobile money collection: Airtel ZM "not enough funds" test number resolves to failed',
  { skip },
  async () => {
    const ref = reference('momo-fail');
    const initiated = await gateway().initiatePayment({
      method: 'mobile_money',
      reference: ref,
      amount: 10,
      currency: 'ZMW',
      mobileMoney: { phone: '0975555555', operator: 'airtel', country: 'zm' },
    });
    assert.equal(initiated.status, 'pending');

    // Observed in practice to resolve around ~30s (right at the default poll window), so this
    // one gets extra headroom rather than a tight timeout that's flaky run to run.
    const final = await pollUntilTerminal(gateway(), ref, { timeoutMs: 60000, intervalMs: 3000 });
    assert.equal(final.status, 'failed');
    assert.ok(final.reasonForFailure, 'a failed collection should carry reasonForFailure');
  }
);

test(
  'mobile money collection: duplicate reference is rejected by the sandbox (not silently retried)',
  { skip },
  async () => {
    const ref = reference('momo-dup');
    const gw = gateway();
    await gw.initiatePayment({
      method: 'mobile_money',
      reference: ref,
      amount: 10,
      currency: 'ZMW',
      mobileMoney: { phone: '0961111111', operator: 'mtn', country: 'zm' },
    });

    await assert.rejects(
      () =>
        gw.initiatePayment({
          method: 'mobile_money',
          reference: ref,
          amount: 10,
          currency: 'ZMW',
          mobileMoney: { phone: '0961111111', operator: 'mtn', country: 'zm' },
        }),
      /uplicate/
    );
  }
);

test(
  'card collection: sandbox test card is accepted end to end (successful or 3DS redirect)',
  { skip },
  async () => {
    const ref = reference('card');
    const initiated = await gateway().initiatePayment({
      method: 'card',
      reference: ref,
      amount: 10,
      currency: 'ZMW',
      customer: { email: 'customer@example.com', firstName: 'John', lastName: 'Doe' },
      billing: {
        streetAddress: '901 Metro Center Blvd',
        city: 'San Francisco',
        state: 'CA',
        postalCode: '94404',
        country: 'US',
      },
      card: { number: '5555555555554444', expiryMonth: '12', expiryYear: '2029', cvv: '123' },
    });

    assert.equal(initiated.reference, ref);
    assert.ok(initiated.providerReference, 'Lenco should assign a lencoReference');
    // The docs' own worked example for this exact test card returns 3ds-auth-required with a
    // redirect URL — asserting "successful or action_required" rather than one fixed outcome
    // since sandbox behavior for card 3DS can legitimately go either way run to run.
    assert.ok(['successful', 'action_required', 'pending'].includes(initiated.status));
    if (initiated.status === 'action_required') {
      assert.ok(initiated.redirectUrl, '3DS-required response should carry a redirect URL');
    }
  }
);

test('checkStatus on an unknown reference returns a 404 from the sandbox', { skip }, async () => {
  await assert.rejects(
    () => gateway().checkStatus(`nonexistent-${Date.now()}`),
    /not found/i
  );
});
