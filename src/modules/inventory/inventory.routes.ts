import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { withTransaction } from '../../db/transaction';
import { ctx, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { audit, auditFromReq } from '../../services/audit';
import { applyStockChange } from '../../services/stock';
import { AppError } from '../../utils/AppError';
import { asyncHandler } from '../../utils/asyncHandler';
import { isoDate, offsetOf, pageQuery, queryBool, uuid } from '../../utils/pagination';
import { quantity } from '../../utils/validators';
import { env } from '../../config/env';
import { getProduct, listProducts } from '../products/products.service';

export const inventoryRouter = Router();
inventoryRouter.use(...tenantAuth);

const stockQuery = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: uuid.optional(),
  lowStock: queryBool.optional(),
  ...pageQuery,
});

const movementsQuery = z.object({
  productId: uuid.optional(),
  type: z.enum(['opening', 'purchase', 'sale', 'void', 'adjustment', 'new_stock', 'cold_room']).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...pageQuery,
});

const adjustBody = z
  .object({
    productId: uuid,
    /** "delta" adds or removes this amount; "set" makes the shelf count equal this amount. */
    mode: z.enum(['delta', 'set']),
    quantity,
    reason: z.string().trim().min(3, 'Give a short reason').max(200),
    /**
     * Where the change came from. "new_stock" and "cold_room" are stock coming IN: they must be a
     * positive "delta" so they can be tracked (and are never confused with a recount).
     */
    source: z.enum(['adjustment', 'new_stock', 'cold_room']).default('adjustment'),
  })
  .strict()
  .refine((b) => b.source === 'adjustment' || (b.mode === 'delta' && b.quantity > 0), {
    path: ['quantity'],
    message: 'New stock must be a positive amount to add',
  });

// Current stock levels (active products only).
inventoryRouter.get(
  '/',
  validate({ query: stockQuery }),
  asyncHandler(async (req, res) => {
    const q = req.query as unknown as z.infer<typeof stockQuery>;
    res.json(await listProducts(ctx(req).businessId, { ...q, status: 'active' }));
  }),
);

// Headline numbers for the dashboard.
inventoryRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const [row] = await query<{ products: number; units: number; valueCents: number; lowStock: number; outOfStock: number }>(
      `SELECT count(*) AS products,
              COALESCE(sum(s.quantity), 0) AS units,
              COALESCE(sum(round(s.quantity * p.cost_cents)), 0)::bigint AS value_cents,
              count(*) FILTER (WHERE p.reorder_level > 0 AND s.quantity <= p.reorder_level) AS low_stock,
              count(*) FILTER (WHERE s.quantity = 0) AS out_of_stock
         FROM products p JOIN stock_levels s ON s.product_id = p.id
        WHERE p.business_id = $1 AND p.active`,
      [ctx(req).businessId],
    );
    res.json(row);
  }),
);

interface Movement {
  id: number;
  productId: string;
  productName: string;
  sku: string;
  type: string;
  quantity: number;
  balanceAfter: number;
  referenceId: string | null;
  note: string | null;
  userName: string | null;
  createdAt: string;
}

inventoryRouter.get(
  '/movements',
  validate({ query: movementsQuery }),
  asyncHandler(async (req, res) => {
    const f = req.query as unknown as z.infer<typeof movementsQuery>;
    const { businessId } = ctx(req);
    const where = ['m.business_id = $1'];
    const params: unknown[] = [businessId];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (f.productId) add('m.product_id = ?', f.productId);
    if (f.type) add('m.type = ?', f.type);
    if (f.from) {
      params.push(f.from, env.BUSINESS_TIMEZONE);
      where.push(`m.created_at >= ($${params.length - 1}::date::timestamp AT TIME ZONE $${params.length})`);
    }
    if (f.to) {
      params.push(f.to, env.BUSINESS_TIMEZONE);
      where.push(`m.created_at < (($${params.length - 1}::date + 1)::timestamp AT TIME ZONE $${params.length})`);
    }
    const clause = where.join(' AND ');
    const [count] = await query<{ total: number }>(`SELECT count(*) AS total FROM stock_movements m WHERE ${clause}`, params);
    const items = await query<Movement>(
      `SELECT m.id, m.product_id, p.name AS product_name, p.sku, m.type, m.quantity, m.balance_after,
              m.reference_id, m.note, u.name AS user_name, m.created_at
         FROM stock_movements m
         JOIN products p ON p.id = m.product_id
         LEFT JOIN users u ON u.id = m.user_id
        WHERE ${clause}
        ORDER BY m.created_at DESC, m.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, offsetOf(f.page, f.pageSize)],
    );
    res.json({ items, total: count?.total ?? 0, page: f.page, pageSize: f.pageSize });
  }),
);

// Manual correction (damage, theft, recount). Allowed for shop managers; always audited.
inventoryRouter.post(
  '/adjustments',
  validate({ body: adjustBody }),
  asyncHandler(async (req, res) => {
    const { businessId, userId } = ctx(req);
    const b = req.body as z.infer<typeof adjustBody>;

    const result = await withTransaction(async (tx) => {
      // Lock the row so a "set" count cannot race with a sale.
      const [current] = await query<{ quantity: number; allowsFraction: boolean }>(
        `SELECT s.quantity, p.allows_fraction FROM stock_levels s JOIN products p ON p.id = s.product_id
          WHERE s.product_id = $1 AND s.business_id = $2 FOR UPDATE OF s`,
        [b.productId, businessId],
        tx,
      );
      if (!current) throw AppError.notFound('Product');
      if (!current.allowsFraction && !Number.isInteger(b.quantity)) {
        throw AppError.validation([{ path: 'quantity', message: 'This product is sold in whole units' }]);
      }
      const delta = b.mode === 'set' ? Math.round((b.quantity - current.quantity) * 1000) / 1000 : b.quantity;
      if (b.mode === 'set' && b.quantity < 0) {
        throw AppError.validation([{ path: 'quantity', message: 'A count cannot be negative' }]);
      }
      if (delta === 0) throw AppError.badRequest('That is already the current stock');
      await applyStockChange(tx, {
        businessId, productId: b.productId, quantity: delta, type: b.source, userId, note: b.reason,
      });
      await audit(
        auditFromReq(req, 'stock_adjusted', 'product', b.productId, { mode: b.mode, source: b.source, delta, before: current.quantity, reason: b.reason }),
        tx,
      );
      return getProduct(businessId, b.productId, tx);
    });
    res.status(201).json(result);
  }),
);
