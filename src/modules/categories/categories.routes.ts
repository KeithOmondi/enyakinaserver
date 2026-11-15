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
  productCount: number;
}

const idParams = z.object({ id: uuid });
const listQuery = z.object({ includeInactive: queryBool.default('false') });
const createBody = z.object({ name: z.string().trim().min(1).max(80) }).strict();
const updateBody = z
  .object({ name: z.string().trim().min(1).max(80).optional(), active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

const SELECT = `
  SELECT c.id, c.name, c.active,
         (SELECT count(*) FROM products p WHERE p.category_id = c.id) AS product_count
    FROM categories c`;

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
      `${SELECT} WHERE c.business_id = $1 AND ($2 OR c.active) ORDER BY lower(c.name)`,
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
    const [row] = await query<{ id: string }>(
      'INSERT INTO categories (business_id, name) VALUES ($1, $2) RETURNING id',
      [businessId, (req.body as z.infer<typeof createBody>).name],
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
    await get(businessId, id);
    await query(
      'UPDATE categories SET name = COALESCE($3, name), active = COALESCE($4, active) WHERE id = $1 AND business_id = $2',
      [id, businessId, b.name ?? null, b.active ?? null],
    );
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
    await query('DELETE FROM categories WHERE id = $1 AND business_id = $2', [id, businessId]);
    await audit(auditFromReq(req, 'category_deleted', 'category', id, { name: c.name }));
    res.status(204).end();
  }),
);
