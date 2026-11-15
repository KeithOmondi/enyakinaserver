import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { env } from '../../config/env';
import { ctx, requireRole, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { addDateRange } from '../../utils/dates';
import { isoDate } from '../../utils/pagination';

/** Profit and stock-value figures: admins only. */
export const reportsRouter = Router();
reportsRouter.use(...tenantAuth, requireRole('admin'));

const rangeQuery = z
  .object({ from: isoDate, to: isoDate })
  .refine((q) => q.from <= q.to, { message: 'from must not be after to', path: ['from'] });

reportsRouter.get(
  '/summary',
  validate({ query: rangeQuery }),
  asyncHandler(async (req, res) => {
    const { businessId } = ctx(req);
    const { from, to } = req.query as unknown as z.infer<typeof rangeQuery>;
    const where = ['s.business_id = $1'];
    const params: unknown[] = [businessId];
    addDateRange(where, params, 's.created_at', from, to);
    const base = where.join(' AND ');
    const tzIdx = params.length; // addDateRange pushed the timezone as the last parameter

    const [totals] = await query(
      `SELECT count(*) FILTER (WHERE s.status = 'completed') AS sales_count,
              count(*) FILTER (WHERE s.status = 'voided') AS voided_count,
              COALESCE(sum(s.total_cents) FILTER (WHERE s.status = 'completed'), 0)::bigint AS revenue_cents,
              COALESCE(sum(s.discount_cents) FILTER (WHERE s.status = 'completed'), 0)::bigint AS discount_cents,
              COALESCE(sum(c.cogs) FILTER (WHERE s.status = 'completed'), 0)::bigint AS cogs_cents
         FROM sales s
         LEFT JOIN LATERAL (SELECT sum(round(quantity * unit_cost_cents)) AS cogs FROM sale_items WHERE sale_id = s.id) c ON true
        WHERE ${base}`,
      params,
    );

    const byDay = await query(
      `SELECT (s.created_at AT TIME ZONE $${tzIdx})::date AS date,
              count(*) AS sales_count,
              sum(s.total_cents)::bigint AS revenue_cents,
              (sum(s.total_cents) - COALESCE(sum(c.cogs), 0))::bigint AS profit_cents
         FROM sales s
         LEFT JOIN LATERAL (SELECT sum(round(quantity * unit_cost_cents)) AS cogs FROM sale_items WHERE sale_id = s.id) c ON true
        WHERE ${base} AND s.status = 'completed'
        GROUP BY 1 ORDER BY 1`,
      params,
    );

    const byPayment = await query(
      `SELECT p.method, sum(p.amount_cents)::bigint AS amount_cents
         FROM payments p JOIN sales s ON s.id = p.sale_id
        WHERE ${base} AND s.status = 'completed' GROUP BY p.method ORDER BY p.method`,
      params,
    );

    const topProducts = await query(
      `SELECT si.product_id, si.name, sum(si.quantity) AS quantity, sum(si.line_total_cents)::bigint AS revenue_cents
         FROM sale_items si JOIN sales s ON s.id = si.sale_id
        WHERE ${base} AND s.status = 'completed'
        GROUP BY si.product_id, si.name ORDER BY revenue_cents DESC LIMIT 10`,
      params,
    );

    const t = totals as unknown as { salesCount: number; revenueCents: number; cogsCents: number };
    res.json({
      from, to, timezone: env.BUSINESS_TIMEZONE,
      ...totals,
      grossProfitCents: t.revenueCents - t.cogsCents,
      averageSaleCents: t.salesCount > 0 ? Math.round(t.revenueCents / t.salesCount) : 0,
      byDay, byPayment, topProducts,
    });
  }),
);

reportsRouter.get(
  '/stock-valuation',
  asyncHandler(async (req, res) => {
    const items = await query(
      `SELECT c.name AS category_name, count(*) AS products,
              COALESCE(sum(s.quantity), 0) AS units,
              COALESCE(sum(round(s.quantity * p.cost_cents)), 0)::bigint AS cost_value_cents,
              COALESCE(sum(round(s.quantity * p.price_cents)), 0)::bigint AS retail_value_cents
         FROM products p
         JOIN stock_levels s ON s.product_id = p.id
         LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.business_id = $1 AND p.active
        GROUP BY c.name ORDER BY c.name NULLS LAST`,
      [ctx(req).businessId],
    );
    res.json({ items });
  }),
);
