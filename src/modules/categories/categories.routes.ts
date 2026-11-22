import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { ctx, requireRole, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { audit, auditFromReq } from '../../services/audit';
import { AppError } from '../../utils/AppError';
import { asyncHandler } from '../../utils/asyncHandler';
import { queryBool, uuid } from '../../utils/pagination';

export const categoriesRouter = Router();
categoriesRouter.use(...tenantAuth);

interface Category {
  id: string;
  name: string;
  active: boolean;
  /** The top-level category this one sits under, or null for a top-level category. */
  parentId: string | null;
  parentName: string | null;
  /** Products in this category, including those in its sub-categories. */
  productCount: number;
  childCount: number;
}

const idParams = z.object({ id: uuid });
const listQuery = z.object({ includeInactive: queryBool.default('false') });
const createBody = z.object({ name: z.string().trim().min(1).max(80), parentId: uuid.nullable().optional() }).strict();
const updateBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    active: z.boolean().optional(),
    parentId: uuid.nullable().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const SELECT = `
  SELECT c.id, c.name, c.active, c.parent_id, par.name AS parent_name,
         (SELECT count(*) FROM products p
           WHERE p.category_id = c.id OR p.category_id IN (SELECT id FROM categories k WHERE k.parent_id = c.id)) AS product_count,
         (SELECT count(*) FROM categories k WHERE k.parent_id = c.id) AS child_count
    FROM categories c
    LEFT JOIN categories par ON par.id = c.parent_id`;

/** A parent must be a top-level category of the same business (sub-categories are one level deep). */
async function assertParent(businessId: string, parentId: string | null | undefined, selfId?: string): Promise<void> {
  if (!parentId) return;
  if (parentId === selfId) throw AppError.validation([{ path: 'parentId', message: 'A category cannot be inside itself' }]);
  const [p] = await query<{ parentId: string | null }>('SELECT parent_id FROM categories WHERE id = $1 AND business_id = $2', [parentId, businessId]);
  if (!p) throw AppError.validation([{ path: 'parentId', message: 'Parent category not found' }]);
  if (p.parentId) throw AppError.validation([{ path: 'parentId', message: 'Sub-categories cannot have sub-categories of their own' }]);
}

async function get(businessId: string, id: string): Promise<Category> {
  const [c] = await query<Category>(`${SELECT} WHERE c.business_id = $1 AND c.id = $2`, [businessId, id]);
  if (!c) throw AppError.notFound('Category');
  return c;
}

categoriesRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { includeInactive } = req.query as unknown as z.infer<typeof listQuery>;
    const items = await query<Category>(
      `${SELECT} WHERE c.business_id = $1 AND ($2 OR c.active) ORDER BY lower(COALESCE(par.name, c.name)), (c.parent_id IS NOT NULL), lower(c.name)`,
      [ctx(req).businessId, includeInactive],
    );
    res.json({ items });
  }),
);

categoriesRouter.post(
  '/',
  requireRole('admin'),
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const { businessId } = ctx(req);
    const body = req.body as z.infer<typeof createBody>;
    await assertParent(businessId, body.parentId);
    const [row] = await query<{ id: string }>(
      'INSERT INTO categories (business_id, name, parent_id) VALUES ($1, $2, $3) RETURNING id',
      [businessId, body.name, body.parentId ?? null],
    );
    await audit(auditFromReq(req, 'category_created', 'category', row!.id, req.body));
    res.status(201).json(await get(businessId, row!.id));
  }),
);

categoriesRouter.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParams, body: updateBody }),
  asyncHandler(async (req, res) => {
    const { businessId } = ctx(req);
    const id = req.params.id!;
    const b = req.body as z.infer<typeof updateBody>;
    const current = await get(businessId, id);
    if ('parentId' in b) {
      await assertParent(businessId, b.parentId, id);
      if (b.parentId && current.childCount > 0) {
        throw AppError.validation([{ path: 'parentId', message: 'This category has sub-categories, so it cannot go inside another one' }]);
      }
    }
    await query(
      `UPDATE categories SET name = COALESCE($3, name), active = COALESCE($4, active),
              parent_id = CASE WHEN $5::boolean THEN $6::uuid ELSE parent_id END
        WHERE id = $1 AND business_id = $2`,
      [id, businessId, b.name ?? null, b.active ?? null, 'parentId' in b, b.parentId ?? null],
    );
    // Switching a category off switches off its sub-categories too.
    if (b.active === false) await query('UPDATE categories SET active = false WHERE parent_id = $1 AND business_id = $2', [id, businessId]);
    await audit(auditFromReq(req, 'category_updated', 'category', id, b));
    res.json(await get(businessId, id));
  }),
);

categoriesRouter.delete(
  '/:id',
  requireRole('admin'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const { businessId } = ctx(req);
    const id = req.params.id!;
    const c = await get(businessId, id);
    if (c.productCount > 0) {
      throw AppError.conflict('This category has products. Deactivate it instead of deleting.');
    }
    if (c.childCount > 0) {
      throw AppError.conflict('This category has sub-categories. Remove or move them first, or deactivate it.');
    }
    await query('DELETE FROM categories WHERE id = $1 AND business_id = $2', [id, businessId]);
    await audit(auditFromReq(req, 'category_deleted', 'category', id, { name: c.name }));
    res.status(204).end();
  }),
);
