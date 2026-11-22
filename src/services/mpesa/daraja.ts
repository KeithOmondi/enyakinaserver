import { env } from '../../config/env';
import { credsFor, resolveCreds } from './credentials';
import { AppError } from '../../utils/AppError';
import { outcomeFromResult, type MpesaProvider, type StkOutcome } from './types';

/**
 * Safaricom Daraja "M-Pesa Express" (STK Push).
 * Docs: https://developer.safaricom.co.ke/APIs/MpesaExpressSimulate
 * Sandbox: MPESA_ENV=sandbox (shortcode 174379 and the published sandbox passkey).
 */
const BASE = { sandbox: 'https://sandbox.safaricom.co.ke', production: 'https://api.safaricom.co.ke' } as const;

interface Config {
  consumerKey: string;
  consumerSecret: string;
  shortcode: string;
  passkey: string;
  partyB: string;
  type: 'till' | 'paybill';
  baseUrl: string;
}

async function config(businessId?: string): Promise<Config> {
  const c = businessId ? await resolveCreds(businessId) : credsFor(undefined);
  if (!c) throw new AppError(409, 'CONFLICT', 'M-Pesa prompts are not set up for this business yet');
  return { ...c, baseUrl: BASE[env.MPESA_ENV] };
}

/** Asks Safaricom for an access token: proves the consumer key and secret work, moves no money. */
export async function checkCredentials(c: { consumerKey: string; consumerSecret: string }): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`${BASE[env.MPESA_ENV]}/oauth/v1/generate?grant_type=client_credentials`, {
      headers: { Authorization: `Basic ${Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString('base64')}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) return { ok: true, message: `Safaricom accepted the key and secret (${env.MPESA_ENV}).` };
    return { ok: false, message: `Safaricom rejected the key and secret (HTTP ${res.status}). Check they are the ${env.MPESA_ENV} ones.` };
  } catch {
    return { ok: false, message: 'Could not reach Safaricom. Try again in a moment.' };
  }
}

/** YYYYMMDDHHmmss in East Africa Time, as Daraja expects. */
export function darajaTimestamp(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}${get('month')}${get('day')}${get('hour')}${get('minute')}${get('second')}`;
}

export function darajaPassword(shortcode: string, passkey: string, timestamp: string): string {
  return Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
}

// One access token per Daraja app (consumer key), since each business may use its own.
const tokens = new Map<string, { value: string; expiresAt: number }>();

async function accessToken(c: Config): Promise<string> {
  const cached = tokens.get(c.consumerKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.value;
  const res = await fetch(`${c.baseUrl}/oauth/v1/generate?grant_type=client_credentials`, {
    headers: { Authorization: `Basic ${Buffer.from(`${c.consumerKey}:${c.consumerSecret}`).toString('base64')}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.error('[mpesa] could not get a Daraja access token, HTTP', res.status);
    throw new AppError(502, 'INTERNAL_ERROR', 'Could not reach M-Pesa. Check the Daraja credentials on the server.');
  }
  const body = (await res.json()) as { access_token: string; expires_in: string };
  tokens.set(c.consumerKey, { value: body.access_token, expiresAt: Date.now() + Number(body.expires_in) * 1000 });
  return body.access_token;
}

async function post<T>(c: Config, path: string, body: unknown): Promise<{ status: number; data: T }> {
  const res = await fetch(`${c.baseUrl}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await accessToken(c)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as T };
}

export function createDaraja(): MpesaProvider {
  return {
    mode: 'daraja',
    timeoutSeconds: 90,

    async stkPush(input) {
      const c = await config(input.businessId);
      const timestamp = darajaTimestamp();
      const { status, data } = await post<{
        MerchantRequestID?: string; CheckoutRequestID?: string; ResponseCode?: string; errorMessage?: string; ResponseDescription?: string;
      }>(c, '/mpesa/stkpush/v1/processrequest', {
        BusinessShortCode: c.shortcode,
        Password: darajaPassword(c.shortcode, c.passkey, timestamp),
        Timestamp: timestamp,
        TransactionType: c.type === 'till' ? 'CustomerBuyGoodsOnline' : 'CustomerPayBillOnline',
        Amount: input.amountKes,
        PartyA: input.phone,
        PartyB: c.type === 'till' ? c.partyB : c.shortcode,
        PhoneNumber: input.phone,
        CallBackURL: input.callbackUrl,
        AccountReference: input.accountRef.slice(0, 12),
        TransactionDesc: input.description.slice(0, 13),
      });
      if (status >= 400 || data.ResponseCode !== '0' || !data.CheckoutRequestID) {
        console.error('[mpesa] STK push rejected:', status, data.errorMessage ?? data.ResponseDescription);
        throw new AppError(502, 'INTERNAL_ERROR', `M-Pesa did not accept the request${data.errorMessage ? `: ${data.errorMessage}` : ''}`);
      }
      return { providerRequestId: data.CheckoutRequestID, merchantRequestId: data.MerchantRequestID ?? null };
    },

    async query(providerRequestId, businessId): Promise<StkOutcome> {
      const c = await config(businessId);
      const timestamp = darajaTimestamp();
      const { data } = await post<{ ResultCode?: string | number; ResultDesc?: string; errorCode?: string }>(
        c,
        '/mpesa/stkpushquery/v1/query',
        {
          BusinessShortCode: c.shortcode,
          Password: darajaPassword(c.shortcode, c.passkey, timestamp),
          Timestamp: timestamp,
          CheckoutRequestID: providerRequestId,
        },
      );
      // While the customer is still deciding Daraja answers with an error body (no ResultCode).
      if (data.ResultCode === undefined) return { state: 'pending' };
      // The query API confirms success but, unlike the callback, does not return the receipt number.
      return outcomeFromResult(Number(data.ResultCode), data.ResultDesc ?? '', null);
    },
  };
}
