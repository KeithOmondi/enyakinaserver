import { query, type Queryable } from '../../config/db';
import { withTransaction } from '../../db/transaction';
import { audit, type AuditEntry } from '../../services/audit';
import { AppError } from '../../utils/AppError';
import { hashPassword } from '../../utils/password';

export type MemberRole = 'admin' | 'shop_manager';

export interface Member {
  id: string;
  email: string;
  name: string;
  role: MemberRole;
  active: boolean;
}

export function listMembers(businessId: string): Promise<Member[]> {
  return query<Member>(
    `SELECT u.id, u.email, u.name, ub.role, u.active
       FROM user_businesses ub JOIN users u ON u.id = ub.user_id
      WHERE ub.business_id = $1 ORDER BY u.name`,
    [businessId],
  );
}

async function getMember(businessId: string, userId: string): Promise<Member> {
  const [m] = await query<Member>(
    `SELECT u.id, u.email, u.name, ub.role, u.active
       FROM user_businesses ub JOIN users u ON u.id = ub.user_id
      WHERE ub.business_id = $1 AND u.id = $2`,
    [businessId, userId],
  );
  if (!m) throw AppError.notFound('User');
  return m;
}

export async function createMember(
  businessId: string,
  input: { email: string; name: string; password: string; role: MemberRole },
  entry: AuditEntry,
): Promise<Member> {
  const passwordHash = await hashPassword(input.password);
  return withTransaction(async (tx) => {
    const [existing] = await query<{ id: string }>(
      'SELECT id FROM users WHERE lower(email) = lower($1)',
      [input.email],
      tx,
    );
    let userId = existing?.id;
    // An email that already exists (e.g. works for the other business) is added to this
    // business with its current password; the admin's password input is ignored.
    if (!userId) {
      const [created] = await query<{ id: string }>(
        'INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id',
        [input.email, input.name, passwordHash],
        tx,
      );
      userId = created!.id;
    }
    await query(
      'INSERT INTO user_businesses (user_id, business_id, role) VALUES ($1, $2, $3)',
      [userId, businessId, input.role],
      tx,
    );
    await audit({ ...entry, entityId: userId, details: { email: input.email, role: input.role } }, tx);
    return getMember2(tx, businessId, userId);
  });
}

async function getMember2(tx: Queryable, businessId: string, userId: string) {
  const [m] = await query<Member>(
    `SELECT u.id, u.email, u.name, ub.role, u.active
       FROM user_businesses ub JOIN users u ON u.id = ub.user_id
      WHERE ub.business_id = $1 AND u.id = $2`,
    [businessId, userId],
    tx,
  );
  return m!;
}

export async function updateMember(
  businessId: string,
  userId: string,
  patch: { name?: string; role?: MemberRole },
  entry: AuditEntry,
): Promise<Member> {
  await getMember(businessId, userId);
  await withTransaction(async (tx) => {
    if (patch.name !== undefined) {
      await query('UPDATE users SET name = $2 WHERE id = $1', [userId, patch.name], tx);
    }
    if (patch.role !== undefined) {
      await query(
        'UPDATE user_businesses SET role = $3 WHERE user_id = $1 AND business_id = $2',
        [userId, businessId, patch.role],
        tx,
      );
    }
    await audit({ ...entry, entityId: userId, details: patch }, tx);
  });
  return getMember(businessId, userId);
}

export async function removeMember(businessId: string, userId: string, entry: AuditEntry) {
  await getMember(businessId, userId);
  await withTransaction(async (tx) => {
    await query('DELETE FROM user_businesses WHERE user_id = $1 AND business_id = $2', [
      userId,
      businessId,
    ], tx);
    await audit({ ...entry, entityId: userId }, tx);
  });
}

export async function resetPassword(
  businessId: string,
  userId: string,
  newPassword: string,
  entry: AuditEntry,
) {
  await getMember(businessId, userId);
  const hash = await hashPassword(newPassword);
  await withTransaction(async (tx) => {
    await query('UPDATE users SET password_hash = $2 WHERE id = $1', [userId, hash], tx);
    await query(
      'UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL',
      [userId],
      tx,
    );
    await audit({ ...entry, entityId: userId }, tx);
  });
}
