import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, pool } from '../src/config/db';
import { businessToday } from '../src/utils/dates';
import { app, as, createBusiness, createProduct, createUser, login, resetDb, type Session } from './helpers';

let bizA: string;
let bizB: string;
let admin: Session;
let manager: Session;
let adminB: Session;

beforeAll(async () => {
  await resetDb();
  bizA = await createBusiness('biz-a', 'Biz A');
  bizB = await createBusiness('biz-b', 'Biz B');
  await createUser('admin@a.test', [{ businessId: bizA, role: 'admin' }]);
  await createUser('mgr@a.test', [{ businessId: bizA, role: 'shop_manager' }]);
  await createUser('admin@b.test', [{ businessId: bizB, role: 'admin' }]);
  admin = await login('admin@a.test', bizA);
  manager = await login('mgr@a.test', bizA);
  adminB = await login('admin@b.test', bizB);
});

afterAll(async () => {
  await closePool();
});

const stockOf = async (id: string) =>
  Number((await pool.query('SELECT quantity FROM stock_levels WHERE product_id = $1', [id])).rows[0].quantity);

const sell = (s: Session, items: unknown[], payments: unknown[], key: string = randomUUID(), extra: object = {}) =>
  as(s).post('/api/sales').set('Idempotency-Key', key).send({ items, payments, ...extra });

describe('auth', () => {
  it('rejects a wrong password and an unknown email the same way', async () => {
    const a = await request(app).post('/api/auth/login').send({ email: 'admin@a.test', password: 'nope' });
    const b = await request(app).post('/api/auth/login').send({ email: 'ghost@a.test', password: 'nope' });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
    expect(a.body.error.message).toBe(b.body.error.message);
  });

  it('returns profile and businesses from /auth/me', async () => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${admin.accessToken}`);
    expect(res.status).toBe(200);
    expect(res.body.user.email).toBe('admin@a.test');
    expect(res.body.businesses).toEqual([expect.objectContaining({ id: bizA, role: 'admin' })]);
  });

  it('rotates refresh tokens and treats an old one as reuse', async () => {
    const first = await login('admin@a.test', bizA);
    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(first.refreshToken);

    // Pretend the rotation happened a while ago, then replay the old token (theft).
    await pool.query(`UPDATE refresh_tokens SET revoked_at = now() - interval '1 minute' WHERE revoked_at IS NOT NULL`);
    const replay = await request(app).post('/api/auth/refresh').send({ refreshToken: first.refreshToken });
    expect(replay.status).toBe(401);
    // ...which also kills the legitimately rotated token.
    const after = await request(app).post('/api/auth/refresh').send({ refreshToken: r1.body.refreshToken });
    expect(after.status).toBe(401);
  });

  it('rejects requests without a token or with a tampered one', async () => {
    expect((await request(app).get('/api/products')).status).toBe(401);
    const res = await request(app).get('/api/products').set('Authorization', 'Bearer abc.def.ghi').set('X-Business-Id', bizA);
    expect(res.status).toBe(401);
  });
});

describe('tenancy and roles', () => {
  it('requires X-Business-Id and refuses a business the user does not belong to', async () => {
    const noHeader = await request(app).get('/api/products').set('Authorization', `Bearer ${admin.accessToken}`);
    expect(noHeader.status).toBe(400);
    const wrong = await request(app).get('/api/products').set('Authorization', `Bearer ${admin.accessToken}`).set('X-Business-Id', bizB);
    expect(wrong.status).toBe(403);
  });

  it('never shows one business the other business\'s data', async () => {
    const p = await createProduct(admin, { name: 'Only in A' });
    const list = await as(adminB).get('/api/products');
    expect(list.body.items.map((i: { id: string }) => i.id)).not.toContain(p.id);
    expect((await as(adminB).get(`/api/products/${p.id}`)).status).toBe(404);
  });

  it('keeps management actions admin-only', async () => {
    const res = await as(manager).post('/api/products').send({ sku: 'X1', name: 'X', priceCents: 100 });
    expect(res.status).toBe(403);
    expect((await as(manager).get('/api/users')).status).toBe(403);
    expect((await as(manager).get('/api/reports/summary?from=2026-01-01&to=2026-01-02')).status).toBe(403);
  });
});

describe('products', () => {
  it('creates with opening stock and a ledger entry, and reports duplicates clearly', async () => {
    const p = await createProduct(admin, { sku: 'DUP-1', openingStock: 5 });
    expect(p.quantity).toBe(5);
    const moves = await as(admin).get(`/api/inventory/movements?productId=${p.id}`);
    expect(moves.body.items[0]).toMatchObject({ type: 'opening', quantity: 5, balanceAfter: 5 });

    const dup = await as(admin).post('/api/products').send({ sku: 'dup-1', name: 'Again', priceCents: 100 });
    expect(dup.status).toBe(409);
    expect(dup.body.error.message).toBe('Another product already uses this SKU');
  });

  it('rejects money that is not whole cents', async () => {
    const res = await as(admin).post('/api/products').send({ sku: 'F1', name: 'Float', priceCents: 10.5 });
    expect(res.status).toBe(422);
  });

  it('searches by name and filters low stock', async () => {
    await createProduct(admin, { sku: 'LOW-1', name: 'Rare Perch', openingStock: 2, reorderLevel: 5 });
    const found = await as(admin).get('/api/products?q=rare');
    expect(found.body.items).toHaveLength(1);
    const low = await as(admin).get('/api/products?lowStock=true');
    expect(low.body.items.map((i: { sku: string }) => i.sku)).toContain('LOW-1');
  });
});

describe('checkout', () => {
  it('prices from the database, takes stock, and computes change', async () => {
    const p = await createProduct(admin, { name: 'Sold Fish', priceCents: 35000, openingStock: 10 });
    const res = await sell(admin, [{ productId: p.id, quantity: 2 }], [{ method: 'cash', amountCents: 100000 }]);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ subtotalCents: 70000, totalCents: 70000, paidCents: 100000, changeCents: 30000, receiptNo: expect.any(Number) });
    // Stored payments are net of change so they add up to the total.
    expect(res.body.payments).toEqual([expect.objectContaining({ method: 'cash', amountCents: 70000 })]);
    expect(await stockOf(p.id)).toBe(8);
  });

  it('handles fractional quantities and split payments', async () => {
    const p = await createProduct(admin, { name: 'Loose Fish', priceCents: 80000, allowsFraction: true, unit: 'kg', openingStock: 10 });
    const res = await sell(admin, [{ productId: p.id, quantity: 1.25 }], [
      { method: 'mpesa', amountCents: 60000, reference: 'QWE123' },
      { method: 'cash', amountCents: 40000 },
    ]);
    expect(res.status).toBe(201);
    expect(res.body.totalCents).toBe(100000);
    expect(await stockOf(p.id)).toBe(8.75);
  });

  it('numbers receipts without gaps', async () => {
    const p = await createProduct(admin, { openingStock: 10 });
    const a = await sell(admin, [{ productId: p.id, quantity: 1 }], [{ method: 'cash', amountCents: 35000 }]);
    const b = await sell(admin, [{ productId: p.id, quantity: 1 }], [{ method: 'cash', amountCents: 35000 }]);
    expect(b.body.receiptNo).toBe(a.body.receiptNo + 1);
  });

  it('replays a repeated Idempotency-Key instead of selling twice', async () => {
    const p = await createProduct(admin, { openingStock: 10 });
    const key = randomUUID();
    const body = [{ productId: p.id, quantity: 3 }];
    const pay = [{ method: 'cash', amountCents: 105000 }];
    const first = await sell(admin, body, pay, key);
    const again = await sell(admin, body, pay, key);
    expect(first.status).toBe(201);
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    expect(await stockOf(p.id)).toBe(7);
  });

  it('refuses to oversell and records nothing', async () => {
    const p = await createProduct(admin, { openingStock: 2 });
    const before = (await pool.query('SELECT count(*)::int AS n FROM sales')).rows[0].n;
    const res = await sell(admin, [{ productId: p.id, quantity: 3 }], [{ method: 'cash', amountCents: 200000 }]);
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('INSUFFICIENT_STOCK');
    expect(await stockOf(p.id)).toBe(2);
    expect((await pool.query('SELECT count(*)::int AS n FROM sales')).rows[0].n).toBe(before);
  });

  it('lets exactly one of two simultaneous sales take the last unit', async () => {
    const p = await createProduct(admin, { openingStock: 1 });
    const results = await Promise.all([
      sell(admin, [{ productId: p.id, quantity: 1 }], [{ method: 'cash', amountCents: 35000 }]),
      sell(manager, [{ productId: p.id, quantity: 1 }], [{ method: 'cash', amountCents: 35000 }]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await stockOf(p.id)).toBe(0);
  });

  it('validates payments, discount and the idempotency header', async () => {
    const p = await createProduct(admin, { openingStock: 10 });
    const item = [{ productId: p.id, quantity: 1 }];
    expect((await sell(admin, item, [{ method: 'cash', amountCents: 1000 }])).status).toBe(422); // short
    expect((await sell(admin, item, [{ method: 'mpesa', amountCents: 50000 }])).status).toBe(422); // change from mpesa
    expect((await sell(admin, item, [{ method: 'cash', amountCents: 35000 }], randomUUID(), { discountCents: 99999 })).status).toBe(422);
    const noKey = await as(admin).post('/api/sales').send({ items: item, payments: [{ method: 'cash', amountCents: 35000 }] });
    expect(noKey.status).toBe(400);
  });

  it('cannot sell another business\'s product', async () => {
    const other = await createProduct(adminB, { openingStock: 5 });
    const res = await sell(admin, [{ productId: other.id, quantity: 1 }], [{ method: 'cash', amountCents: 35000 }]);
    expect(res.status).toBe(422);
    expect(await stockOf(other.id)).toBe(5);
  });
});

describe('voids', () => {
  it('restores stock once, and only admins may void', async () => {
    const p = await createProduct(admin, { openingStock: 5 });
    const sale = await sell(manager, [{ productId: p.id, quantity: 2 }], [{ method: 'cash', amountCents: 70000 }]);
    expect(await stockOf(p.id)).toBe(3);

    expect((await as(manager).post(`/api/sales/${sale.body.id}/void`).send({ reason: 'mistake' })).status).toBe(403);
    const ok = await as(admin).post(`/api/sales/${sale.body.id}/void`).send({ reason: 'Customer returned' });
    expect(ok.status).toBe(200);
    expect(ok.body.status).toBe('voided');
    expect(await stockOf(p.id)).toBe(5);
    expect((await as(admin).post(`/api/sales/${sale.body.id}/void`).send({ reason: 'again' })).status).toBe(409);
    expect(await stockOf(p.id)).toBe(5);
  });
});

describe('purchases and adjustments', () => {
  it('receives stock, records cost, and is idempotent', async () => {
    const p = await createProduct(admin, { openingStock: 1, costCents: 1000 });
    const key = randomUUID();
    const body = { reference: 'INV-9', items: [{ productId: p.id, quantity: 4, unitCostCents: 2500 }] };
    const a = await as(manager).post('/api/purchases').set('Idempotency-Key', key).send(body);
    const b = await as(manager).post('/api/purchases').set('Idempotency-Key', key).send(body);
    expect(a.status).toBe(201);
    expect(a.body.totalCents).toBe(10000);
    expect(b.status).toBe(200);
    expect(await stockOf(p.id)).toBe(5);
    const prod = await as(admin).get(`/api/products/${p.id}`);
    expect(prod.body.costCents).toBe(2500);
  });

  it('sets stock to a counted number and logs the change', async () => {
    const p = await createProduct(admin, { openingStock: 10 });
    const res = await as(manager).post('/api/inventory/adjustments').send({ productId: p.id, mode: 'set', quantity: 7, reason: 'Stock take' });
    expect(res.status).toBe(201);
    expect(await stockOf(p.id)).toBe(7);
    const log = await as(admin).get('/api/audit?action=stock_adjusted');
    expect(log.body.items.length).toBeGreaterThan(0);
    // Can't remove more than exists.
    const bad = await as(manager).post('/api/inventory/adjustments').send({ productId: p.id, mode: 'delta', quantity: -50, reason: 'oops' });
    expect(bad.status).toBe(409);
    expect(await stockOf(p.id)).toBe(7);
  });
});

describe('closing and reports', () => {
  it('compares counted cash with sales and refuses a second close', async () => {
    await resetDb();
    bizA = await createBusiness('biz-a2', 'Biz A2');
    await createUser('c@a.test', [{ businessId: bizA, role: 'admin' }]);
    const s = await login('c@a.test', bizA);
    const p = await createProduct(s, { priceCents: 10000, costCents: 6000, openingStock: 20 });
    await sell(s, [{ productId: p.id, quantity: 2 }], [{ method: 'cash', amountCents: 20000 }]);
    await sell(s, [{ productId: p.id, quantity: 1 }], [{ method: 'mpesa', amountCents: 10000 }]);
    const voided = await sell(s, [{ productId: p.id, quantity: 1 }], [{ method: 'cash', amountCents: 10000 }]);
    await as(s).post(`/api/sales/${voided.body.id}/void`).send({ reason: 'test void' });

    const date = businessToday();
    const preview = await as(s).get(`/api/closings/preview?date=${date}`);
    expect(preview.body).toMatchObject({ salesCount: 2, totalCents: 30000, cashCents: 20000, mpesaCents: 10000, voidedCount: 1, expectedCashCents: 20000 });

    const close = await as(s).post('/api/closings').send({ date, countedCashCents: 19500 });
    expect(close.status).toBe(201);
    expect(close.body.varianceCents).toBe(-500);
    expect((await as(s).post('/api/closings').send({ date, countedCashCents: 20000 })).status).toBe(409);
    expect((await as(s).post('/api/closings').send({ date: '2999-01-01', countedCashCents: 0 })).status).toBe(400);

    const report = await as(s).get(`/api/reports/summary?from=${date}&to=${date}`);
    expect(report.body).toMatchObject({ salesCount: 2, voidedCount: 1, revenueCents: 30000, cogsCents: 18000, grossProfitCents: 12000 });
    expect(report.body.byPayment).toEqual([
      expect.objectContaining({ method: 'cash', amountCents: 20000 }),
      expect.objectContaining({ method: 'mpesa', amountCents: 10000 }),
    ]);
  });
});

describe('users', () => {
  it('adds a shop manager who can then sign in, and lets an admin reset their password', async () => {
    await resetDb();
    bizA = await createBusiness('biz-a3', 'Biz A3');
    await createUser('boss@a.test', [{ businessId: bizA, role: 'admin' }]);
    const boss = await login('boss@a.test', bizA);

    const created = await as(boss).post('/api/users').send({ email: 'new@a.test', name: 'New Person', password: 'first-pass-123', role: 'shop_manager' });
    expect(created.status).toBe(201);
    const them = await login('new@a.test', bizA, 'first-pass-123');
    expect((await as(them).get('/api/products')).status).toBe(200);

    expect((await as(boss).post(`/api/users/${created.body.id}/reset-password`).send({ newPassword: 'second-pass-456' })).status).toBe(204);
    // Their old session is gone and the old password no longer works.
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: them.refreshToken })).status).toBe(401);
    expect((await request(app).post('/api/auth/login').send({ email: 'new@a.test', password: 'first-pass-123' })).status).toBe(401);

    // Removed users lose access immediately, even with a valid token.
    expect((await as(boss).delete(`/api/users/${created.body.id}`)).status).toBe(204);
    expect((await as(them).get('/api/products')).status).toBe(403);
    // Admins cannot lock themselves out.
    const me = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${boss.accessToken}`);
    expect((await as(boss).delete(`/api/users/${me.body.user.id}`)).status).toBe(400);
  });
});
