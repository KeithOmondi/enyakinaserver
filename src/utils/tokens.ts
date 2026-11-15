import { createHash, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from './AppError';

export interface AccessClaims {
  sub: string;
  email: string;
  name: string;
  sa: boolean;
}

export function signAccessToken(claims: AccessClaims): string {
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, {
    algorithm: 'HS256',
    expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'],
  });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    const p = jwt.verify(token, env.JWT_ACCESS_SECRET, { algorithms: ['HS256'] });
    if (typeof p === 'string' || typeof p.sub !== 'string') throw new Error('bad payload');
    return p as unknown as AccessClaims;
  } catch {
    // Expired and tampered tokens look the same to the client: refresh, then log in again.
    throw AppError.unauthorized('Invalid or expired token');
  }
}

/** Opaque random refresh token. Only its SHA-256 is stored. */
export function newRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

export function hashRefreshToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
