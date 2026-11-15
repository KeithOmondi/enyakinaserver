import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { pool, closePool } from '../src/config/db';
import { migrateUp } from '../src/db/migrate';
import { withTransaction } from '../src/db/transaction';
import { lineTotal } from '../src/utils/money';

const app = createApp();
const silent = () => undefined;

afterAll(async () => {
  await closePool();
});

describe('app shell', () => {
  it('GET /api/health reports db up', async () => {
    const res = await request(app).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'ok', db: 'up' });
  });

  it('unknown route returns the standard error shape', async () => {
    const res = await request(app).get('/api/nope');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
  });

  it('malformed JSON returns 400, not 500', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json')
      .send('{bad json');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });

  it('rejects a disallowed CORS origin', async () => {
    const res = await request(app).get('/api/health').set('Origin', 'http://evil.example');
    expect(res.status).toBe(403);
  });

  it('marks API responses as non-cacheable', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('answers 415-class body errors as 4xx, not 500', async () => {
    const res = await request(app)
      .post('/api/health')
      .set('Content-Type', 'application/json; charset=utf-7')
      .send('{}');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('sets helmet security headers', async () => {
    const res = await request(app).get('/api/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('withTransaction', () => {
  beforeAll(async () => {
    await pool.query('CREATE TABLE IF NOT EXISTS _tx_probe (v int)');
    await pool.query('TRUNCATE _tx_probe');
  });
  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS _tx_probe');
  });

  it('commits on success', async () => {
    await withTransaction(async (c) => {
      await c.query('INSERT INTO _tx_probe VALUES (1)');
    });
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM _tx_probe');
    expect(rows[0].n).toBe(1);
  });

  it('rolls back everything on failure', async () => {
    await expect(
      withTransaction(async (c) => {
        await c.query('INSERT INTO _tx_probe VALUES (2)');
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM _tx_probe WHERE v = 2');
    expect(rows[0].n).toBe(0);
  });
});

describe('connection settings (managed poolers such as Neon reject startup parameters)', () => {
  it('sends no startup parameters when connecting', () => {
    const opts = pool.options as Record<string, unknown>;
    expect(opts.options).toBeUndefined(); // -c statement_timeout=... was rejected by Neon's pooler
    expect(opts.statement_timeout).toBeUndefined();
    expect(opts.idle_in_transaction_session_timeout).toBeUndefined();
  });

  it('still bounds every transaction with timeouts, without startup parameters', async () => {
    const outside = await pool.query('SHOW statement_timeout');
    expect(outside.rows[0].statement_timeout).toBe('0'); // not set session-wide
    const inside = await withTransaction(async (c) => {
      const a = await c.query('SHOW statement_timeout');
      const b = await c.query('SHOW idle_in_transaction_session_timeout');
      return [a.rows[0].statement_timeout, b.rows[0].idle_in_transaction_session_timeout];
    });
    expect(inside).toEqual(['30s', '1min']);
    // ...and the setting does not leak into later users of the same pooled connection.
    expect((await pool.query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('0');
  });
});

describe('migration runner', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'mig-'));
  const opts = { dir, table: '_schema_migrations_probe', log: silent };
  beforeAll(async () => {
    await pool.query('DROP TABLE IF EXISTS _mig_probe, _schema_migrations_probe');
  });
  afterAll(async () => {
    await pool.query('DROP TABLE IF EXISTS _mig_probe, _schema_migrations_probe');
    rmSync(dir, { recursive: true, force: true });
  });

  it('applies pending files once, in order, and is idempotent', async () => {
    writeFileSync(path.join(dir, '9001_probe_create.sql'), 'CREATE TABLE _mig_probe (v int);');
    writeFileSync(path.join(dir, '9002_probe_insert.sql'), 'INSERT INTO _mig_probe VALUES (42);');
    expect(await migrateUp(opts)).toEqual(['9001_probe_create.sql', '9002_probe_insert.sql']);
    expect(await migrateUp(opts)).toEqual([]);
    const { rows } = await pool.query('SELECT v FROM _mig_probe');
    expect(rows).toEqual([{ v: 42 }]);
  });

  it('refuses to run if an applied file was edited', async () => {
    writeFileSync(path.join(dir, '9002_probe_insert.sql'), 'INSERT INTO _mig_probe VALUES (43);');
    await expect(migrateUp(opts)).rejects.toThrow(/modified after it was applied/);
    writeFileSync(path.join(dir, '9002_probe_insert.sql'), 'INSERT INTO _mig_probe VALUES (42);');
  });

  it('rolls back a failing migration and does not record it', async () => {
    writeFileSync(
      path.join(dir, '9003_probe_bad.sql'),
      'INSERT INTO _mig_probe VALUES (7); SELECT * FROM no_such_table;',
    );
    await expect(migrateUp(opts)).rejects.toThrow(/9003_probe_bad.sql failed/);
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM _mig_probe WHERE v = 7');
    expect(rows[0].n).toBe(0);
    const rec = await pool.query("SELECT 1 FROM _schema_migrations_probe WHERE name = '9003_probe_bad.sql'");
    expect(rec.rowCount).toBe(0);
    rmSync(path.join(dir, '9003_probe_bad.sql'));
  });
});

describe('money', () => {
  it('computes fractional-quantity line totals in whole cents', () => {
    expect(lineTotal(80000, 1.25)).toBe(100000); // 1.25 kg @ KES 800/kg
    expect(lineTotal(33333, 0.5)).toBe(16667); // rounds half away from zero
    expect(lineTotal(19999, 3)).toBe(59997);
    expect(lineTotal(10000, -2)).toBe(-20000); // refunds
  });
});
