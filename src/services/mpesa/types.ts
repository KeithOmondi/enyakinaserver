import { env } from '../../config/env';

export type MpesaMode = 'off' | 'simulator' | 'daraja';

/**
 * Read from process.env on every call (not the frozen config) so tests can switch modes.
 * Defaults: simulator while developing, off otherwise. The config check forbids simulator
 * in production.
 */
export function mpesaMode(): MpesaMode {
  const raw = process.env.MPESA_MODE;
  if (raw === 'off' || raw === 'simulator' || raw === 'daraja') return raw;
  return env.NODE_ENV === 'development' ? 'simulator' : 'off';
}

export interface StkPushInput {
  requestId: string;
  /** 254XXXXXXXXX */
  phone: string;
  /** Whole shillings, at least 1. */
  amountKes: number;
  /** Shown on the customer's statement (max 12 characters). */
  accountRef: string;
  /** Max 13 characters. */
  description: string;
  callbackUrl: string;
  /** Which business is being paid, so it can use its own Till. */
  businessCode?: string | undefined;
}

export interface StkPushResult {
  providerRequestId: string;
  merchantRequestId: string | null;
}

export type StkOutcome =
  | { state: 'pending' }
  | { state: 'paid'; receipt: string | null; resultCode: number; resultDesc: string }
  | { state: 'cancelled' | 'failed'; resultCode: number | null; resultDesc: string };

export interface MpesaProvider {
  mode: Exclude<MpesaMode, 'off'>;
  /** How long to wait for the customer before giving up. */
  timeoutSeconds: number;
  stkPush(input: StkPushInput): Promise<StkPushResult>;
  /** Asks the provider what happened to a prompt (used when a callback never arrived). */
  query(providerRequestId: string, businessCode?: string): Promise<StkOutcome>;
}

/** Maps a Safaricom ResultCode to an outcome. 0 = paid, 1032 = customer cancelled. */
export function outcomeFromResult(resultCode: number, resultDesc: string, receipt: string | null): StkOutcome {
  if (resultCode === 0) return { state: 'paid', receipt, resultCode, resultDesc };
  if (resultCode === 1032) return { state: 'cancelled', resultCode, resultDesc: 'The customer cancelled the prompt' };
  if (resultCode === 1037) return { state: 'failed', resultCode, resultDesc: 'The customer did not respond in time' };
  if (resultCode === 2001) return { state: 'failed', resultCode, resultDesc: 'Wrong M-Pesa PIN entered' };
  if (resultCode === 1) return { state: 'failed', resultCode, resultDesc: 'Insufficient M-Pesa balance' };
  return { state: 'failed', resultCode, resultDesc: resultDesc || 'The payment was not completed' };
}
