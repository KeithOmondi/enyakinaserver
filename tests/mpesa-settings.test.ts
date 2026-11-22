import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, pool } from '../src/config/db';
import { decryptSecret, encryptSecret } from '../src/utils/secretbox';
import { as, createBusiness, createUser, login, resetDb, type Session } from './helpers';

const PASSWORD = 'correct-horse-1';
const PASSKEY = 'bfb279f9aa9bdbcf158e97dd71a467cd2e0c893059b10f78e6b72ada1ed2c919';
const SECRET = 'consumer-secret-0123456789abcdef';

let admin: Session;
let manager: Session;
let other: Session;
let bizA: string;

beforeAll(async () => {
  process.env.MPESA_MODE = 'daraja';
  await resetDb();
  bizA = await createBusiness('fish-x', 'Fish X');
  const bizB = await createBusiness('shirts-x', 'Shirts X');
  await createUser('admin@a.test', [{ businessId: bizA, role: 'admin' }]);
  await createUser('mgr@a.test', [{ businessId: bizA, role: 'shop_manager' }]);
  await createUser('admin@b.test', [{ businessId: bizB, role: 'admin' }]);
  admin = await login('admin@a.test', bizA);
  manager = await login('mgr@a.test', bizA);
  other = await login('admin@b.test', bizB);
});
afterAll(async () => {
  process.env.MPESA_MODE = 'off';
  await closePool();
});

const body = (over: Record<string, unknown> = {}) => ({
  enabled: true, transactionType: 'paybill', shortcode: '600111', passkey: PASSKEY,
  consumerKey: 'consumer-key-0123456789abcdef', consumerSecret: SECRET, password: PASSWORD, ...over,
});
const mode = async (s: Session) => (await as(s).get('/api/businesses/current')).body.mpesaMode;

describe('secret box', () => {
  it('round-trips and never repeats a ciphertext', () => {
    const a = encryptSecret('hello');
    const b = encryptSecret('hello');
    expect(a).not.toBe(b);
    expect(a).not.toContain('hello');
    expect(decryptSecret(a)).toBe('hello');
    const tampered = a.slice(0, -2) + (a.endsWith('AA') ? 'BB' : 'AA');
    expect(() => decryptSecret(tampered)).toThrow();
  });
});

describe('M-Pesa settings in the dashboard', () => {
  it('starts with nothing set up and prompts off', async () => {
    const res = await as(admin).get('/api/payments/mpesa/settings');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'none', configured: false, serverMode: 'daraja', encryptionReady: true });
    expect(await mode(admin)).toBe('off');
  });

  it('only admins can see or change them', async () => {
    expect((await as(manager).get('/api/payments/mpesa/settings')).status).toBe(403);
    expect((await as(manager).put('/api/payments/mpesa/settings').send(body())).status).toBe(403);
  });

  it('refuses a wrong password, and a first save without the passkey', async () => {
    const bad = await as(admin).put('/api/payments/mpesa/settings').send(body({ password: 'nope-nope-nope' }));
    expect(bad.status).toBe(422);
    const noKey = await as(admin).put('/api/payments/mpesa/settings').send(body({ passkey: undefined }));
    expect(noKey.status).toBe(422);
    expect((await as(admin).get('/api/payments/mpesa/settings')).body.configured).toBe(false);
  });

  it('saves encrypted, never returns the secrets, and switches prompts on for that business only', async () => {
    const res = await as(admin).put('/api/payments/mpesa/settings').send(body());
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: 'dashboard', configured: true, enabled: true, shortcode: '600111', transactionType: 'paybill', passkeyHint: '••••c919' });
    const text = JSON.stringify(res.body);
    expect(text).not.toContain(PASSKEY);
    expect(text).not.toContain(SECRET);

    // At rest: encrypted, not plain.
    const { rows } = await pool.query('SELECT passkey_enc, consumer_secret_enc FROM mpesa_settings WHERE business_id = $1', [bizA]);
    expect(rows[0].passkey_enc).not.toContain(PASSKEY);
    expect(rows[0].consumer_secret_enc).not.toContain(SECRET);
    expect(decryptSecret(rows[0].passkey_enc)).toBe(PASSKEY);

    // Prompts on for this business, still off for the other one (it has no Till of its own).
    expect(await mode(admin)).toBe('daraja');
    expect(await mode(other)).toBe('off');
    // The other business cannot read this business's settings.
    expect((await as(other).get('/api/payments/mpesa/settings')).body.configured).toBe(false);
  });

  it('keeps the saved secrets when they are left blank on a later save', async () => {
    const res = await as(admin).put('/api/payments/mpesa/settings').send(body({ passkey: undefined, consumerKey: undefined, consumerSecret: undefined, enabled: false }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, passkeyHint: '••••c919' });
    expect(await mode(admin)).toBe('off');
    await as(admin).put('/api/payments/mpesa/settings').send(body({ passkey: undefined, consumerKey: undefined, consumerSecret: undefined }));
    expect(await mode(admin)).toBe('daraja');
  });

  it('demands a new passkey when the shortcode changes', async () => {
    const res = await as(admin).put('/api/payments/mpesa/settings').send(body({ shortcode: '600222', passkey: undefined, consumerKey: undefined, consumerSecret: undefined }));
    expect(res.status).toBe(422);
  });

  it('tests the key and secret with Safaricom without moving money', async () => {
    const spy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('{"access_token":"t","expires_in":"3599"}', { status: 200 }));
    const ok = await as(admin).post('/api/payments/mpesa/settings/test');
    expect(ok.body.ok).toBe(true);
    expect(String(spy.mock.calls[0]![0])).toContain('/oauth/v1/generate');
    spy.mockResolvedValue(new Response('{}', { status: 400 }));
    const bad = await as(admin).post('/api/payments/mpesa/settings/test');
    expect(bad.body.ok).toBe(false);
    spy.mockRestore();
  });

  it('records changes in the audit log without the secrets', async () => {
    const { rows } = await pool.query("SELECT details FROM audit_log WHERE action = 'mpesa_settings_updated' ORDER BY id");
    expect(rows.length).toBeGreaterThan(0);
    const all = JSON.stringify(rows);
    expect(all).not.toContain(PASSKEY);
    expect(all).not.toContain(SECRET);
    expect(all).toContain('passkey');
  });

  it('can be removed, which turns prompts back off', async () => {
    const wrong = await as(admin).post('/api/payments/mpesa/settings/remove').send({ password: 'nope-nope-nope' });
    expect(wrong.status).toBe(422);
    const res = await as(admin).post('/api/payments/mpesa/settings/remove').send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body.configured).toBe(false);
    expect(await mode(admin)).toBe('off');
  });
});
