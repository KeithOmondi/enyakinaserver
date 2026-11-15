import type { RequestHandler } from 'express';
import type { ZodTypeAny } from 'zod';
import { AppError } from '../utils/AppError';

export interface RequestSchemas {
  body?: ZodTypeAny;
  query?: ZodTypeAny;
  params?: ZodTypeAny;
}

/**
 * Validates and REPLACES req.body / req.query / req.params with the parsed output,
 * so controllers only ever see typed, coerced, stripped data.
 * Use .strict() on body schemas where unknown keys (e.g. business_id) must be rejected.
 */
export function validate(schemas: RequestSchemas): RequestHandler {
  return (req, _res, next) => {
    const issues: { location: string; path: string; message: string }[] = [];

    for (const location of ['params', 'query', 'body'] as const) {
      const schema = schemas[location];
      if (!schema) continue;
      const result = schema.safeParse(req[location]);
      if (result.success) {
        if (location === 'query') {
          // req.query is a getter in Express 5; define it so this works on 4 and 5.
          Object.defineProperty(req, 'query', { value: result.data, writable: true });
        } else {
          req[location] = result.data;
        }
      } else {
        for (const issue of result.error.issues) {
          issues.push({ location, path: issue.path.join('.'), message: issue.message });
        }
      }
    }

    if (issues.length) return next(AppError.validation(issues));
    next();
  };
}
