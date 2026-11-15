import type { RequestHandler } from 'express';
import { query } from '../config/db';
import { env } from '../config/env';
import type { Role } from '../types/express';
import { AppError } from '../utils/AppError';
import { asyncHandler } from '../utils/asyncHandler';
import { verifyAccessToken } from '../utils/tokens';

const RANK: Record<Role, number> = { shop_manager: 1, admin: 2, super_admin: 3 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Requires a valid access token; sets req.user. */
export const authenticate: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return next(AppError.unauthorized());
  try {
    const claims = verifyAccessToken(header.slice(7));
    req.user = {
      id: claims.sub,
      email: claims.email,
      name: claims.name,
      // The flag is ignored unless the deployment explicitly enables super admins.
      isSuperAdmin: claims.sa === true && env.ENABLE_SUPER_ADMIN,
    };
    next();
  } catch (err) {
    next(err);
  }
};

/**
 * Resolves the business from X-Business-Id and the caller's role in it.
 * Membership is checked against the database on every request, so removing a user
 * from a business takes effect immediately. A business the caller cannot access
 * answers 403 whether or not it exists.
 */
export const tenant: RequestHandler = asyncHandler(async (req, _res, next) => {
  const user = req.user;
  if (!user) throw AppError.unauthorized();
  const businessId = req.header('X-Business-Id');
  if (!businessId || !UUID.test(businessId)) {
    throw AppError.badRequest('X-Business-Id header is required');
  }

  const rows = await query<{ role: string | null }>(
    `SELECT ub.role
       FROM businesses b
       JOIN users u ON u.id = $2 AND u.active
       LEFT JOIN user_businesses ub ON ub.business_id = b.id AND ub.user_id = u.id
      WHERE b.id = $1 AND b.active`,
    [businessId, user.id],
  );
  const row = rows[0];
  if (!row) throw AppError.forbidden('No access to this business');

  if (user.isSuperAdmin) req.role = 'super_admin';
  else if (row.role === 'admin' || row.role === 'shop_manager') req.role = row.role;
  else throw AppError.forbidden('No access to this business');

  req.businessId = businessId;
  next();
});

/** Allows the given role or any role above it (super_admin > admin > shop_manager). */
export function requireRole(min: Role): RequestHandler {
  return (req, _res, next) => {
    if (!req.role || RANK[req.role] < RANK[min]) return next(AppError.forbidden());
    next();
  };
}

/** Tenant routes: valid token + business access. */
export const tenantAuth: RequestHandler[] = [authenticate, tenant];

/** Typed accessors so handlers never deal with undefined after the middleware ran. */
export function ctx(req: Express.Request): { userId: string; businessId: string; role: Role } {
  if (!req.user || !req.businessId || !req.role) throw AppError.unauthorized();
  return { userId: req.user.id, businessId: req.businessId, role: req.role };
}
