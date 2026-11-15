import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { isProduction } from '../config/env';
import { AppError } from '../utils/AppError';

interface ErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
    stack?: string;
  };
}

/** Postgres error codes we translate into client errors instead of 500s. */
const PG_ERRORS: Record<string, { status: number; code: AppError['code']; message: string }> = {
  '23505': { status: 409, code: 'CONFLICT', message: 'A record with these values already exists' },
  '23503': { status: 409, code: 'CONFLICT', message: 'Referenced record does not exist or is in use' },
  '23514': { status: 422, code: 'VALIDATION_ERROR', message: 'A value violates a database rule' },
  '22P02': { status: 400, code: 'BAD_REQUEST', message: 'Invalid identifier or value format' },
};

/** Friendlier text for the unique indexes users can actually hit. */
const CONSTRAINT_MESSAGES: Record<string, string> = {
  products_business_sku_key: 'Another product already uses this SKU',
  products_business_barcode_key: 'Another product already uses this barcode',
  categories_business_name_key: 'A category with this name already exists',
  suppliers_business_name_key: 'A supplier with this name already exists',
  users_email_lower_key: 'A user with this email already exists',
  user_businesses_pkey: 'This user already belongs to this business',
  daily_closings_business_id_business_date_key: 'This day has already been closed',
};

function isPgError(err: unknown): err is { code: string; constraint?: string } {
  return typeof err === 'object' && err !== null && typeof (err as { code?: unknown }).code === 'string'
    && /^[0-9A-Z]{5}$/.test((err as { code: string }).code);
}

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, next) => {
  // Response already started: Express's default handler must close the connection.
  if (res.headersSent) return next(err);

  let status = 500;
  let body: ErrorBody = { error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } };

  if (err instanceof AppError) {
    status = err.status;
    body = { error: { code: err.code, message: err.message } };
    if (err.details !== undefined) body.error.details = err.details;
  } else if (err instanceof ZodError) {
    status = 422;
    body = {
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
    };
  } else if (err?.type === 'entity.parse.failed') {
    status = 400;
    body = { error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } };
  } else if (err?.type === 'entity.too.large') {
    status = 413;
    body = { error: { code: 'BAD_REQUEST', message: 'Request body too large' } };
  } else if (
    // Other client errors raised by Express/body-parser (unsupported charset or
    // encoding, aborted request, ...) carry a 4xx status and are safe to report.
    typeof err?.status === 'number' &&
    err.status >= 400 &&
    err.status < 500 &&
    err.expose === true
  ) {
    status = err.status;
    body = { error: { code: 'BAD_REQUEST', message: String(err.message) } };
  } else if (isPgError(err) && PG_ERRORS[err.code]) {
    const mapped = PG_ERRORS[err.code]!;
    status = mapped.status;
    body = {
      error: {
        code: mapped.code,
        message: (err.constraint && CONSTRAINT_MESSAGES[err.constraint]) || mapped.message,
      },
    };
    if (!isProduction && err.constraint) body.error.details = { constraint: err.constraint };
  }

  if (status >= 500) {
    console.error(`[error] ${req.method} ${req.originalUrl}`, err);
  }
  if (!isProduction && err instanceof Error && status >= 500) {
    body.error.stack = err.stack;
  }

  res.status(status).json(body);
};
