import cors from 'cors';
import express, { type Express } from 'express';
import helmet from 'helmet';
import { env } from './config/env';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { apiRateLimiter } from './middleware/rateLimit';
import { apiRouter } from './routes';
import { AppError } from './utils/AppError';

export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', env.TRUST_PROXY);

  app.use(helmet());
  app.use(
    cors({
      origin(origin, cb) {
        // Non-browser clients (curl, server-to-server) send no Origin header.
        if (!origin || env.CORS_ORIGINS.includes(origin)) return cb(null, true);
        cb(AppError.forbidden('Origin not allowed'));
      },
      credentials: true,
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Business-Id', 'Idempotency-Key'],
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      maxAge: 600,
    }),
  );
  app.use(express.json({ limit: '100kb' }));

  // API responses carry live stock, prices and business data: never let a browser,
  // proxy or service worker reuse them.
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });

  app.use('/api', apiRateLimiter, apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
