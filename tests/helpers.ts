import request from 'supertest';
import { createApp } from '../src/app';
import { pool } from '../src/config/db';
import { migrateUp } from '../src/db/migrate';
import { hashPassword } from '../src/utils/password';

export const app = createApp();

/** Applies migrations to the test database and empties every app table. */
export async function resetDb(): Promise<void> {
  await migrateUp({ log: () => undefined });
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'schema_migrations'`,
  );
  if (rows.length) {
    await pool.query(`TRUNCATE ${rows.map((r) => `"${r.tablename}"`).join(', ')} RESTART IDENTITY CASCADE`);
  }
}

export async function createBusiness(code: string, name = code): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO businesses (code, name) VALUES ($1, $2) RETURNING id',
    [code, name],
  );
  return rows[0]!.id;
}

export async function createUser(
  email: string,
  memberships: { businessId: string; role: 'admin' | 'shop_manager' }[],
  password = 'correct-horse-1',
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [email, email.split('@')[0], await hashPassword(password)],
  );
  const id = rows[0]!.id;
  for (const m of memberships) {
    await pool.query('INSERT INTO user_businesses (user_id, business_id, role) VALUES ($1, $2, $3)', [id, m.businessId, m.role]);
  }
  return id;
}

export interface Session {
  accessToken: string;
  refreshToken: string;
  businessId: string;
}

export async function login(email: string, businessId: string, password = 'correct-horse-1'): Promise<Session> {
  const res = await request(app).post('/api/auth/login').send({ email, password });
  if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { accessToken: res.body.accessToken, refreshToken: res.body.refreshToken, businessId };
}

/** supertest request pre-authorised for one business. */
export const as = (s: Session) => ({
  get: (url: string) => request(app).get(url).set('Authorization', `Bearer ${s.accessToken}`).set('X-Business-Id', s.businessId),
  post: (url: string) => request(app).post(url).set('Authorization', `Bearer ${s.accessToken}`).set('X-Business-Id', s.businessId),
  patch: (url: string) => request(app).patch(url).set('Authorization', `Bearer ${s.accessToken}`).set('X-Business-Id', s.businessId),
  delete: (url: string) => request(app).delete(url).set('Authorization', `Bearer ${s.accessToken}`).set('X-Business-Id', s.businessId),
});

export async function createProduct(
  s: Session,
  over: Record<string, unknown> = {},
): Promise<{ id: string; quantity: number; priceCents: number }> {
  const res = await as(s)
    .post('/api/products')
    .send({ sku: `SKU-${Math.random().toString(36).slice(2, 8)}`, name: 'Tilapia', priceCents: 35000, costCents: 20000, openingStock: 10, ...over });
  if (res.status !== 201) throw new Error(`createProduct failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
}
