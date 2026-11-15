/**
 * The only error type services should throw for expected failures.
 * The error handler turns it into:
 *   { "error": { "code": "...", "message": "...", "details"?: ... } }
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'VALIDATION_ERROR'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'INSUFFICIENT_STOCK'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR';

export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: unknown) {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }
  static validation(details: unknown, message = 'Request validation failed') {
    return new AppError(422, 'VALIDATION_ERROR', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new AppError(401, 'UNAUTHORIZED', message);
  }
  static forbidden(message = 'You do not have permission to do this') {
    return new AppError(403, 'FORBIDDEN', message);
  }
  /** Also used for resources in another tenant, so their existence is not revealed. */
  static notFound(entity = 'Resource') {
    return new AppError(404, 'NOT_FOUND', `${entity} not found`);
  }
  static conflict(message: string, details?: unknown) {
    return new AppError(409, 'CONFLICT', message, details);
  }
}
