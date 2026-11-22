import { query } from '../../config/db';
import { env } from '../../config/env';
import { decryptSecret } from '../../utils/secretbox';
import { mpesaMode, type MpesaMode } from './types';

/**
 * Daraja credentials for one business. Each business can have its own Till or Paybill, set in
 * the server environment with the business code as a prefix:
 *
 *   MPESA_GO_FISH_SHORTCODE / _PASSKEY / _PARTY_B / _TRANSACTION_TYPE  (and optionally
 *   _CONSUMER_KEY / _CONSUMER_SECRET if it has its own Daraja app)
 *   MPESA_ENYAKIN_SHORTCODE ...
 *
 * The consumer key and secret fall back to the shared MPESA_CONSUMER_* (one Daraja app can serve
 * several Tills). A business with its own shortcode NEVER inherits another Till's passkey or
 * party number. If no business has settings of its own, the shared MPESA_* values apply to every business.
 * As soon as one business has its own, the others have prompts OFF (typed codes only).
 */
export interface DarajaCreds {
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  partyB: string;
  type: 'till' | 'paybill';
}

export const prefixFor = (businessCode: string): string => businessCode.toUpperCase().replace(/[^A-Z0-9]+/g, '_');

const own = (businessCode: string | undefined, name: string): string | undefined => {
  if (!businessCode) return undefined;
  return process.env[`MPESA_${prefixFor(businessCode)}_${name}`]?.trim() || undefined;
};

export function credsFor(businessCode?: string, othersHaveOwn = false): DarajaCreds | null {
  const ownShortcode = own(businessCode, 'SHORTCODE');
  // Once ANY business has its own Till configured, a business without one gets NO prompts. It must
  // never fall back to the shared shortcode, or its customers' money would land in another Till.
  if (!ownShortcode && businessCode && (othersHaveOwn || configuredPrefixes().length > 0)) return null;
  const shortcode = ownShortcode ?? env.MPESA_SHORTCODE;
  // The passkey belongs to a specific shortcode: only borrow the shared one with the shared shortcode.
  const passkey = ownShortcode ? own(businessCode, 'PASSKEY') : env.MPESA_PASSKEY;
  const consumerKey = own(businessCode, 'CONSUMER_KEY') ?? env.MPESA_CONSUMER_KEY;
  const consumerSecret = own(businessCode, 'CONSUMER_SECRET') ?? env.MPESA_CONSUMER_SECRET;
  if (!shortcode || !passkey || !consumerKey || !consumerSecret) return null;
  const rawType = ownShortcode ? (own(businessCode, 'TRANSACTION_TYPE') ?? 'till') : env.MPESA_TRANSACTION_TYPE;
  const type = rawType === 'paybill' ? 'paybill' : 'till';
  const partyB = ownShortcode ? (own(businessCode, 'PARTY_B') ?? ownShortcode) : (env.MPESA_PARTY_B ?? shortcode);
  return { consumerKey, consumerSecret, shortcode, passkey, partyB, type };
}

// ---- dashboard settings (stored in the database) ------------------------------------------------

interface SettingsRow {
  businessId: string;
  enabled: boolean;
  transactionType: 'till' | 'paybill';
  shortcode: string;
  partyB: string | null;
  passkeyEnc: string;
  consumerKeyEnc: string | null;
  consumerSecretEnc: string | null;
}

const TTL_MS = 30_000;
let rowCache = new Map<string, { at: number; row: SettingsRow | null }>();
let anyCache: { at: number; value: boolean } | null = null;

/** Call after the settings change so the new values apply immediately. */
export function clearCredentialCache(): void {
  rowCache = new Map();
  anyCache = null;
}

export async function loadSettingsRow(businessId: string): Promise<SettingsRow | null> {
  const hit = rowCache.get(businessId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.row;
  const [row] = await query<SettingsRow>(
    `SELECT business_id, enabled, transaction_type, shortcode, party_b, passkey_enc, consumer_key_enc, consumer_secret_enc
       FROM mpesa_settings WHERE business_id = $1`,
    [businessId],
  );
  rowCache.set(businessId, { at: Date.now(), row: row ?? null });
  return row ?? null;
}

async function anyDashboardSettings(): Promise<boolean> {
  if (anyCache && Date.now() - anyCache.at < TTL_MS) return anyCache.value;
  const [r] = await query<{ n: number }>('SELECT count(*)::int AS n FROM mpesa_settings');
  anyCache = { at: Date.now(), value: (r?.n ?? 0) > 0 };
  return anyCache.value;
}

/**
 * The Daraja credentials a business pays through. Dashboard settings win; otherwise the
 * environment (per-business MPESA_<CODE>_* values, or the shared MPESA_* when no business has
 * its own). Returns null when the business has none, or has switched prompts off.
 */
export async function resolveCreds(businessId: string): Promise<DarajaCreds | null> {
  const row = await loadSettingsRow(businessId);
  if (row) {
    if (!row.enabled) return null;
    const consumerKey = row.consumerKeyEnc ? decryptSecret(row.consumerKeyEnc) : env.MPESA_CONSUMER_KEY;
    const consumerSecret = row.consumerSecretEnc ? decryptSecret(row.consumerSecretEnc) : env.MPESA_CONSUMER_SECRET;
    if (!consumerKey || !consumerSecret) return null;
    return {
      consumerKey,
      consumerSecret,
      shortcode: row.shortcode,
      passkey: decryptSecret(row.passkeyEnc),
      type: row.transactionType,
      partyB: row.transactionType === 'till' ? (row.partyB ?? row.shortcode) : row.shortcode,
    };
  }
  const [b] = await query<{ code: string }>('SELECT code FROM businesses WHERE id = $1', [businessId]);
  return credsFor(b?.code, await anyDashboardSettings());
}

/** The mode for one business: in daraja mode a business without usable credentials has prompts off. */
export async function mpesaModeForBusiness(businessId: string): Promise<MpesaMode> {
  const mode = mpesaMode();
  if (mode !== 'daraja') return mode;
  return (await resolveCreds(businessId).catch(() => null)) ? 'daraja' : 'off';
}

/** Business-code prefixes that have their own M-Pesa settings in the environment. */
export function configuredPrefixes(): string[] {
  const found = new Set<string>();
  for (const key of Object.keys(process.env)) {
    const m = /^MPESA_(.+)_(SHORTCODE|PASSKEY)$/.exec(key);
    if (m) found.add(m[1]!);
  }
  return [...found];
}
