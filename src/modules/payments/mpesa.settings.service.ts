import { query } from '../../config/db';
import { env } from '../../config/env';
import { audit, type AuditEntry } from '../../services/audit';
import { clearCredentialCache, resolveCreds } from '../../services/mpesa/credentials';
import { checkCredentials } from '../../services/mpesa/daraja';
import { mpesaMode } from '../../services/mpesa/types';
import { AppError } from '../../utils/AppError';
import { verifyPassword } from '../../utils/password';
import { decryptSecret, encryptSecret, secretBoxReady } from '../../utils/secretbox';

interface Row {
  enabled: boolean;
  transactionType: 'till' | 'paybill';
  shortcode: string;
  partyB: string | null;
  passkeyEnc: string;
  consumerKeyEnc: string | null;
  consumerSecretEnc: string | null;
  updatedAt: Date;
  updatedByName: string | null;
}

const sharedConsumer = () => Boolean(env.MPESA_CONSUMER_KEY && env.MPESA_CONSUMER_SECRET);

async function loadRow(businessId: string): Promise<Row | null> {
  const [row] = await query<Row>(
    `SELECT s.enabled, s.transaction_type, s.shortcode, s.party_b, s.passkey_enc, s.consumer_key_enc,
            s.consumer_secret_enc, s.updated_at, u.name AS updated_by_name
       FROM mpesa_settings s LEFT JOIN users u ON u.id = s.updated_by
      WHERE s.business_id = $1`,
    [businessId],
  );
  return row ?? null;
}

/** Last four characters of a stored secret, so the admin can recognise it. Never the secret itself. */
function hint(box: string | null): string | null {
  if (!box) return null;
  try {
    const plain = decryptSecret(box);
    return `••••${plain.slice(-4)}`;
  } catch {
    return '••••';
  }
}

/** What the dashboard shows. Secrets are never included. */
export async function getSettings(businessId: string) {
  const row = await loadRow(businessId);
  const resolved = row ? null : await resolveCreds(businessId).catch(() => null);
  return {
    serverMode: mpesaMode(),
    environment: env.MPESA_ENV,
    encryptionReady: secretBoxReady(),
    sharedConsumerAvailable: sharedConsumer(),
    /** dashboard: saved here. server: coming from the server settings. none: not set up. */
    source: row ? ('dashboard' as const) : resolved ? ('server' as const) : ('none' as const),
    configured: Boolean(row),
    enabled: row?.enabled ?? true,
    transactionType: row?.transactionType ?? ('paybill' as const),
    shortcode: row?.shortcode ?? '',
    partyB: row?.partyB ?? '',
    passkeyHint: hint(row?.passkeyEnc ?? null),
    consumerKeyHint: hint(row?.consumerKeyEnc ?? null),
    hasConsumerSecret: Boolean(row?.consumerSecretEnc),
    updatedAt: row?.updatedAt ?? null,
    updatedByName: row?.updatedByName ?? null,
  };
}

async function confirmPassword(userId: string, password: string): Promise<void> {
  const [u] = await query<{ passwordHash: string }>('SELECT password_hash FROM users WHERE id = $1', [userId]);
  if (!u || !(await verifyPassword(password, u.passwordHash))) {
    throw AppError.validation([{ path: 'password', message: 'That is not your password' }]);
  }
}

export interface SaveInput {
  enabled: boolean;
  transactionType: 'till' | 'paybill';
  shortcode: string;
  partyB?: string | null | undefined;
  passkey?: string | undefined;
  consumerKey?: string | undefined;
  consumerSecret?: string | undefined;
  password: string;
}

export async function saveSettings(businessId: string, userId: string, input: SaveInput, entry: AuditEntry) {
  await confirmPassword(userId, input.password);
  const existing = await loadRow(businessId);

  if (Boolean(input.consumerKey) !== Boolean(input.consumerSecret)) {
    throw AppError.validation([{ path: 'consumerSecret', message: 'Enter the consumer key and the consumer secret together' }]);
  }
  if (!existing && !input.passkey) {
    throw AppError.validation([{ path: 'passkey', message: 'Enter the passkey Safaricom issued for this shortcode' }]);
  }
  if (!existing && !input.consumerKey && !sharedConsumer()) {
    throw AppError.validation([{ path: 'consumerKey', message: 'Enter the consumer key and secret from your Daraja app' }]);
  }
  if (input.transactionType === 'till' && !input.partyB && !input.shortcode) {
    throw AppError.validation([{ path: 'partyB', message: 'Enter the Till number' }]);
  }
  // A new shortcode needs its own passkey: a passkey only works with the shortcode it was issued for.
  if (existing && existing.shortcode !== input.shortcode && !input.passkey) {
    throw AppError.validation([{ path: 'passkey', message: 'You changed the shortcode: enter its passkey too' }]);
  }

  const passkeyEnc = input.passkey ? encryptSecret(input.passkey) : existing!.passkeyEnc;
  const keyEnc = input.consumerKey ? encryptSecret(input.consumerKey) : (existing?.consumerKeyEnc ?? null);
  const secretEnc = input.consumerSecret ? encryptSecret(input.consumerSecret) : (existing?.consumerSecretEnc ?? null);

  await query(
    `INSERT INTO mpesa_settings (business_id, enabled, transaction_type, shortcode, party_b, passkey_enc,
                                 consumer_key_enc, consumer_secret_enc, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (business_id) DO UPDATE SET
       enabled = EXCLUDED.enabled, transaction_type = EXCLUDED.transaction_type, shortcode = EXCLUDED.shortcode,
       party_b = EXCLUDED.party_b, passkey_enc = EXCLUDED.passkey_enc, consumer_key_enc = EXCLUDED.consumer_key_enc,
       consumer_secret_enc = EXCLUDED.consumer_secret_enc, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [businessId, input.enabled, input.transactionType, input.shortcode, input.partyB || null, passkeyEnc, keyEnc, secretEnc, userId],
  );
  clearCredentialCache();

  // Record what changed, never the values of the secrets.
  const changed = [
    !existing && 'created',
    existing && existing.enabled !== input.enabled && (input.enabled ? 'enabled' : 'disabled'),
    existing && existing.transactionType !== input.transactionType && 'type',
    existing && existing.shortcode !== input.shortcode && 'shortcode',
    existing && (existing.partyB ?? '') !== (input.partyB ?? '') && 'partyB',
    input.passkey && 'passkey',
    input.consumerKey && 'consumerKey',
    input.consumerSecret && 'consumerSecret',
  ].filter(Boolean);
  await audit({ ...entry, entityId: businessId, details: { changed, shortcode: input.shortcode, transactionType: input.transactionType } });
  return getSettings(businessId);
}

/** Removes the dashboard settings: the business goes back to the server's settings, if any. */
export async function deleteSettings(businessId: string, userId: string, password: string, entry: AuditEntry) {
  await confirmPassword(userId, password);
  await query('DELETE FROM mpesa_settings WHERE business_id = $1', [businessId]);
  clearCredentialCache();
  await audit({ ...entry, entityId: businessId, details: { removed: true } });
  return getSettings(businessId);
}

/** Checks the saved consumer key and secret with Safaricom. No money moves. */
export async function testSettings(businessId: string) {
  const creds = await resolveCreds(businessId).catch(() => null);
  if (!creds) throw AppError.conflict('Nothing to test yet: save the settings first (and make sure they are switched on)');
  return checkCredentials(creds);
}
