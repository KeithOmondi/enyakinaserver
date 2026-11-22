import express, { Router } from 'express';
import { z } from 'zod';
import { ctx, requireRole, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { auditFromReq } from '../../services/audit';
import { AppError } from '../../utils/AppError';
import { asyncHandler } from '../../utils/asyncHandler';
import { pageQuery, queryBool, uuid } from '../../utils/pagination';
import { cents, nonNegativeQuantity, optionalText } from '../../utils/validators';
import * as service from './products.service';

export const productsRouter = Router();
productsRouter.use(...tenantAuth);

const idParams = z.object({ id: uuid });

const listQuery = z.object({
  q: z.string().trim().max(100).optional(),
  categoryId: uuid.optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  lowStock: queryBool.optional(),
  ...pageQuery,
});

const productFields = {
  /** Optional: the system generates the SKU and barcode. Only integrations/imports supply their own. */
  sku: z.string().trim().min(1).max(40).optional(),
  barcode: optionalText(64),
  name: z.string().trim().min(1).max(160),
  categoryId: uuid.nullable().optional(),
  unit: z.string().trim().min(1).max(20).default('pcs'),
  allowsFraction: z.boolean().default(false),
  priceCents: cents,
  costCents: cents.default(0),
  reorderLevel: nonNegativeQuantity.default(0),
};

const createBody = z.object({ ...productFields, openingStock: nonNegativeQuantity.default(0) }).strict();
const updateBody = z
  .object({
    // sku and barcode are generated once and never edited.
    name: productFields.name.optional(),
    categoryId: productFields.categoryId,
    unit: z.string().trim().min(1).max(20).optional(),
    allowsFraction: z.boolean().optional(),
    priceCents: cents.optional(),
    costCents: cents.optional(),
    reorderLevel: nonNegativeQuantity.optional(),
    active: z.boolean().optional(),
  })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');

productsRouter.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    res.json(await service.listProducts(ctx(req).businessId, req.query as unknown as z.infer<typeof listQuery>));
  }),
);

productsRouter.get(
  '/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json(await service.getProduct(ctx(req).businessId, req.params.id!));
  }),
);

productsRouter.post(
  '/',
  requireRole('admin'),
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const { businessId, userId } = ctx(req);
    const product = await service.createProduct(
      businessId,
      userId,
      req.body as z.infer<typeof createBody>,
      auditFromReq(req, 'product_created', 'product'),
    );
    res.status(201).json(product);
  }),
);

productsRouter.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: idParams, body: updateBody }),
  asyncHandler(async (req, res) => {
    res.json(
      await service.updateProduct(
        ctx(req).businessId,
        req.params.id!,
        req.body as z.infer<typeof updateBody>,
        auditFromReq(req, 'product_updated', 'product'),
      ),
    );
  }),
);

// Product photo. The body is the raw image (the browser has already resized it); 2 MB is plenty.
const imageBody = express.raw({ type: ['image/jpeg', 'image/png', 'image/webp'], limit: '2mb' });

productsRouter.put(
  '/:id/image',
  requireRole('admin'),
  validate({ params: idParams }),
  imageBody,
  asyncHandler(async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new AppError(415, 'BAD_REQUEST', 'Upload a JPEG, PNG or WebP image');
    res.json(
      await service.setProductImage(
        ctx(req).businessId,
        req.params.id!,
        req.body,
        (req.header('content-type') ?? '').split(';')[0]!.trim(),
        auditFromReq(req, 'product_image_changed', 'product'),
      ),
    );
  }),
);

productsRouter.delete(
  '/:id/image',
  requireRole('admin'),
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json(
      await service.removeProductImage(ctx(req).businessId, req.params.id!, auditFromReq(req, 'product_image_changed', 'product')),
    );
  }),
);
