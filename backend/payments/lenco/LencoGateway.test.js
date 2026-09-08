import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { LencoGateway, mapLencoStatus } from './LencoGateway.js';

const secretKey = 'unit-test-secret-key';

function gateway() {
  return new LencoGateway({ baseUrl: 'https://sandbox.lenco.co/access/v2', secretKey });
}

function signBody(body) {
  const hashKey = crypto.createHash('sha256').update(secretKey).digest('hex');
  return crypto.createHmac('sha512', hashKey).update(body).digest('hex');
}

test('mapLencoStatus maps every documented status to our internal vocabulary', () => {
  assert.equal(mapLencoStatus('successful'), 'successful');
  assert.equal(mapLencoStatus('failed'), 'failed');
  assert.equal(mapLencoStatus('pending'), 'pending');
  assert.equal(mapLencoStatus('pay-offline'), 'pending');
  assert.equal(mapLencoStatus('3ds-auth-required'), 'action_required');
  assert.equal(mapLencoStatus('some-unknown-future-status'), 'pending');
});

test('verifyWebhookSignature accepts a correctly HMAC-SHA512-signed body', () => {
  const body = JSON.stringify({ event: 'collection.successful', data: { reference: 'ref-1' } });
  const signature = signBody(body);
  assert.equal(gateway().verifyWebhookSignature(body, signature), true);
});

test('verifyWebhookSignature rejects a tampered body or wrong signature', () => {
  const body = JSON.stringify({ event: 'collection.successful', data: { reference: 'ref-1' } });
  const signature = signBody(body);

  assert.equal(gateway().verifyWebhookSignature(body + ' ', signature), false);
  assert.equal(gateway().verifyWebhookSignature(body, 'not-a-real-signature'), false);
  assert.equal(gateway().verifyWebhookSignature(body, ''), false);
});

test('handleWebhook rejects an unsigned/invalid webhook before touching the payload', async () => {
  const body = JSON.stringify({ event: 'collection.successful', data: { reference: 'ref-1' } });
  await assert.rejects(
    () => gateway().handleWebhook(body, { 'x-lenco-signature': 'bogus' }),
    (err) => {
      assert.match(err.message, /Invalid Lenco webhook signature/);
      assert.equal(err.statusCode, 401);
      return true;
    }
  );
});

test('handleWebhook accepts a correctly-signed payload and maps it to our record shape', async () => {
  const data = {
    id: 'e809a3de',
    reference: 'ref-1',
    lencoReference: '240730008',
    amount: '13.00',
    currency: 'ZMW',
    type: 'mobile-money',
    status: 'successful',
    reasonForFailure: null,
  };
  const body = JSON.stringify({ event: 'collection.successful', data });
  const signature = signBody(body);

  const { event, record } = await gateway().handleWebhook(body, {
    'x-lenco-signature': signature,
  });

  assert.equal(event, 'collection.successful');
  assert.equal(record.reference, 'ref-1');
  assert.equal(record.providerReference, '240730008');
  assert.equal(record.status, 'successful');
});

test('initiatePayment validates required card fields before making any network call', async () => {
  await assert.rejects(
    () =>
      gateway().initiatePayment({
        method: 'card',
        reference: 'ref-1',
        amount: 10,
        customer: { firstName: 'John' }, // missing lastName
        card: {},
        billing: {},
      }),
    /customer\.firstName and customer\.lastName/
  );
});

test('initiatePayment validates required mobile money fields before making any network call', async () => {
  await assert.rejects(
    () =>
      gateway().initiatePayment({
        method: 'mobile_money',
        reference: 'ref-1',
        amount: 10,
        mobileMoney: {}, // missing phone/operator
      }),
    /phone and operator/
  );
});

test('initiatePayment rejects an unsupported method', async () => {
  await assert.rejects(
    () => gateway().initiatePayment({ method: 'bitcoin', reference: 'ref-1', amount: 10 }),
    /unsupported method/
  );
});

test('refund surfaces the documented Lenco API limitation rather than faking success', async () => {
  await assert.rejects(() => gateway().refund('ref-1', 10), /no collections-refund endpoint/);
});
