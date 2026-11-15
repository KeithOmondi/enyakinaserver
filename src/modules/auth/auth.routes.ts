import { Router } from 'express';
import { z } from 'zod';
import { authenticate } from '../../middleware/auth';
import { authRateLimiter } from '../../middleware/rateLimit';
import { validate } from '../../middleware/validate';
import { asyncHandler } from '../../utils/asyncHandler';
import { MIN_PASSWORD_LENGTH } from '../../utils/password';
import * as service from './auth.service';

export const authRouter = Router();

const loginBody = z
  .object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(200) })
  .strict();
const tokenBody = z.object({ refreshToken: z.string().min(20).max(200) }).strict();
const passwordBody = z
  .object({
    currentPassword: z.string().min(1).max(200),
    newPassword: z.string().min(MIN_PASSWORD_LENGTH, `At least ${MIN_PASSWORD_LENGTH} characters`).max(200),
  })
  .strict();

authRouter.post(
  '/login',
  authRateLimiter,
  validate({ body: loginBody }),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body as z.infer<typeof loginBody>;
    res.json(await service.login(email, password, req.ip));
  }),
);

authRouter.post(
  '/refresh',
  validate({ body: tokenBody }),
  asyncHandler(async (req, res) => {
    res.json(await service.refresh((req.body as z.infer<typeof tokenBody>).refreshToken));
  }),
);

authRouter.post(
  '/logout',
  validate({ body: tokenBody }),
  asyncHandler(async (req, res) => {
    await service.logout((req.body as z.infer<typeof tokenBody>).refreshToken);
    res.status(204).end();
  }),
);

authRouter.get(
  '/me',
  authenticate,
  asyncHandler(async (req, res) => {
    res.json(await service.me(req.user!.id));
  }),
);

authRouter.post(
  '/change-password',
  authenticate,
  validate({ body: passwordBody }),
  asyncHandler(async (req, res) => {
    const b = req.body as z.infer<typeof passwordBody>;
    await service.changePassword(req.user!.id, b.currentPassword, b.newPassword, req.ip);
    res.status(204).end();
  }),
);
