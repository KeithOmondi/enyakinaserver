import { query, type Queryable } from '../../config/db';
import { env } from '../../config/env';
import { withTransaction } from '../../db/transaction';
import { audit } from '../../services/audit';
import { AppError } from '../../utils/AppError';
import { DUMMY_HASH, hashPassword, verifyPassword } from '../../utils/password';
import { hashRefreshToken, newRefreshToken, signAccessToken } from '../../utils/tokens';

interface UserRow {
  id: string;
  email: string;
  name: string;
  passwordHash: string;
  isSuperAdmin: boolean;
  active: boolean;
}

export interface Tokens {
  accessToken: string;
  refreshToken: string;
}

export interface BusinessAccess {
  id: string;
  code: string;
  name: string;
  role: 'super_admin' | 'admin' | 'shop_manager';
}

/** A refresh token reused this soon after rotation is a second tab, not a thief. */
const REUSE_GRACE_MS = 10_000;

async function issueTokens(user: UserRow, db?: Queryable): Promise<Tokens> {
  const { token, hash } = newRefreshToken();
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [user.id, hash, env.JWT_REFRESH_TTL_DAYS],
    db,
  );
  return {
    accessToken: signAccessToken({
      sub: user.id,
      email: user.email,
      name: user.name,
      sa: user.isSuperAdmin,
    }),
    refreshToken: token,
  };
}

export async function businessesFor(
  userId: string,
  isSuperAdmin: boolean,
): Promise<BusinessAccess[]> {
  if (isSuperAdmin && env.ENABLE_SUPER_ADMIN) {
    return query<BusinessAccess>(
      `SELECT id, code, name, 'super_admin' AS role FROM businesses WHERE active ORDER BY name`,
    );
  }
  return query<BusinessAccess>(
    `SELECT b.id, b.code, b.name, ub.role
       FROM user_businesses ub JOIN businesses b ON b.id = ub.business_id
      WHERE ub.user_id = $1 AND b.active ORDER BY b.name`,
    [userId],
  );
}

function publicUser(u: UserRow) {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    isSuperAdmin: u.isSuperAdmin && env.ENABLE_SUPER_ADMIN,
  };
}

export async function login(email: string, password: string, ip: string | undefined) {
  const [user] = await query<UserRow>(
    `SELECT id, email, name, password_hash, is_super_admin, active
       FROM users WHERE lower(email) = lower($1)`,
    [email],
  );
  // Always run one bcrypt comparison so an unknown email costs the same as a wrong password.
  const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !user.active || !ok) {
    await audit({ action: 'login_failed', entity: 'user', details: { email }, ip });
    throw AppError.unauthorized('Invalid email or password');
  }
  const businesses = await businessesFor(user.id, user.isSuperAdmin);
  if (businesses.length === 0) {
    throw AppError.forbidden('Your account is not assigned to any business');
  }
  const tokens = await issueTokens(user);
  await audit({ userId: user.id, action: 'login', entity: 'user', entityId: user.id, ip });
  return { ...tokens, user: publicUser(user), businesses };
}

export async function refresh(presented: string): Promise<Tokens> {
  const hash = hashRefreshToken(presented);
  // The transaction must COMMIT the revoke-everything step, so reuse is reported by
  // returning a marker; throwing inside would roll the revocation back.
  const result = await withTransaction<Tokens | 'reused'>(async (tx) => {
    const [row] = await query<{
      id: string;
      userId: string;
      expired: boolean;
      revokedAt: Date | null;
    }>(
      `SELECT id, user_id, expires_at < now() AS expired, revoked_at
         FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`,
      [hash],
      tx,
    );
    if (!row) throw AppError.unauthorized('Invalid session');

    if (row.revokedAt) {
      // A rotated token came back. Outside the grace window assume theft and end every session.
      if (Date.now() - row.revokedAt.getTime() > REUSE_GRACE_MS) {
        await query(
          'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
          [row.userId],
          tx,
        );
        await audit({ userId: row.userId, action: 'refresh_reuse_detected', entity: 'user' }, tx);
        return 'reused';
      }
      throw AppError.unauthorized('Invalid session');
    }
    if (row.expired) throw AppError.unauthorized('Session expired');

    const [user] = await query<UserRow>(
      'SELECT id, email, name, password_hash, is_super_admin, active FROM users WHERE id = $1',
      [row.userId],
      tx,
    );
    if (!user?.active) throw AppError.unauthorized('Account disabled');

    await query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [row.id], tx);
    return issueTokens(user, tx);
  });
  if (result === 'reused') throw AppError.unauthorized('Invalid session');
  return result;
}

export async function logout(presented: string): Promise<void> {
  await query(
    'UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND revoked_at IS NULL',
    [hashRefreshToken(presented)],
  );
}

export async function me(userId: string) {
  const [user] = await query<UserRow>(
    `SELECT id, email, name, password_hash, is_super_admin, active FROM users WHERE id = $1`,
    [userId],
  );
  if (!user?.active) throw AppError.unauthorized('Account disabled');
  return {
    user: publicUser(user),
    businesses: await businessesFor(user.id, user.isSuperAdmin),
    timezone: env.BUSINESS_TIMEZONE,
  };
}

export async function changePassword(userId: string, current: string, next: string, ip?: string) {
  const [user] = await query<UserRow>(
    'SELECT id, email, name, password_hash, is_super_admin, active FROM users WHERE id = $1',
    [userId],
  );
  if (!user || !(await verifyPassword(current, user.passwordHash))) {
    throw AppError.badRequest('Current password is incorrect');
  }
  const newHash = await hashPassword(next);
  await withTransaction(async (tx) => {
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, newHash], tx);
    // Ends every session on every device; the caller signs in again.
    await query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
      tx,
    );
    await audit({ userId, action: 'password_changed', entity: 'user', entityId: userId, ip }, tx);
  });
}
