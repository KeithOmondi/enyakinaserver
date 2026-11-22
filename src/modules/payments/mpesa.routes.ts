import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { env, isTest } from '../../config/env';
import { ctx, requireRole, tenantAuth } from '../../middleware/auth';
import { validate } from '../../middleware/validate';
import { auditFromReq } from '../../services/audit';
import { asyncHandler } from '../../utils/asyncHandler';
import { pageQuery, queryBool, uuid } from '../../utils/pagination';
import * as service from './mpesa.service';
import * as settings from './mpesa.settings.service';

export const mpesaRouter = Router();

// Safaricom -> us. No login (it is a machine call); protected by the signed address instead.
// Always answers 200 so Safaricom does not keep retrying; a bad signature gets a plain 404.
mpesaRouter.post(
  '/callback/:id/:signature',
  asyncHandler(async (req, res) => {
    const id = req.params.id!;
    if (!uuid.safeParse(id).success || !service.signatureValid(id, req.params.signature ?? '')) {
      return void res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }
    await service.processCallback(id, req.body);
    res.json({ ResultCode: 0, ResultDesc: 'Accepted' });
  }),
);

const sendLimiter = rateLimit({
  windowMs: 60_000,
  limit: 20,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many payment prompts. Wait a moment.' } },
});

const idParams = z.object({ id: uuid });
const createBody = z
  .object({
    phone: z.string().trim().min(9).max(20),
    amountCents: z.number().int().min(1).max(25_000_000),
    requestKey: z.string().trim().min(8).max(100).optional(),
  })
  .strict();
const listQuery = z.object({
  status: z.enum(['pending', 'paid', 'failed', 'cancelled', 'timeout']).optional(),
  unmatched: queryBool.optional(),
  ...pageQuery,
});

// Which payment mode is active (the till uses this to show or hide the prompt button).
mpesaRouter.get('/mode', ...tenantAuth, asyncHandler(async (req, res) => {
  res.json({ mode: await service.modeForBusiness(ctx(req).businessId) });
}));

// ---- connection settings (entered in the dashboard) ---------------------------------------------
// Secrets are write-only: they are encrypted on the way in and never sent back.

const settingsLimiter = rateLimit({
  windowMs: 60_000,
  limit: 15,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts. Wait a moment.' } },
});
const settingsRole = () => requireRole(env.MPESA_SETTINGS_REQUIRE_SUPER_ADMIN ? 'super_admin' : 'admin');
const digits = z.string().trim().regex(/^\d{4,10}$/, 'Digits only, 4 to 10 long');
const settingsBody = z
  .object({
    enabled: z.boolean(),
    transactionType: z.enum(['till', 'paybill']),
    shortcode: digits,
    partyB: digits.nullable().optional(),
    passkey: z.string().trim().min(20, 'That passkey looks too short').max(300).optional(),
    consumerKey: z.string().trim().min(10, 'That key looks too short').max(200).optional(),
    consumerSecret: z.string().trim().min(10, 'That secret looks too short').max(300).optional(),
    password: z.string().min(1, 'Enter your password to confirm').max(200),
  })
  .strict();
const passwordBody = z.object({ password: z.string().min(1).max(200) }).strict();

mpesaRouter.get(
  '/settings',
  ...tenantAuth,
  settingsRole(),
  asyncHandler(async (req, res) => {
    res.json(await settings.getSettings(ctx(req).businessId));
  }),
);

mpesaRouter.put(
  '/settings',
  settingsLimiter,
  ...tenantAuth,
  settingsRole(),
  validate({ body: settingsBody }),
  asyncHandler(async (req, res) => {
    const { businessId, userId } = ctx(req);
    res.json(await settings.saveSettings(businessId, userId, req.body as z.infer<typeof settingsBody>, auditFromReq(req, 'mpesa_settings_updated', 'business')));
  }),
);

mpesaRouter.post(
  '/settings/remove',
  settingsLimiter,
  ...tenantAuth,
  settingsRole(),
  validate({ body: passwordBody }),
  asyncHandler(async (req, res) => {
    const { businessId, userId } = ctx(req);
    res.json(await settings.deleteSettings(businessId, userId, (req.body as z.infer<typeof passwordBody>).password, auditFromReq(req, 'mpesa_settings_removed', 'business')));
  }),
);

mpesaRouter.post(
  '/settings/test',
  settingsLimiter,
  ...tenantAuth,
  settingsRole(),
  asyncHandler(async (req, res) => {
    res.json(await settings.testSettings(ctx(req).businessId));
  }),
);

// Admin log: every prompt, with "paid but not on any sale" flagged.
mpesaRouter.get(
  '/requests',
  ...tenantAuth,
  requireRole('admin'),
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    res.json(await service.listRequests(ctx(req).businessId, req.query as unknown as z.infer<typeof listQuery>));
  }),
);

// Send a prompt to the customer's phone. Admins and shop managers both can: it is part of selling.
mpesaRouter.post(
  '/requests',
  sendLimiter,
  ...tenantAuth,
  validate({ body: createBody }),
  asyncHandler(async (req, res) => {
    const { businessId, userId } = ctx(req);
    const body = req.body as z.infer<typeof createBody>;
    res.status(201).json(await service.createRequest(businessId, userId, body, auditFromReq(req, 'mpesa_prompt_sent', 'mpesa_request')));
  }),
);

// The till polls this while the customer decides.
mpesaRouter.get(
  '/requests/:id',
  ...tenantAuth,
  validate({ params: idParams }),
  asyncHandler(async (req, res) => {
    res.json(await service.getRequest(ctx(req).businessId, req.params.id!));
  }),
);
