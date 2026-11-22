import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/config/db';
import { ean13CheckDigit, internalBarcode, skuFor, skuPrefix } from '../src/utils/productCodes';
import { as, createBusiness, createUser, login, resetDb, type Session } from './helpers';

let admin: Session;
let other: Session;

beforeAll(async () => {
  await resetDb();
  const a = await createBusiness('go-fish', 'Go-fish');
  const b = await createBusiness('enyakin', 'Enyakin');
  await createUser('a@codes.test', [{ businessId: a, role: 'admin' }]);
  await createUser('b@codes.test', [{ businessId: b, role: 'admin' }]);
  admin = await login('a@codes.test', a);
  other = await login('b@codes.test', b);
});
afterAll(async () => closePool());

const create = (s: Session, name: string, extra: Record<string, unknown> = {}) =>
  as(s).post('/api/products').send({ name, priceCents: 10000, ...extra });

describe('product code helpers', () => {
  it('computes EAN-13 check digits', () => {
    expect(ean13CheckDigit('590123412345')).toBe(7); // 5901234123457
    expect(ean13CheckDigit('400638133393')).toBe(1); // 4006381333931
    const code = internalBarcode(1);
    expect(code).toHaveLength(13);
    expect(code.startsWith('29')).toBe(true);
    expect(ean13CheckDigit(code.slice(0, 12))).toBe(Number(code[12]));
  });
  it('builds a short SKU prefix from the business code', () => {
    expect(skuPrefix('go-fish')).toBe('GF');
    expect(skuPrefix('enyakin')).toBe('ENY');
    expect(skuFor('go-fish', 123)).toBe('GF-000123');
  });
});

describe('generated SKU and barcode', () => {
  it('gives every new product a unique SKU and barcode, counted per business', async () => {
    const a = await create(admin, 'One');
    const b = await create(admin, 'Two');
    const c = await create(other, 'Other business');
    expect(a.status).toBe(201);
    expect(a.body.sku).toBe('GF-000001');
    expect(b.body.sku).toBe('GF-000002');
    expect(c.body.sku).toBe('ENY-000001');
    expect(a.body.barcode).toMatch(/^29\d{11}$/);
    expect(a.body.barcode).not.toBe(b.body.barcode);
    expect(ean13CheckDigit(a.body.barcode.slice(0, 12))).toBe(Number(a.body.barcode[12]));
  });

  it('skips a number whose SKU is already taken', async () => {
    const taken = await create(admin, 'Manual', { sku: 'GF-000004' });
    expect(taken.body.sku).toBe('GF-000004');
    const next = await create(admin, 'Auto'); // would have been GF-000004
    expect(next.status).toBe(201);
    expect(next.body.sku).not.toBe('GF-000004');
  });

  it('cannot be edited afterwards', async () => {
    const p = await create(admin, 'Locked');
    const patch = await as(admin).patch(`/api/products/${p.body.id}`).send({ sku: 'HACKED', name: 'Locked 2' });
    expect(patch.status).toBe(422);
    const barcode = await as(admin).patch(`/api/products/${p.body.id}`).send({ barcode: '1234567890128' });
    expect(barcode.status).toBe(422);
    const ok = await as(admin).patch(`/api/products/${p.body.id}`).send({ name: 'Locked 2' });
    expect(ok.status).toBe(200);
    expect(ok.body.sku).toBe(p.body.sku);
    expect(ok.body.barcode).toBe(p.body.barcode);
  });

  it('finds a product by its generated barcode (what the till scanner sends)', async () => {
    const p = await create(admin, 'Scannable');
    const found = await as(admin).get(`/api/products?q=${p.body.barcode}`);
    expect(found.body.items.map((i: { id: string }) => i.id)).toContain(p.body.id);
  });
});
