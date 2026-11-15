import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { env } from '../../config/env';
import { ctx, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { audit, auditFromReq } from '../../services/audit';
import { AppError } from '../../utils/AppError';
import { asyncHandler } from '../../utils/asyncHandler';
import { businessToday } from '../../utils/dates';
import { isoDate, offsetOf, pageQuery } from '../../utils/pagination';
import { cents, optionalText } from '../../utils/validators';

/**
 * End-of-day cash-up. The shop counts the till, the server compares it with what the
 * sales say should be there, and the result is kept as a permanent record.
 */
export const closingsRouter = Router();
closingsRouter.use(...tenantAuth);

const dateQuery = z.object({ date: isoDate.default(() => businessToday()) });
const listQuery = z.object({ ...pageQuery });
const createBody = z
  .object({ date: isoDate, countedCashCents: cents, note: optionalText(300) })
  .strict();

interface Totals {
  salesCount: number;
  totalCents: number;
  cashCents: number;
  mpesaCents: number;
  cardCents: number;
  voidedCount: number;
  /** M-Pesa taken with a typed code instead of a confirmed prompt: check against the statement. */
  unverifiedMpesaCents: number;
}

/** Totals for one business day (completed sales only; payments are stored net of change). */
async function totalsFor(businessId: string, date: string): Promise<Totals> {
  const [row] = await query<Totals>(
    `SELECT count(*) FILTER (WHERE s.status = 'completed') AS sales_count,
            COALESCE(sum(s.total_cents) FILTER (WHERE s.status = 'completed'), 0)::bigint AS total_cents,
            COALESCE(sum(pm.cash) FILTER (WHERE s.status = 'completed'), 0)::bigint AS cash_cents,
            COALESCE(sum(pm.mpesa) FILTER (WHERE s.status = 'completed'), 0)::bigint AS mpesa_cents,
            COALESCE(sum(pm.card) FILTER (WHERE s.status = 'completed'), 0)::bigint AS card_cents,
            COALESCE(sum(pm.mpesa_unverified) FILTER (WHERE s.status = 'completed'), 0)::bigint AS unverified_mpesa_cents,
            count(*) FILTER (WHERE s.status = 'voided') AS voided_count
       FROM sales s
       LEFT JOIN LATERAL (
         SELECT sum(amount_cents) FILTER (WHERE method = 'cash') AS cash,
                sum(amount_cents) FILTER (WHERE method = 'mpesa') AS mpesa,
                sum(amount_cents) FILTER (WHERE method = 'card') AS card,
                sum(amount_cents) FILTER (WHERE method = 'mpesa' AND mpesa_request_id IS NULL) AS mpesa_unverified
           FROM payments WHERE sale_id = s.id
       ) pm ON true
      WHERE s.business_id = $1 AND (s.created_at AT TIME ZONE $2)::date = $3::date`,
    [businessId, env.BUSINESS_TIMEZONE, date],
  );
  return row!;
}

closingsRouter.get(
  '/preview',
  validate({ query: dateQuery }),
  asyncHandler(async (req, res) => {
    const { businessId } = ctx(req);
    const { date } = req.query as unknown as z.infer<typeof dateQuery>;
    const [closed] = await query(
      `SELECT id, counted_cash_cents, variance_cents, created_at FROM daily_closings
        WHERE business_id = $1 AND business_date = $2`,
      [businessId, date],
    );
    const totals = await totalsFor(businessId, date);
    res.json({ date, ...totals, expectedCashCents: totals.cashCents, closing: closed ?? null });
  }),
);

closingsRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const f = req.query as unknown as z.infer<typeof listQuery>;
    const { businessId } = ctx(req);
    const [count] = await query<{ total: number }>('SELECT count(*) AS total FROM daily_closings WHERE business_id = $1', [businessId]);
    const items = await query(
      `SELECT c.id, c.business_date, c.sales_count, c.total_cents, c.cash_cents, c.mpesa_cents, c.card_cents,
              c.counted_cash_cents, c.variance_cents, c.note, c.created_at, u.name AS closed_by_name
         FROM daily_closings c JOIN users u ON u.id = c.closed_by
        WHERE c.business_id = $1 ORDER BY c.business_date DESC LIMIT $2 OFFSET $3`,
      [businessId, f.pageSize, offsetOf(f.page, f.pageSize)],
    );
    res.json({ items, total: count?.total ?? 0, page: f.page, pageSize: f.pageSize });
  }),
);

closingsRouter.post(
  '/',
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const { businessId, userId } = ctx(req);
    const b = req.body as z.infer<typeof createBody>;
    if (b.date > businessToday()) throw AppError.badRequest('You cannot close a day that has not happened yet');

    const t = await totalsFor(businessId, b.date);
    // Cash that should be in the till = cash received (payments are already net of change).
    const variance = b.countedCashCents - t.cashCents;
    const [row] = await query<{ id: string }>(
      `INSERT INTO daily_closings (business_id, business_date, sales_count, total_cents, cash_cents, mpesa_cents,
                                   card_cents, counted_cash_cents, variance_cents, note, closed_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [businessId, b.date, t.salesCount, t.totalCents, t.cashCents, t.mpesaCents, t.cardCents,
       b.countedCashCents, variance, b.note ?? null, userId],
    ).catch((err: { code?: string }) => {
      if (err.code === '23505') throw AppError.conflict('This day has already been closed');
      throw err;
    });
    await audit(auditFromReq(req, 'day_closed', 'closing', row!.id, { date: b.date, varianceCents: variance }));
    res.status(201).json({ id: row!.id, date: b.date, ...t, countedCashCents: b.countedCashCents, varianceCents: variance });
  }),
);
