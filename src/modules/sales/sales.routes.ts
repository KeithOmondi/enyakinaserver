import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { ctx, requireRole, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { auditFromReq } from '../../services/audit';
import { asyncHandler } from '../../utils/asyncHandler';
import { addDateRange } from '../../utils/dates';
import { idempotencyKey } from '../../utils/idempotency';
import { isoDate, offsetOf, pageQuery, uuid } from '../../utils/pagination';
import { cents, optionalText, positiveQuantity } from '../../utils/validators';
import * as service from './sales.service';

export const salesRouter = Router();
salesRouter.use(...tenantAuth);

const idParams = z.object({ id: uuid });

const listQuery = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  status: z.enum(['completed', 'voided']).optional(),
  receiptNo: z.coerce.number().int().positive().optional(),
  ...pageQuery,
});

const checkoutBody = z
  .object({
    items: z
      .array(z.object({ productId: uuid, quantity: positiveQuantity }).strict())
      .min(1, 'The cart is empty')
      .max(200),
    payments: z
      .array(
        z
          .object({
            method: z.enum(['cash', 'mpesa', 'card']),
            amountCents: cents.refine((v) => v > 0, 'Must be above zero'),
            reference: optionalText(80),
            mpesaRequestId: uuid.nullable().optional(),
          })
          .strict(),
      )
      .min(1, 'Add a payment')
      .max(5),
    discountCents: cents.default(0),
    note: optionalText(200),
  })
  .strict();

const voidBody = z.object({ reason: z.string().trim().min(3, 'Give a reason').max(200) }).strict();

salesRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const f = req.query as unknown as z.infer<typeof listQuery>;
    const where = ['s.business_id = $1'];
    const params: unknown[] = [ctx(req).businessId];
    if (f.status) {
      params.push(f.status);
      where.push(`s.status = $${params.length}`);
    }
    if (f.receiptNo) {
      params.push(f.receiptNo);
      where.push(`s.receipt_no = $${params.length}`);
    }
    addDateRange(where, params, 's.created_at', f.from, f.to);
    const clause = where.join(' AND ');
    const [count] = await query<{ total: number }>(`SELECT count(*) AS total FROM sales s WHERE ${clause}`, params);
    const items = await query(
      `SELECT s.id, s.receipt_no, s.status, s.total_cents, s.created_at, u.name AS cashier_name,
              (SELECT count(*) FROM sale_items si WHERE si.sale_id = s.id) AS item_count,
              (SELECT string_agg(DISTINCT p.method, ', ' ORDER BY p.method) FROM payments p WHERE p.sale_id = s.id) AS methods
         FROM sales s JOIN users u ON u.id = s.created_by
        WHERE ${clause}
        ORDER BY s.created_at DESC, s.receipt_no DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, offsetOf(f.page, f.pageSize)],
    );
    res.json({ items, total: count?.total ?? 0, page: f.page, pageSize: f.pageSize });
  }),
);

salesRouter.get(
  '/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json(await service.getSale(ctx(req).businessId, req.params.id!));
  }),
);

// Checkout. 201 for a new sale, 200 when the Idempotency-Key was already used.
salesRouter.post(
  '/',
  validate({ body: checkoutBody }),
  asyncHandler(async (req, res) => {
    const { businessId, userId } = ctx(req);
    const key = idempotencyKey(req, true)!;
    const { sale, replayed } = await service.checkout(
      businessId, userId, key, req.body as z.infer<typeof checkoutBody>,
    );
    res.status(replayed ? 200 : 201).json(sale);
  }),
);

salesRouter.post(
  '/:id/void',
  requireRole('admin'),
  validate({ params: idParams, body: voidBody }),
  asyncHandler(async (req, res) => {
    const { businessId, userId } = ctx(req);
    res.json(
      await service.voidSale(
        businessId, userId, req.params.id!, (req.body as z.infer<typeof voidBody>).reason,
        auditFromReq(req, 'sale_voided', 'sale'),
      ),
    );
  }),
);
