import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { closePool } from '../src/config/db';
import { app, as, createBusiness, createProduct, createUser, login, resetDb, type Session } from './helpers';

// An in-memory stand-in for Cloudflare R2: what is "uploaded" lives in this map.
const store = vi.hoisted(() => ({ objects: new Map<string, { size: number; type: string }>(), configured: true, failPut: false }));
vi.mock('../src/services/storage', () => ({
  storageConfigured: () => store.configured,
  putObject: async (key: string, body: Buffer, type: string) => {
    if (store.failPut) throw new Error('InvalidBucketName');
    store.objects.set(key, { size: body.length, type });
  },
  deleteObject: async (key: string) => void store.objects.delete(key),
  publicUrl: (key: string | null) => (key ? `https://img.test/${key}` : null),
}));

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(32)]);

let admin: Session;
let manager: Session;
let other: Session;

beforeAll(async () => {
  await resetDb();
  const a = await createBusiness('img-a');
  const b = await createBusiness('img-b');
  await createUser('admin@img-a.test', [{ businessId: a, role: 'admin' }]);
  await createUser('mgr@img-a.test', [{ businessId: a, role: 'shop_manager' }]);
  await createUser('admin@img-b.test', [{ businessId: b, role: 'admin' }]);
  admin = await login('admin@img-a.test', a);
  manager = await login('mgr@img-a.test', a);
  other = await login('admin@img-b.test', b);
});
beforeEach(() => {
  store.objects.clear();
  store.configured = true;
  store.failPut = false;
});
afterAll(async () => {
  await closePool();
});

const upload = (s: Session, id: string, body: Buffer, type: string) =>
  request(app).put(`/api/products/${id}/image`).set('Authorization', `Bearer ${s.accessToken}`).set('X-Business-Id', s.businessId).set('Content-Type', type).send(body);

describe('product photos', () => {
  it('stores a valid image under the business folder and returns its public URL', async () => {
    const p = await createProduct(admin);
    const res = await upload(admin, p.id, PNG, 'image/png');
    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toMatch(new RegExp(`^https://img.test/businesses/${admin.businessId}/products/${p.id}/.+\\.png$`));
    expect(store.objects.size).toBe(1);
    // The URL shows up in listings too (the till and admin read from there).
    const list = await as(admin).get(`/api/products?q=Tilapia`);
    expect(list.body.items.find((i: { id: string }) => i.id === p.id).imageUrl).toBe(res.body.imageUrl);
  });

  it('replaces the previous photo and deletes the old object', async () => {
    const p = await createProduct(admin);
    const first = await upload(admin, p.id, PNG, 'image/png');
    const second = await upload(admin, p.id, JPEG, 'image/jpeg');
    expect(second.body.imageUrl).not.toBe(first.body.imageUrl);
    expect(store.objects.size).toBe(1);
    expect([...store.objects.keys()][0]).toMatch(/\.jpg$/);
  });

  it('accepts WebP, the format the browser produces', async () => {
    const p = await createProduct(admin);
    expect((await upload(admin, p.id, WEBP, 'image/webp')).status).toBe(200);
  });

  it('removes a photo', async () => {
    const p = await createProduct(admin);
    await upload(admin, p.id, PNG, 'image/png');
    const res = await as(admin).delete(`/api/products/${p.id}/image`);
    expect(res.status).toBe(200);
    expect(res.body.imageUrl).toBeNull();
    expect(store.objects.size).toBe(0);
  });

  it('rejects files whose bytes are not the declared image type', async () => {
    const p = await createProduct(admin);
    const fake = await upload(admin, p.id, Buffer.from('<script>alert(1)</script>'), 'image/png');
    expect(fake.status).toBe(415);
    const mismatch = await upload(admin, p.id, JPEG, 'image/png');
    expect(mismatch.status).toBe(415);
    expect((await upload(admin, p.id, Buffer.from('hello'), 'text/plain')).status).toBe(415);
    expect(store.objects.size).toBe(0);
  });

  it('rejects files over 2 MB', async () => {
    const p = await createProduct(admin);
    const big = Buffer.concat([PNG, Buffer.alloc(2 * 1024 * 1024)]);
    expect((await upload(admin, p.id, big, 'image/png')).status).toBe(413);
  });

  it('is admin-only and cannot touch another business\'s product', async () => {
    const p = await createProduct(admin);
    expect((await upload(manager, p.id, PNG, 'image/png')).status).toBe(403);
    expect((await upload(other, p.id, PNG, 'image/png')).status).toBe(404);
    expect(store.objects.size).toBe(0);
  });

  it('reports a storage failure as a clear 502 instead of a mystery 500', async () => {
    const p = await createProduct(admin);
    store.failPut = true;
    const res = await upload(admin, p.id, PNG, 'image/png');
    expect(res.status).toBe(502);
    expect(res.body.error.message).toMatch(/R2 settings/);
  });

  it('explains clearly when storage is not configured, and products still work', async () => {
    store.configured = false;
    const p = await createProduct(admin);
    const res = await upload(admin, p.id, PNG, 'image/png');
    expect(res.status).toBe(503);
    expect(res.body.error.message).toMatch(/not configured/);
    expect((await as(admin).get(`/api/products/${p.id}`)).status).toBe(200);
  });
});
