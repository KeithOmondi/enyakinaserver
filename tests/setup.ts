/**
 * Test environment. Uses TEST_DATABASE_URL, or else the same server as DATABASE_URL in
 * .env with the database swapped for "pos_test". Never point this at the real POS
 * database: later stages truncate tables, so a name that does not end in _test is refused.
 */
import 'dotenv/config';

function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const base = process.env.DATABASE_URL;
  if (!base) throw new Error('Set TEST_DATABASE_URL (or DATABASE_URL in .env) to run tests');
  const url = new URL(base);
  url.pathname = '/pos_test';
  return url.toString();
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

// M-Pesa: prompts are off unless a test switches them on; the simulator answers quickly.
process.env.MPESA_MODE = 'off';
process.env.MPESA_SIM_DELAY_MS = '60';
process.env.MPESA_SIM_TIMEOUT_SECONDS = '2';
