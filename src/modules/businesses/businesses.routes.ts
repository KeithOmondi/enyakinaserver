import { Router } from 'express';
import { z } from 'zod';
import { query } from '../../config/db';
import { env } from '../../config/env';
import { ctx, requireRole, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { audit, auditFromReq } from '../../services/audit';
import { mpesaMode } from '../../services/mpesa/types';
import { storageConfigured } from '../../services/storage';
import { AppError } from '../../utils/AppError';
import { asyncHandler } from '../../utils/asyncHandler';

export const businessesRouter = Router();
businessesRouter.use(...tenantAuth);

interface BusinessRow {
  id: string;
  code: string;
  name: string;
  phone: string | null;
  address: string | null;
  receiptFooter: string | null;
}

const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable();

const updateBody = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    phone: text(40).optional(),
    address: text(200).optional(),
    receiptFooter: text(200).optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

async function current(id: string): Promise<BusinessRow> {
  const [b] = await query<BusinessRow>(
    'SELECT id, code, name, phone, address, receipt_footer FROM businesses WHERE id = $1',
    [id],
  );
  if (!b) throw AppError.notFound('Business');
  return b;
}

businessesRouter.get(
  '/current',
  asyncHandler(async (req, res) => {
    res.json({ ...(await current(ctx(req).businessId)), timezone: env.BUSINESS_TIMEZONE, currency: 'KES', imagesEnabled: storageConfigured(), mpesaMode: mpesaMode() });
  }),
);

businessesRouter.patch(
  '/current',
  requireRole('admin'),
  validate({ body: updateBody }),
  asyncHandler(async (req, res) => {
    const { businessId } = ctx(req);
    const b = req.body as z.infer<typeof updateBody>;
    const before = await current(businessId);
    await query(
      `UPDATE businesses SET
         name = COALESCE($2, name),
         phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
         address = CASE WHEN $5::boolean THEN $6 ELSE address END,
         receipt_footer = CASE WHEN $7::boolean THEN $8 ELSE receipt_footer END
       WHERE id = $1`,
      [
        businessId,
        b.name ?? null,
        'phone' in b, b.phone ?? null,
        'address' in b, b.address ?? null,
        'receiptFooter' in b, b.receiptFooter ?? null,
      ],
    );
    await audit(auditFromReq(req, 'business_updated', 'business', businessId, { before, after: b }));
    res.json({ ...(await current(businessId)), timezone: env.BUSINESS_TIMEZONE, currency: 'KES', imagesEnabled: storageConfigured(), mpesaMode: mpesaMode() });
  }),
);
