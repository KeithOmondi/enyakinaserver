import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { ctx, requireRole, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { audit, auditFromReq } from '../../services/audit';
import { AppError } from '../../utils/AppError';
import { asyncHandler } from '../../utils/asyncHandler';
import { queryBool, uuid } from '../../utils/pagination';

export const suppliersRouter = Router();
suppliersRouter.use(...tenantAuth);

interface Supplier {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  active: boolean;
}

const COLS = 'id, name, phone, email, notes, active';
const idParams = z.object({ id: uuid });
const listQuery = z.object({ includeInactive: queryBool.default('false') });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

const createBody = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: optionalText(40),
    email: z.union([z.literal(''), z.string().trim().email().max(254)]).transform((v) => v || null).nullable().optional(),
    notes: optionalText(500),
  })
  .strict();
const updateBody = createBody
  .partial()
  .extend({ active: z.boolean().optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

async function get(businessId: string, id: string): Promise<Supplier> {
  const [s] = await query<Supplier>(`SELECT ${COLS} FROM suppliers WHERE business_id = $1 AND id = $2`, [
    businessId,
    id,
  ]);
  if (!s) throw AppError.notFound('Supplier');
  return s;
}

suppliersRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { includeInactive } = req.query as unknown as z.infer<typeof listQuery>;
    const items = await query<Supplier>(
      `SELECT ${COLS} FROM suppliers WHERE business_id = $1 AND ($2 OR active) ORDER BY lower(name)`,
      [ctx(req).businessId, includeInactive],
    );
    res.json({ items });
  }),
);

suppliersRouter.post(
  '/',
  requireRole('admin'),
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const { businessId } = ctx(req);
    const b = req.body as z.infer<typeof createBody>;
    const [row] = await query<{ id: string }>(
      'INSERT INTO suppliers (business_id, name, phone, email, notes) VALUES ($1, $2, $3, $4, $5) RETURNING id',
      [businessId, b.name, b.phone ?? null, b.email ?? null, b.notes ?? null],
    );
    await audit(auditFromReq(req, 'supplier_created', 'supplier', row!.id, { name: b.name }));
    res.status(201).json(await get(businessId, row!.id));
  }),
);

suppliersRouter.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParams, body: updateBody }),
  asyncHandler(async (req, res) => {
    const { businessId } = ctx(req);
    const id = req.params.id!;
    const b = req.body as z.infer<typeof updateBody>;
    await get(businessId, id);
    await query(
      `UPDATE suppliers SET
         name = COALESCE($3, name),
         phone = CASE WHEN $4::boolean THEN $5 ELSE phone END,
         email = CASE WHEN $6::boolean THEN $7 ELSE email END,
         notes = CASE WHEN $8::boolean THEN $9 ELSE notes END,
         active = COALESCE($10, active)
       WHERE id = $1 AND business_id = $2`,
      [
        id, businessId, b.name ?? null,
        'phone' in b, b.phone ?? null,
        'email' in b, b.email ?? null,
        'notes' in b, b.notes ?? null,
        b.active ?? null,
      ],
    );
    await audit(auditFromReq(req, 'supplier_updated', 'supplier', id, b));
    res.json(await get(businessId, id));
  }),
);

suppliersRouter.delete(
  '/:id',
  requireRole('admin'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    const { businessId } = ctx(req);
    const id = req.params.id!;
    const s = await get(businessId, id);
    // A supplier with purchases fails with a foreign-key error, which the error handler
    // reports as 409; deactivating is the way to retire one.
    await query('DELETE FROM suppliers WHERE id = $1 AND business_id = $2', [id, businessId]);
    await audit(auditFromReq(req, 'supplier_deleted', 'supplier', id, { name: s.name }));
    res.status(204).end();
  }),
);
