import { DeleteObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { env } from '../config/env';

/**
 * Cloudflare R2 object storage (S3-compatible). Configured by the R2_* variables; when they
 * are absent the app runs normally and image features report "not configured".
 */
export function storageConfigured(): boolean {
  return Boolean(env.R2_ACCOUNT_ID && env.R2_ACCESS_KEY_ID && env.R2_SECRET_ACCESS_KEY && env.R2_BUCKET && env.R2_PUBLIC_URL);
}

let client: S3Client | null = null;
function s3(): S3Client {
  client ??= new S3Client({
    region: 'auto',
    endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: env.R2_ACCESS_KEY_ID!, secretAccessKey: env.R2_SECRET_ACCESS_KEY! },
    // R2 does not accept the SDK's default trailing checksums.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
  return client;
}

export async function putObject(key: string, body: Buffer, contentType: string): Promise<void> {
  await s3().send(
    new PutObjectCommand({
      Bucket: env.R2_BUCKET!,
      Key: key,
      Body: body,
      ContentType: contentType,
      // Keys contain a random id and are never overwritten, so browsers and the CDN may cache forever.
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: env.R2_BUCKET!, Key: key }));
}

/** Public URL for a stored key, or null when storage is not configured. */
export function publicUrl(key: string | null): string | null {
  if (!key || !env.R2_PUBLIC_URL) return null;
  return `${env.R2_PUBLIC_URL}/${key}`;
}
