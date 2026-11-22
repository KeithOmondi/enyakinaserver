import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool } from '../src/config/db';
import { as, createBusiness, createProduct, createUser, login, resetDb, type Session } from './helpers';

let admin: Session;
let other: Session;

beforeAll(async () => {
  await resetDb();
  const a = await createBusiness('sub-a', 'A');
  const b = await createBusiness('sub-b', 'B');
  await createUser('a@sub.test', [{ businessId: a, role: 'admin' }]);
  await createUser('b@sub.test', [{ businessId: b, role: 'admin' }]);
  admin = await login('a@sub.test', a);
  other = await login('b@sub.test', b);
});
afterAll(async () => closePool());

const cat = (s: Session, name: string, parentId?: string | null) =>
  as(s).post('/api/categories').send({ name, ...(parentId !== undefined ? { parentId } : {}) });

describe('sub-categories', () => {
  it('lets the same sub-category name exist under different parents', async () => {
    const adults = (await cat(admin, 'Adults')).body;
    const kids = (await cat(admin, 'Kids')).body;
    const a = await cat(admin, 'T-shirts', adults.id);
    const k = await cat(admin, 'T-shirts', kids.id);
    expect(a.status).toBe(201);
    expect(k.status).toBe(201);
    expect(a.body).toMatchObject({ name: 'T-shirts', parentId: adults.id, parentName: 'Adults' });
    // ...but not twice under the same parent, nor a top-level duplicate.
    expect((await cat(admin, 'T-shirts', adults.id)).status).toBeGreaterThanOrEqual(400);
    expect((await cat(admin, 'adults')).status).toBeGreaterThanOrEqual(400);
  });

  it('keeps it to one level and inside the same business', async () => {
    const top = (await cat(admin, 'Home')).body;
    const sub = (await cat(admin, 'Carpets', top.id)).body;
    const deeper = await cat(admin, 'Large', sub.id);
    expect(deeper.status).toBe(422);
    const foreign = await cat(other, 'Spy', top.id);
    expect(foreign.status).toBe(422);
    const self = await as(admin).patch(`/api/categories/${top.id}`).send({ parentId: top.id });
    expect(self.status).toBe(422);
    // A category that has sub-categories cannot be moved inside another one.
    const other2 = (await cat(admin, 'Garden')).body;
    const move = await as(admin).patch(`/api/categories/${top.id}`).send({ parentId: other2.id });
    expect(move.status).toBe(422);
  });

  it('puts a product in a sub-category, shows both names, and filters by either level', async () => {
    const adults = (await cat(admin, 'Men')).body;
    const tees = (await cat(admin, 'Tees', adults.id)).body;
    const shorts = (await cat(admin, 'Shorts', adults.id)).body;
    const p = await createProduct(admin, { name: 'Plain Tee', categoryId: tees.id });
    await createProduct(admin, { name: 'Board Shorts', categoryId: shorts.id });
    expect(p.categoryName).toBe('Tees');
    expect(p.parentCategoryName).toBe('Men');

    const names = async (q: string) => (await as(admin).get(`/api/products?${q}`)).body.items.map((i: { name: string }) => i.name).sort();
    expect(await names(`categoryId=${tees.id}`)).toEqual(['Plain Tee']);
    expect(await names(`categoryId=${adults.id}`)).toEqual(['Board Shorts', 'Plain Tee']); // the parent includes its children

    const list = (await as(admin).get('/api/categories')).body.items;
    const men = list.find((c: { id: string }) => c.id === adults.id);
    expect(men).toMatchObject({ productCount: 2, childCount: 2 });
    expect(list.find((c: { id: string }) => c.id === tees.id)).toMatchObject({ productCount: 1, parentName: 'Men' });
  });

  it('will not delete a category that has sub-categories, and deactivating it deactivates them', async () => {
    const top = (await cat(admin, 'Seasonal')).body;
    const sub = (await cat(admin, 'Summer', top.id)).body;
    expect((await as(admin).delete(`/api/categories/${top.id}`)).status).toBe(409);
    await as(admin).patch(`/api/categories/${top.id}`).send({ active: false });
    const list = (await as(admin).get('/api/categories?includeInactive=true')).body.items;
    expect(list.find((c: { id: string }) => c.id === sub.id).active).toBe(false);
  });
});
