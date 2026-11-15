import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/config/db';
import { callbackSignature } from '../src/modules/payments/mpesa.service';
import { maskPhone, normalizePhone } from '../src/services/mpesa/phone';
import { businessToday } from '../src/utils/dates';
import { app, as, createBusiness, createProduct, createUser, login, resetDb, type Session } from './helpers';

let admin: Session;
let manager: Session;
let other: Session;
let productId: string;

beforeAll(async () => {
  process.env.MPESA_MODE = 'simulator';
  await resetDb();
  const a = await createBusiness('mp-a');
  const b = await createBusiness('mp-b');
  await createUser('admin@mp-a.test', [{ businessId: a, role: 'admin' }]);
  await createUser('mgr@mp-a.test', [{ businessId: a, role: 'shop_manager' }]);
  await createUser('admin@mp-b.test', [{ businessId: b, role: 'admin' }]);
  admin = await login('admin@mp-a.test', a);
  manager = await login('mgr@mp-a.test', a);
  other = await login('admin@mp-b.test', b);
  productId = (await createProduct(admin, { priceCents: 35000, openingStock: 100 })).id;
});
afterAll(async () => {
  process.env.MPESA_MODE = 'off';
  await closePool();
});

const prompt = (s: Session, phone: string, amountCents = 35000, requestKey?: string) =>
  as(s).post('/api/payments/mpesa/requests').send({ phone, amountCents, ...(requestKey ? { requestKey } : {}) });

const status = async (s: Session, id: string) => (await as(s).get(`/api/payments/mpesa/requests/${id}`)).body;

/** Polls like the till does until the prompt leaves "pending". */
async function settle(s: Session, id: string, timeoutMs = 4000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const r = await status(s, id);
    if (r.status !== 'pending' || Date.now() > end) return r;
    await new Promise((res) => setTimeout(res, 40));
  }
}

const sell = (s: Session, payments: unknown[], total = 35000) =>
  as(s).post('/api/sales').set('Idempotency-Key', randomUUID()).send({ items: [{ productId, quantity: total / 35000 }], payments });

describe('phone numbers', () => {
  it('normalises the ways Kenyans write a mobile number', () => {
    for (const n of ['0712345678', '712345678', '+254712345678', '254 712 345 678', '0712-345-678']) {
      expect(normalizePhone(n)).toBe('254712345678');
    }
    expect(normalizePhone('0112345678')).toBe('254112345678');
    for (const bad of ['', 'abc', '071234567', '0812345678', '+255712345678', '07123456789']) expect(normalizePhone(bad)).toBeNull();
    expect(maskPhone('254712345678')).toBe('254712***678');
  });
});

describe('sending a prompt', () => {
  it('lets admins and shop managers send, and validates the input', async () => {
    expect((await prompt(admin, '0712345670')).status).toBe(201);
    expect((await prompt(manager, '0712345670')).status).toBe(201);
    expect((await prompt(admin, '12345')).status).toBe(422);
    const cents = await prompt(admin, '0712345670', 35050);
    expect(cents.status).toBe(422);
    expect(cents.body.error.details[0].message).toMatch(/whole shillings/);
    expect((await prompt(admin, '0712345670', 100)).status).toBe(201); // KES 1 is the minimum
    expect((await prompt(admin, '0712345670', 0)).status).toBe(422);
  });

  it('never returns the full phone number', async () => {
    const r = await prompt(admin, '0712345670');
    expect(r.body.phone).toBe('254712***670');
  });

  it('returns the same prompt for a repeated request key instead of texting the customer twice', async () => {
    const key = randomUUID();
    const a = await prompt(admin, '0712345670', 35000, key);
    const b = await prompt(admin, '0712345670', 35000, key);
    expect(b.body.id).toBe(a.body.id);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM mpesa_requests WHERE request_key = $1', [key]);
    expect(rows[0].n).toBe(1);
  });

  it('is invisible to other businesses', async () => {
    const r = await prompt(admin, '0712345670');
    expect((await as(other).get(`/api/payments/mpesa/requests/${r.body.id}`)).status).toBe(404);
  });
});

describe('what the customer does', () => {
  it('pays: the prompt completes with a receipt number', async () => {
    const r = await prompt(admin, '0712345670');
    expect(r.body.status).toBe('pending');
    const done = await settle(admin, r.body.id);
    expect(done.status).toBe('paid');
    expect(done.receipt).toMatch(/^SIM[0-9A-F]{8}$/);
  });

  it('cancels (number ending 1)', async () => {
    const done = await settle(admin, (await prompt(admin, '0712345671')).body.id);
    expect(done.status).toBe('cancelled');
    expect(done.resultDesc).toMatch(/cancelled/i);
  });

  it('has no money (number ending 2)', async () => {
    const done = await settle(admin, (await prompt(admin, '0712345672')).body.id);
    expect(done.status).toBe('failed');
    expect(done.resultDesc).toMatch(/balance/i);
  });

  it('never answers (number ending 3): times out', async () => {
    const r = await prompt(admin, '0712345673');
    const done = await settle(admin, r.body.id, 6000);
    expect(done.status).toBe('timeout');
  }, 10_000);
});

describe('using a paid prompt on a sale', () => {
  async function paidPrompt(amountCents = 35000, s = admin) {
    const r = await prompt(s, '0712345670', amountCents);
    const done = await settle(s, r.body.id);
    expect(done.status).toBe('paid');
    return done as { id: string; receipt: string };
  }

  it('records the sale with the receipt number and consumes the prompt exactly once', async () => {
    const p = await paidPrompt();
    const res = await sell(manager, [{ method: 'mpesa', amountCents: 35000, mpesaRequestId: p.id }]);
    expect(res.status).toBe(201);
    expect(res.body.payments[0]).toMatchObject({ method: 'mpesa', reference: p.receipt, verified: true });
    const again = await sell(admin, [{ method: 'mpesa', amountCents: 35000, mpesaRequestId: p.id }]);
    expect(again.status).toBe(422);
    expect(again.body.error.details[0].message).toMatch(/already used/);
  });

  it('refuses prompts that were cancelled, are still pending, or are for another amount', async () => {
    const cancelled = await settle(admin, (await prompt(admin, '0712345671')).body.id);
    expect((await sell(admin, [{ method: 'mpesa', amountCents: 35000, mpesaRequestId: cancelled.id }])).status).toBe(422);

    const pending = await prompt(admin, '0712345673');
    const notDone = await sell(admin, [{ method: 'mpesa', amountCents: 35000, mpesaRequestId: pending.body.id }]);
    expect(notDone.status).toBe(422);
    expect(notDone.body.error.details[0].message).toMatch(/not been completed/);

    const p = await paidPrompt(35000);
    const mismatch = await sell(admin, [{ method: 'mpesa', amountCents: 20000, mpesaRequestId: p.id }, { method: 'cash', amountCents: 15000 }]);
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.error.details[0].message).toMatch(/does not match/);
  });

  it('cannot use another business\'s payment', async () => {
    const p = await paidPrompt(35000, other);
    const res = await sell(admin, [{ method: 'mpesa', amountCents: 35000, mpesaRequestId: p.id }]);
    expect(res.status).toBe(422);
  });

  it('combines a paid prompt with cash', async () => {
    const p = await paidPrompt(20000);
    const res = await sell(admin, [{ method: 'mpesa', amountCents: 20000, mpesaRequestId: p.id }, { method: 'cash', amountCents: 15000 }]);
    expect(res.status).toBe(201);
    expect(res.body.totalCents).toBe(35000);
  });

  it('keeps an unused paid prompt on the "paid but not on any sale" list', async () => {
    const p = await paidPrompt(35000);
    const list = await as(admin).get('/api/payments/mpesa/requests?unmatched=true');
    expect(list.body.items.map((i: { id: string }) => i.id)).toContain(p.id);
    expect((await as(manager).get('/api/payments/mpesa/requests')).status).toBe(403);
  });
});

describe('typing a code by hand', () => {
  it('needs a code while prompts are on, and is reported as unverified at closing', async () => {
    expect((await sell(admin, [{ method: 'mpesa', amountCents: 35000 }])).status).toBe(422);
    expect((await sell(admin, [{ method: 'mpesa', amountCents: 35000, reference: 'AB' }])).status).toBe(422);
    const ok = await sell(admin, [{ method: 'mpesa', amountCents: 35000, reference: 'QK12AB34CD' }]);
    expect(ok.status).toBe(201);
    expect(ok.body.payments[0]).toMatchObject({ reference: 'QK12AB34CD', verified: false });
    const preview = await as(admin).get(`/api/closings/preview?date=${businessToday()}`);
    expect(preview.body.unverifiedMpesaCents).toBe(35000);
  });
});

describe("Safaricom's callback", () => {
  const body = (checkoutId: string, code: number, amount?: number) => ({
    Body: {
      stkCallback: {
        MerchantRequestID: 'm1', CheckoutRequestID: checkoutId, ResultCode: code, ResultDesc: code === 0 ? 'ok' : 'failed',
        ...(code === 0 ? { CallbackMetadata: { Item: [{ Name: 'Amount', Value: amount }, { Name: 'MpesaReceiptNumber', Value: 'RFA1B2C3D4' }, { Name: 'PhoneNumber', Value: 254712345673 }] } } : {}),
      },
    },
  });
  const send = (id: string, sig: string, payload: unknown) => request(app).post(`/api/payments/mpesa/callback/${id}/${sig}`).send(payload as object);
  const checkoutId = async (id: string) => (await pool.query('SELECT provider_request_id FROM mpesa_requests WHERE id = $1', [id])).rows[0].provider_request_id as string;

  it('rejects an address with a wrong signature without revealing anything', async () => {
    const r = await prompt(admin, '0712345673');
    const res = await send(r.body.id, 'f'.repeat(64), body(await checkoutId(r.body.id), 0, 350));
    expect(res.status).toBe(404);
    expect((await status(admin, r.body.id)).status).toBe('pending');
  });

  it('marks the prompt paid with the receipt from a genuine callback, and ignores a repeat', async () => {
    const r = await prompt(admin, '0712345673');
    const id = r.body.id as string;
    const cid = await checkoutId(id);
    const res = await send(id, callbackSignature(id), body(cid, 0, 350));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ResultCode: 0, ResultDesc: 'Accepted' });
    expect(await status(admin, id)).toMatchObject({ status: 'paid', receipt: 'RFA1B2C3D4' });
    await send(id, callbackSignature(id), body(cid, 1032)); // a stray late "cancelled" must not undo a payment
    expect((await status(admin, id)).status).toBe('paid');
  });

  it('does not trust a callback whose amount differs from the request', async () => {
    const r = await prompt(admin, '0712345673');
    const id = r.body.id as string;
    await send(id, callbackSignature(id), body(await checkoutId(id), 0, 1));
    const s = await status(admin, id);
    expect(s.status).toBe('failed');
    expect(s.resultDesc).toMatch(/amount/i);
  });

  it('ignores a callback for a different CheckoutRequestID', async () => {
    const r = await prompt(admin, '0712345673');
    await send(r.body.id, callbackSignature(r.body.id), body('ws_CO_someone_elses', 0, 350));
    expect((await status(admin, r.body.id)).status).toBe('pending');
  });

  it('accepts a late payment for a prompt that already timed out (the money did move)', async () => {
    const r = await prompt(admin, '0712345673');
    const id = r.body.id as string;
    await pool.query(`UPDATE mpesa_requests SET expires_at = now() - interval '1 minute' WHERE id = $1`, [id]);
    expect((await status(admin, id)).status).toBe('timeout');
    await send(id, callbackSignature(id), body(await checkoutId(id), 0, 350));
    expect((await status(admin, id)).status).toBe('paid');
  });
});

describe('when prompts are off', () => {
  it('refuses to send one, and manual M-Pesa entries need no code', async () => {
    process.env.MPESA_MODE = 'off';
    expect((await prompt(admin, '0712345670')).status).toBe(409);
    expect((await sell(admin, [{ method: 'mpesa', amountCents: 35000 }])).status).toBe(201);
    process.env.MPESA_MODE = 'simulator';
  });
});
