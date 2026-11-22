import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env';
import { AppError } from './AppError';

/**
 * Encrypts small secrets (API keys) for storage. AES-256-GCM with a random nonce per value; the
 * key is derived from SETTINGS_ENCRYPTION_KEY, which lives only in the server environment.
 * Format: v1.<nonce>.<tag>.<ciphertext> (base64url).
 */
const b64 = (b: Buffer) => b.toString('base64url');

export function secretBoxReady(): boolean {
  return Boolean(env.SETTINGS_ENCRYPTION_KEY);
}

function key(): Buffer {
  if (!env.SETTINGS_ENCRYPTION_KEY) {
    throw AppError.conflict('Saving keys is not enabled: set SETTINGS_ENCRYPTION_KEY on the server first');
  }
  return createHash('sha256').update(`settings-secretbox:${env.SETTINGS_ENCRYPTION_KEY}`).digest();
}

export function encryptSecret(plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(), iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return `v1.${b64(iv)}.${b64(cipher.getAuthTag())}.${b64(ct)}`;
}

export function decryptSecret(box: string): string {
  const [v, iv, tag, ct] = box.split('.');
  if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Unreadable stored secret');
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}
