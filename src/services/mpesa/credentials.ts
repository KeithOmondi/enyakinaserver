import { env } from '../../config/env';
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

export function credsFor(businessCode?: string): DarajaCreds | null {
  const ownShortcode = own(businessCode, 'SHORTCODE');
  // Once ANY business has its own Till configured, a business without one gets NO prompts. It must
  // never fall back to the shared shortcode, or its customers' money would land in another Till.
  if (!ownShortcode && businessCode && configuredPrefixes().length > 0) return null;
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

/** The mode for one business: in daraja mode a business without complete credentials has prompts off. */
export function mpesaModeFor(businessCode?: string): MpesaMode {
  const mode = mpesaMode();
  return mode === 'daraja' && !credsFor(businessCode) ? 'off' : mode;
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
