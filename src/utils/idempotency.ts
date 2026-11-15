import type { Request } from 'express';
import { AppError } from './AppError';

/**
 * Reads the Idempotency-Key header. Clients generate one key per user action (one
 * checkout, one stock receipt) and resend the same key when a request is retried, so a
 * dropped connection can never record the same sale twice.
 */
export function idempotencyKey(req: Request, required: boolean): string | null {
  const key = req.header('Idempotency-Key')?.trim();
  if (!key) {
    if (required) throw AppError.badRequest('Idempotency-Key header is required');
    return null;
  }
  if (key.length < 8 || key.length > 100) {
    throw AppError.badRequest('Idempotency-Key must be 8 to 100 characters');
  }
  return key;
}
