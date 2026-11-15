import { Router } from 'express';
import { z } from 'zod';
import { ctx, requireRole, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { auditFromReq } from '../../services/audit';
import { AppError } from '../../utils/AppError';
import { asyncHandler } from '../../utils/asyncHandler';
import { MIN_PASSWORD_LENGTH } from '../../utils/password';
import { uuid } from '../../utils/pagination';
import * as service from './users.service';

export const usersRouter = Router();
usersRouter.use(...tenantAuth, requireRole('admin'));

const role = z.enum(['admin', 'shop_manager']);
const password = z.string().min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`).max(200);
const idParams = z.object({ id: uuid });

const createBody = z
  .object({ email: z.string().trim().email().max(254), name: z.string().trim().min(1).max(100), password, role })
  .strict();
const updateBody = z
  .object({ name: z.string().trim().min(1).max(100).optional(), role: role.optional() })
  .strict()
  .refine((b) => Object.keys(b).length > 0, 'Nothing to update');
const resetBody = z.object({ newPassword: password }).strict();

/** An admin must not lock themselves out by demoting or removing their own membership. */
function notSelf(req: Express.Request, id: string) {
  if (req.user?.id === id) throw AppError.badRequest('You cannot do this to your own account');
}

usersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ items: await service.listMembers(ctx(req).businessId) });
  }),
);

usersRouter.post(
  '/',
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const member = await service.createMember(
      ctx(req).businessId,
      req.body as z.infer<typeof createBody>,
      auditFromReq(req, 'user_added', 'user'),
    );
    res.status(201).json(member);
  }),
);

usersRouter.patch(
  '/:id',
  validate({ params: idParams, body: updateBody }),
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    const body = req.body as z.infer<typeof updateBody>;
    if (body.role) notSelf(req, id);
    res.json(
      await service.updateMember(ctx(req).businessId, id, body, auditFromReq(req, 'user_updated', 'user')),
    );
  }),
);

usersRouter.post(
  '/:id/reset-password',
  validate({ params: idParams, body: resetBody }),
  asyncHandler(async (req, res) => {
    await service.resetPassword(
      ctx(req).businessId,
      req.params.id!,
      (req.body as z.infer<typeof resetBody>).newPassword,
      auditFromReq(req, 'user_password_reset', 'user'),
    );
    res.status(204).end();
  }),
);

usersRouter.delete(
  '/:id',
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    notSelf(req, req.params.id!);
    await service.removeMember(ctx(req).businessId, req.params.id!, auditFromReq(req, 'user_removed', 'user'));
    res.status(204).end();
  }),
);
