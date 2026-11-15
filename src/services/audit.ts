import type { Request } from 'express';
import { query, type Queryable } from '../config/db';

export interface AuditEntry {
  businessId?: string | null;
  userId?: string | null;
  action: string;
  entity: string;
  entityId?: string | null;
  details?: Record<string, unknown>;
  ip?: string | null;
}

/** Writes an audit row. Pass the transaction client so it commits or rolls back with the change. */
export async function audit(entry: AuditEntry, db?: Queryable): Promise<void> {
  await query(
    `INSERT INTO audit_log (business_id, user_id, action, entity, entity_id, details, ip)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      entry.businessId ?? null,
      entry.userId ?? null,
      entry.action,
      entry.entity,
      entry.entityId ?? null,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.ip ?? null,
    ],
    db,
  );
}

/** Builds an entry from the request (user, business, ip). */
export function auditFromReq(
  req: Request,
  action: string,
  entity: string,
  entityId?: string | null,
  details?: Record<string, unknown>,
): AuditEntry {
  return {
    businessId: req.businessId ?? null,
    userId: req.user?.id ?? null,
    action,
    entity,
    entityId: entityId ?? null,
    details,
    ip: req.ip ?? null,
  };
}
