/**
 * Test environment. Uses TEST_DATABASE_URL, or else the same server as DATABASE_URL in
 * .env with the database swapped for "pos_test". Never point this at the real POS
 * database: later stages truncate tables, so a name that does not end in _test is refused.
 */
import 'dotenv/config';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

/**
 * Tests EMPTY their database, so they may only ever run against a local one:
 *   1. TEST_DATABASE_URL, if set (your choice, name must end in _test);
 *   2. the same server as DATABASE_URL with database "pos_test", but only when that server is local;
 *   3. the local Docker database (POS_DB_PASSWORD from .env) on localhost:5433.
 * A remote DATABASE_URL (staging, Neon, production) is never used, so a production .env cannot
 * be pointed at by accident.
 */
function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  if (base) {
    const url = new URL(base);
    if (LOCAL_HOSTS.has(url.hostname)) {
      url.pathname = '/pos_test';
      return url.toString();
    }
  }
  if (process.env.POS_DB_PASSWORD) {
    return `postgres://pos:${encodeURIComponent(process.env.POS_DB_PASSWORD)}@localhost:5433/pos_test`;
  }
  throw new Error(
    'DATABASE_URL is not a local database, so the tests will not derive a test database from it. ' +
      'Set TEST_DATABASE_URL to a local throwaway database (its name must end in _test).',
  );
}

const url = testDatabaseUrl();
if (!/_test$/.test(new URL(url).pathname.slice(1))) {
  throw new Error('Refusing to run tests: the test database name must end in _test');
}

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = url;
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-0123456789abcdef0123456789';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-0123456789abcdef012345678';
process.env.BCRYPT_ROUNDS ??= '4';
process.env.CORS_ORIGINS ??= 'http://localhost:5173';

// Tests must never touch a real bucket: ignore any R2 settings from the developer's .env.
for (const key of ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL']) {
  process.env[key] = '';
}

// Never use the developer's real Daraja credentials (shared or per business) in tests.
for (const key of Object.keys(process.env)) {
  if (/^MPESA_(.+_)?(CONSUMER_KEY|CONSUMER_SECRET|SHORTCODE|PASSKEY|PARTY_B)$/.test(key)) process.env[key] = '';
}

// M-Pesa: prompts are off unless a test switches them on; the simulator answers quickly.
process.env.MPESA_MODE = 'off';
process.env.MPESA_SIM_DELAY_MS = '60';
process.env.MPESA_SIM_TIMEOUT_SECONDS = '2';

// Never let a developer's .env point migrations at a real database during tests.
process.env.MIGRATE_DATABASE_URL = '';
