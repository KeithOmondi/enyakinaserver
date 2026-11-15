import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { env } from '../../config/env';
import { withTransaction } from '../../db/transaction';
import { ctx, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { audit, auditFromReq } from '../../services/audit';
import { applyStockChange } from '../../services/stock';
import { AppError } from '../../utils/AppError';
import { asyncHandler } from '../../utils/asyncHandler';
import { idempotencyKey } from '../../utils/idempotency';
import { lineTotal } from '../../utils/money';
import { isoDate, offsetOf, pageQuery, uuid } from '../../utils/pagination';
import { cents, optionalText, positiveQuantity } from '../../utils/validators';

export const purchasesRouter = Router();
purchasesRouter.use(...tenantAuth);

const idParams = z.object({ id: uuid });
const listQuery = z.object({
  supplierId: uuid.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  ...pageQuery,
});
const createBody = z
  .object({
    supplierId: uuid.nullable().optional(),
    reference: optionalText(80),
    note: optionalText(300),
    items: z
      .array(z.object({ productId: uuid, quantity: positiveQuantity, unitCostCents: cents }).strict())
      .min(1, 'Add at least one item')
      .max(200),
  })
  .strict();

interface PurchaseRow {
  id: string;
  supplierId: string | null;
  supplierName: string | null;
  reference: string | null;
  note: string | null;
  totalCents: number;
  createdByName: string;
  createdAt: string;
}

const SELECT = `
  SELECT pu.id, pu.supplier_id, s.name AS supplier_name, pu.reference, pu.note, pu.total_cents,
         u.name AS created_by_name, pu.created_at
    FROM purchases pu
    LEFT JOIN suppliers s ON s.id = pu.supplier_id
    JOIN users u ON u.id = pu.created_by`;

async function getPurchase(businessId: string, id: string) {
  const [p] = await query<PurchaseRow>(`${SELECT} WHERE pu.business_id = $1 AND pu.id = $2`, [businessId, id]);
  if (!p) throw AppError.notFound('Purchase');
  const items = await query(
    `SELECT pi.product_id, p.name AS product_name, p.sku, pi.quantity, pi.unit_cost_cents
       FROM purchase_items pi JOIN products p ON p.id = pi.product_id
      WHERE pi.purchase_id = $1 ORDER BY p.name`,
    [id],
  );
  return { ...p, items };
}

purchasesRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const f = req.query as unknown as z.infer<typeof listQuery>;
    const where = ['pu.business_id = $1'];
    const params: unknown[] = [ctx(req).businessId];
    if (f.supplierId) {
      params.push(f.supplierId);
      where.push(`pu.supplier_id = $${params.length}`);
    }
    if (f.from) {
      params.push(f.from, env.BUSINESS_TIMEZONE);
      where.push(`pu.created_at >= ($${params.length - 1}::date::timestamp AT TIME ZONE $${params.length})`);
    }
    if (f.to) {
      params.push(f.to, env.BUSINESS_TIMEZONE);
      where.push(`pu.created_at < (($${params.length - 1}::date + 1)::timestamp AT TIME ZONE $${params.length})`);
    }
    const clause = where.join(' AND ');
    const [count] = await query<{ total: number }>(`SELECT count(*) AS total FROM purchases pu WHERE ${clause}`, params);
    const items = await query<PurchaseRow>(
      `${SELECT} WHERE ${clause} ORDER BY pu.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.pageSize, offsetOf(f.page, f.pageSize)],
    );
    res.json({ items, total: count?.total ?? 0, page: f.page, pageSize: f.pageSize });
  }),
);

purchasesRouter.get(
  '/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json(await getPurchase(ctx(req).businessId, req.params.id!));
  }),
);

// Receiving stock: records the purchase and adds the stock in one transaction.
purchasesRouter.post(
  '/',
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const { businessId, userId } = ctx(req);
    const b = req.body as z.infer<typeof createBody>;
    const key = idempotencyKey(req, false);

    const ids = b.items.map((i) => i.productId);
    if (new Set(ids).size !== ids.length) {
      throw AppError.validation([{ path: 'items', message: 'Each product can appear only once' }]);
    }

    if (key) {
      const [seen] = await query<{ id: string }>(
        'SELECT id FROM purchases WHERE business_id = $1 AND idempotency_key = $2',
        [businessId, key],
      );
      if (seen) return void res.status(200).json(await getPurchase(businessId, seen.id));
    }

    const id = await withTransaction(async (tx) => {
      if (b.supplierId) {
        const s = await query('SELECT 1 FROM suppliers WHERE id = $1 AND business_id = $2', [b.supplierId, businessId], tx);
        if (s.length === 0) throw AppError.validation([{ path: 'supplierId', message: 'Supplier not found' }]);
      }
      const products = await query<{ id: string; allowsFraction: boolean; name: string }>(
        'SELECT id, allows_fraction, name FROM products WHERE business_id = $1 AND id = ANY($2::uuid[])',
        [businessId, ids],
        tx,
      );
      if (products.length !== ids.length) throw AppError.validation([{ path: 'items', message: 'Unknown product in list' }]);
      for (const it of b.items) {
        const p = products.find((x) => x.id === it.productId)!;
        if (!p.allowsFraction && !Number.isInteger(it.quantity)) {
          throw AppError.validation([{ path: 'items', message: `"${p.name}" is received in whole units` }]);
        }
      }

      const total = b.items.reduce((sum, it) => sum + lineTotal(it.unitCostCents, it.quantity), 0);
      const [row] = await query<{ id: string }>(
        `INSERT INTO purchases (business_id, supplier_id, reference, note, total_cents, idempotency_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
        [businessId, b.supplierId ?? null, b.reference ?? null, b.note ?? null, total, key, userId],
        tx,
      );
      const purchaseId = row!.id;

      // Fixed order (by product id) so two concurrent purchases cannot deadlock on stock rows.
      for (const it of [...b.items].sort((x, y) => x.productId.localeCompare(y.productId))) {
        await query(
          'INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_cost_cents) VALUES ($1, $2, $3, $4)',
          [purchaseId, it.productId, it.quantity, it.unitCostCents],
          tx,
        );
        await applyStockChange(tx, {
          businessId, productId: it.productId, quantity: it.quantity, type: 'purchase',
          referenceId: purchaseId, userId, note: b.reference ?? null,
        });
        // Latest cost drives profit reports for future sales.
        await query('UPDATE products SET cost_cents = $2, updated_at = now() WHERE id = $1', [it.productId, it.unitCostCents], tx);
      }
      await audit(auditFromReq(req, 'purchase_received', 'purchase', purchaseId, { items: b.items.length, totalCents: total }), tx);
      return purchaseId;
    }).catch(async (err: unknown) => {
      // Two requests with the same key raced: the loser returns the winner's purchase.
      if (key && (err as { code?: string }).code === '23505') {
        const [seen] = await query<{ id: string }>(
          'SELECT id FROM purchases WHERE business_id = $1 AND idempotency_key = $2',
          [businessId, key],
        );
        if (seen) return seen.id;
      }
      throw err;
    });

    res.status(201).json(await getPurchase(businessId, id));
  }),
);
