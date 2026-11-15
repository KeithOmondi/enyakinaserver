import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { ctx, requireRole, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { addDateRange } from '../../utils/dates';
import { isoDate, offsetOf, pageQuery, uuid } from '../../utils/pagination';

export const auditRouter = Router();
auditRouter.use(...tenantAuth, requireRole('admin'));

const listQuery = z.object({
  action: z.string().trim().max(60).optional(),
  entity: z.string().trim().max(60).optional(),
  userId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...pageQuery,
});

auditRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const f = req.query as unknown as z.infer<typeof listQuery>;
    const where = ['a.business_id = $1'];
    const params: unknown[] = [ctx(req).businessId];
    for (const [col, v] of [['a.action', f.action], ['a.entity', f.entity], ['a.user_id', f.userId]] as const) {
      if (v) {
        params.push(v);
        where.push(`${col} = $${params.length}`);
      }
    }
    addDateRange(where, params, 'a.created_at', f.from, f.to);
    const clause = where.join(' AND ');
    const [count] = await query<{ total: number }>(`SELECT count(*) AS total FROM audit_log a WHERE ${clause}`, params);
    const items = await query(
      `SELECT a.id, a.action, a.entity, a.entity_id, a.details, a.ip, a.created_at, u.name AS user_name
         FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        WHERE ${clause} ORDER BY a.created_at DESC, a.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, offsetOf(f.page, f.pageSize)],
    );
    res.json({ items, total: count?.total ?? 0, page: f.page, pageSize: f.pageSize });
  }),
);
