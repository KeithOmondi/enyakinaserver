import rateLimit from 'express-rate-limit';
import { env, isTest } from '../config/env';

const rateLimitedBody = {
  error: { code: 'RATE_LIMITED', message: 'Too many attempts. Please try again later.' },
};

/** Applied to /api/auth/login and /api/auth/refresh. */
export const authRateLimiter = rateLimit({
  windowMs: env.AUTH_RATE_LIMIT_WINDOW_MS,
  limit: env.AUTH_RATE_LIMIT_MAX,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: rateLimitedBody,
});

/** Generous global limit to blunt runaway clients; the API is internal. */
export const apiRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 600,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skip: () => isTest,
  message: rateLimitedBody,
});
