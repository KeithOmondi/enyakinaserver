import { Pool, types, type PoolClient, type QueryResultRow } from 'pg';
import { env } from './env';

/**
 * Type parsing decisions (made once, here):
 *
 * - INT8 / BIGINT (OID 20): money columns are BIGINT in cents and so are COUNT(*) results.
 *   Parsed to JS number. Safe up to Number.MAX_SAFE_INTEGER (~90 trillion KES in cents).
 *   We guard against overflow rather than silently losing precision.
 * - NUMERIC (OID 1700): quantities are NUMERIC(12,3) (max 999,999,999.999) which fits a
 *   double exactly enough for 3 decimal places. Parsed to JS number for API convenience.
 *   All stock arithmetic is still done in SQL, never in JS.
 * - DATE (OID 1082): kept as 'YYYY-MM-DD' string so it is never shifted by a timezone.
 */
types.setTypeParser(20, (val) => {
  const n = Number(val);
  if (!Number.isSafeInteger(n)) {
    throw new Error(`BIGINT value ${val} exceeds JS safe integer range`);
  }
  return n;
});
types.setTypeParser(1700, (val) => Number(val));
types.setTypeParser(1082, (val) => val);

export const pool = new Pool({
  connectionString: env.DATABASE_URL,
  max: env.DB_POOL_MAX,
  ssl: env.DB_SSL ? { rejectUnauthorized: true } : undefined,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  application_name: 'pos-api',
  // Every session stores and compares timestamps in UTC; reports convert to
  // BUSINESS_TIMEZONE explicitly in SQL. The timeouts stop a stuck query or an
  // abandoned transaction from holding row locks (and so blocking sales) forever.
  options:
    '-c timezone=UTC -c statement_timeout=30000 -c idle_in_transaction_session_timeout=60000',
});

pool.on('error', (err) => {
  // An idle client errored (e.g. DB restarted). Log; the pool will replace it.
  console.error('[db] idle client error', err.message);
});

/**
 * Anything that can run a query: the pool itself or a transaction client.
 * Repo functions accept this so they work both standalone and inside withTransaction.
 */
export type Queryable = Pick<Pool | PoolClient, 'query'>;

const camel = (k: string) => k.replace(/_([a-z0-9])/g, (_m, c: string) => c.toUpperCase());

/**
 * Runs a query and returns rows with camelCase keys (price_cents -> priceCents), so SQL
 * stays snake_case and the whole API speaks camelCase without per-module mapping.
 * Only top-level column names are converted; JSON column contents are left as stored.
 */
export async function query<T extends QueryResultRow = QueryResultRow>(
  text: string,
  params: unknown[] = [],
  db: Queryable = pool,
): Promise<T[]> {
  const result = await db.query(text, params);
  return result.rows.map((row) => {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(row)) out[camel(key)] = row[key];
    return out as T;
  });
}

export async function checkDbConnection(): Promise<void> {
  await pool.query('SELECT 1');
}

export async function closePool(): Promise<void> {
  await pool.end();
}
