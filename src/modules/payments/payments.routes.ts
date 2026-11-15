import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { ctx, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { addDateRange } from '../../utils/dates';
import { isoDate, offsetOf, pageQuery } from '../../utils/pagination';

export const paymentsRouter = Router();
paymentsRouter.use(...tenantAuth);

const filterQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  method: z.enum(['cash', 'mpesa', 'card']).optional(),
  ...pageQuery,
});

function build(businessId: string, f: z.infer<typeof filterQuery>) {
  // Voided sales never count as money received.
  const where = ['p.business_id = $1', `s.status = 'completed'`];
  const params: unknown[] = [businessId];
  if (f.method) {
    params.push(f.method);
    where.push(`p.method = $${params.length}`);
  }
  addDateRange(where, params, 'p.created_at', f.from, f.to);
  return { clause: where.join(' AND '), params };
}

paymentsRouter.get(
  '/',
  validate({ query: filterQuery }),
  asyncHandler(async (req, res) => {
    const f = req.query as unknown as z.infer<typeof filterQuery>;
    const { clause, params } = build(ctx(req).businessId, f);
    const [count] = await query<{ total: number }>(
      `SELECT count(*) AS total FROM payments p JOIN sales s ON s.id = p.sale_id WHERE ${clause}`,
      params,
    );
    const items = await query(
      `SELECT p.id, p.method, p.amount_cents, p.reference, p.created_at, s.id AS sale_id, s.receipt_no
         FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE ${clause} ORDER BY p.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, offsetOf(f.page, f.pageSize)],
    );
    res.json({ items, total: count?.total ?? 0, page: f.page, pageSize: f.pageSize });
  }),
);

paymentsRouter.get(
  '/summary',
  validate({ query: filterQuery }),
  asyncHandler(async (req, res) => {
    const f = req.query as unknown as z.infer<typeof filterQuery>;
    const { clause, params } = build(ctx(req).businessId, f);
    const items = await query(
      `SELECT p.method, count(*) AS count, COALESCE(sum(p.amount_cents), 0)::bigint AS amount_cents
         FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE ${clause} GROUP BY p.method ORDER BY p.method`,
      params,
    );
    res.json({ items });
  }),
);
