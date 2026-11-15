/**
 * Creates the two businesses and the first admin. Safe to run again: existing rows are kept.
 *
 *   SEED_ADMIN_EMAIL=you@example.com SEED_ADMIN_PASSWORD='a long password' npm run seed
 *
 * The password is only used when the user does not exist yet. Change it after first login.
 */
import { query, closePool } from '../config/db';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../utils/password';

const BUSINESSES = [
  { code: 'go-fish', name: 'Go-fish' },
  { code: 'enyakin', name: 'Enyakin Enterprises' },
];

async function main(): Promise<void> {
  const email = process.env.SEED_ADMIN_EMAIL?.trim();
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME?.trim() || 'Administrator';
  if (!email || !password) {
    throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD');
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`SEED_ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters`);
  }

  const businessIds: string[] = [];
  for (const b of BUSINESSES) {
    const [row] = await query<{ id: string }>(
      `INSERT INTO businesses (code, name) VALUES ($1, $2)
       ON CONFLICT (code) DO UPDATE SET code = EXCLUDED.code RETURNING id`,
      [b.code, b.name],
    );
    businessIds.push(row!.id);
  }

  const [user] = await query<{ id: string }>(
    `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3)
     ON CONFLICT (lower(email)) DO UPDATE SET email = users.email RETURNING id`,
    [email, name, await hashPassword(password)],
  );
  for (const businessId of businessIds) {
    await query(
      `INSERT INTO user_businesses (user_id, business_id, role) VALUES ($1, $2, 'admin')
       ON CONFLICT DO NOTHING`,
      [user!.id, businessId],
    );
  }
  console.log(`Businesses: ${BUSINESSES.map((b) => b.name).join(', ')}`);
  console.log(`Admin: ${email} (admin in both businesses)`);
}

main()
  .catch((err: Error) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => closePool());
