import 'dotenv/config';
import { z } from 'zod';

/** Parses "true"/"false"/"1"/"0" strictly; z.coerce.boolean() would treat "false" as true. */
const boolString = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

/** An empty value in .env (KEY=) counts as not set. */
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  DATABASE_URL: z.string().url(),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),
  DB_SSL: boolString.default('false'),

  JWT_ACCESS_SECRET: z.string().min(32, 'JWT_ACCESS_SECRET must be at least 32 characters'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_ACCESS_TTL: z
    .string()
    .regex(/^\d+[smhd]$/, 'JWT_ACCESS_TTL must look like 15m, 1h, 30s or 1d')
    .default('15m'),
  JWT_REFRESH_TTL_DAYS: z.coerce.number().int().positive().default(7),
  BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

  CORS_ORIGINS: z
    .string()
    .default('')
    .transform((s) =>
      s
        .split(',')
        .map((o) => o.trim())
        .filter(Boolean),
    ),
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  AUTH_RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
  AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),

  BUSINESS_TIMEZONE: z.string().default('Africa/Nairobi'),
  ENABLE_SUPER_ADMIN: boolString.default('false'),

  // M-Pesa STK Push (customer-phone payment prompts).
  //   off        manual codes only (the default in production)
  //   simulator  pretends to be Safaricom, for development and demos (the default in development)
  //   daraja     the real Safaricom Daraja API
  MPESA_MODE: z.enum(['off', 'simulator', 'daraja']).optional(),
  MPESA_ENV: z.enum(['sandbox', 'production']).default('sandbox'),
  MPESA_CONSUMER_KEY: optional(z.string().trim().min(1)),
  MPESA_CONSUMER_SECRET: optional(z.string().trim().min(1)),
  MPESA_SHORTCODE: optional(z.string().trim().regex(/^\d{4,10}$/, 'MPESA_SHORTCODE must be the numeric business shortcode')),
  MPESA_PASSKEY: optional(z.string().trim().min(1)),
  /** till = Buy Goods (Lipa na M-Pesa Till); paybill = Pay Bill. */
  MPESA_TRANSACTION_TYPE: z.enum(['till', 'paybill']).default('till'),
  /** The till number for Buy Goods when it differs from the shortcode. Defaults to the shortcode. */
  MPESA_PARTY_B: optional(z.string().trim().regex(/^\d{4,10}$/, 'MPESA_PARTY_B must be numeric')),
  /** Public https origin of this API as Safaricom sees it, e.g. https://api.example.com */
  MPESA_CALLBACK_BASE_URL: optional(z.string().trim().url().transform((u) => u.replace(/\/+$/, ''))),
  MPESA_SIM_DELAY_MS: z.coerce.number().int().min(0).default(4000),
  MPESA_SIM_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(25),

  // Cloudflare R2 (product photos). All five or none.
  R2_ACCOUNT_ID: optional(
    z
      .string()
      .trim()
      .regex(/^[a-f0-9]{32}$/i, 'R2_ACCOUNT_ID must be the 32-character account id from the R2 overview page, not a URL'),
  ),
  R2_ACCESS_KEY_ID: optional(z.string().trim().min(1)),
  R2_SECRET_ACCESS_KEY: optional(z.string().trim().min(1)),
  R2_BUCKET: optional(
    z
      .string()
      .trim()
      .regex(/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/, 'R2_BUCKET must be just the bucket name, e.g. enyakin-public, not a URL'),
  ),
  R2_PUBLIC_URL: optional(
    z
      .string()
      .trim()
      .url('R2_PUBLIC_URL must be a full URL, e.g. https://pub-xxxx.r2.dev or https://images.example.com')
      .refine(
        (u) => !new URL(u).hostname.endsWith('.r2.cloudflarestorage.com'),
        'R2_PUBLIC_URL cannot be the S3 API address (r2.cloudflarestorage.com): browsers cannot load images from it. ' +
          'Enable public access on the bucket and use its r2.dev URL or a custom domain',
      )
      .transform((u) => u.replace(/\/+$/, '')),
  ),
})
  .superRefine((env, ctx) => {
    if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_REFRESH_SECRET'],
        message: 'JWT_REFRESH_SECRET must differ from JWT_ACCESS_SECRET',
      });
    }
    if (env.NODE_ENV === 'production' && env.JWT_ACCESS_SECRET.startsWith('change-me')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['JWT_ACCESS_SECRET'],
        message: 'Replace the example JWT secrets before running in production',
      });
    }
    if (env.NODE_ENV === 'production' && env.CORS_ORIGINS.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CORS_ORIGINS'],
        message: 'CORS_ORIGINS must list the admin and shop origin(s) in production',
      });
    }
    const mode = env.MPESA_MODE ?? (env.NODE_ENV === 'development' ? 'simulator' : 'off');
    if (mode === 'simulator' && env.NODE_ENV === 'production') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MPESA_MODE'],
        message: 'MPESA_MODE=simulator pretends customers paid. It must never run in production: use daraja or off',
      });
    }
    if (mode === 'daraja') {
      const missing = (
        [
          ['MPESA_CONSUMER_KEY', env.MPESA_CONSUMER_KEY],
          ['MPESA_CONSUMER_SECRET', env.MPESA_CONSUMER_SECRET],
          ['MPESA_SHORTCODE', env.MPESA_SHORTCODE],
          ['MPESA_PASSKEY', env.MPESA_PASSKEY],
          ['MPESA_CALLBACK_BASE_URL', env.MPESA_CALLBACK_BASE_URL],
        ] as const
      ).filter(([, v]) => !v);
      for (const [name] of missing) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [name], message: `${name} is required when MPESA_MODE=daraja` });
      }
      if (env.MPESA_CALLBACK_BASE_URL && env.NODE_ENV === 'production' && !env.MPESA_CALLBACK_BASE_URL.startsWith('https://')) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['MPESA_CALLBACK_BASE_URL'], message: 'Safaricom only calls https addresses' });
      }
    }
    const r2 = [env.R2_ACCOUNT_ID, env.R2_ACCESS_KEY_ID, env.R2_SECRET_ACCESS_KEY, env.R2_BUCKET, env.R2_PUBLIC_URL];
    if (r2.some(Boolean) && !r2.every(Boolean)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['R2_BUCKET'],
        message:
          'Set all of R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET and R2_PUBLIC_URL, or none of them',
      });
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: env.BUSINESS_TIMEZONE });
    } catch {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['BUSINESS_TIMEZONE'],
        message: `Unknown IANA timezone "${env.BUSINESS_TIMEZONE}"`,
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

const R2_KEYS = ['R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_BUCKET', 'R2_PUBLIC_URL'];

function loadEnv(): Env {
  let parsed = envSchema.safeParse(process.env);

  // Product photos are optional. While developing, a mistake in the R2 settings should not
  // stop the whole API: say what is wrong and carry on with photos switched off. Production
  // still refuses to start so a broken setting is never missed.
  if (!parsed.success && process.env.NODE_ENV !== 'production') {
    const issues = parsed.error.issues;
    if (issues.every((i) => i.path.some((p) => typeof p === 'string' && R2_KEYS.includes(p)))) {
      console.warn(
        `[config] Product photos are OFF because the R2 settings are invalid:\n${issues
          .map((i) => `  - ${i.message}`)
          .join('\n')}\n  Fix them in server/.env and restart to enable photos.`,
      );
      const withoutR2 = Object.fromEntries(Object.entries(process.env).filter(([k]) => !R2_KEYS.includes(k)));
      parsed = envSchema.safeParse(withoutR2);
    }
  }

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    // Fail fast at boot; never start with a half-valid config.
    console.error(`Invalid environment configuration:\n${issues}`);
    process.exit(1);
  }
  return Object.freeze(parsed.data);
}

export const env: Env = loadEnv();
export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
