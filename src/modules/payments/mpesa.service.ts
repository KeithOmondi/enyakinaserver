import { createHmac, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { query } from '../../config/db';
import { env } from '../../config/env';
import { withTransaction } from '../../db/transaction';
import { audit, type AuditEntry } from '../../services/audit';
import { createDaraja } from '../../services/mpesa/daraja';
import { maskPhone, normalizePhone } from '../../services/mpesa/phone';
import { createSimulator } from '../../services/mpesa/simulator';
import { mpesaMode, outcomeFromResult, type MpesaProvider, type StkOutcome } from '../../services/mpesa/types';
import { AppError } from '../../utils/AppError';
import { offsetOf } from '../../utils/pagination';

export interface MpesaRow {
  id: string;
  businessId: string;
  createdBy: string;
  phone: string;
  amountCents: number;
  status: 'pending' | 'paid' | 'failed' | 'cancelled' | 'timeout';
  requestKey: string | null;
  providerRequestId: string | null;
  merchantRequestId: string | null;
  receipt: string | null;
  resultCode: number | null;
  resultDesc: string | null;
  saleId: string | null;
  expiresAt: Date;
  createdAt: Date;
}

const MAX_KES = 250_000; // M-Pesa's per-transaction ceiling

// ---- provider -------------------------------------------------------------------------------

let cache: { mode: string; provider: MpesaProvider } | null = null;

export function getProvider(): MpesaProvider | null {
  const mode = mpesaMode();
  if (mode === 'off') return null;
  if (cache?.mode !== mode) {
    cache = { mode, provider: mode === 'daraja' ? createDaraja() : createSimulator(deliverFromProvider) };
  }
  return cache.provider;
}

// ---- callback authentication ------------------------------------------------------------------

/**
 * Safaricom does not sign its callbacks. The callback address we hand over for each prompt
 * therefore carries an HMAC of the request id: nobody who has not seen that address can
 * forge a "customer paid" message. (The amount and the CheckoutRequestID are checked too.)
 */
export function callbackSignature(requestId: string): string {
  return createHmac('sha256', `mpesa-callback:${env.JWT_ACCESS_SECRET}`).update(requestId).digest('hex');
}

export function signatureValid(requestId: string, signature: string): boolean {
  const expected = Buffer.from(callbackSignature(requestId));
  const given = Buffer.from(signature);
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function callbackUrl(requestId: string): string {
  const base = env.MPESA_CALLBACK_BASE_URL ?? `http://localhost:${env.PORT}`;
  return `${base}/api/payments/mpesa/callback/${requestId}/${callbackSignature(requestId)}`;
}

// ---- views ----------------------------------------------------------------------------------

export function view(r: MpesaRow) {
  return {
    id: r.id,
    status: r.status,
    amountCents: r.amountCents,
    phone: maskPhone(r.phone),
    receipt: r.receipt,
    resultDesc: r.resultDesc,
    expiresAt: r.expiresAt,
    saleId: r.saleId,
  };
}

const COLS = `id, business_id, created_by, phone, amount_cents, status, request_key, provider_request_id,
              merchant_request_id, receipt, result_code, result_desc, sale_id, expires_at, created_at`;

async function load(businessId: string, id: string): Promise<MpesaRow> {
  const [r] = await query<MpesaRow>(`SELECT ${COLS} FROM mpesa_requests WHERE id = $1 AND business_id = $2`, [id, businessId]);
  if (!r) throw AppError.notFound('M-Pesa request');
  return r;
}

// ---- state changes ----------------------------------------------------------------------------

/**
 * Moves a request to its final state. Only legal transitions apply, and it is safe to call
 * twice (callbacks are retried): paid is final; a late "paid" can still rescue a timeout,
 * because the customer's money has really moved.
 */
async function applyOutcome(where: { id: string } | { providerRequestId: string }, outcome: StkOutcome): Promise<MpesaRow | null> {
  if (outcome.state === 'pending') return null;
  return withTransaction(async (tx) => {
    const [row] = await query<MpesaRow>(
      `SELECT ${COLS} FROM mpesa_requests WHERE ${'id' in where ? 'id' : 'provider_request_id'} = $1 FOR UPDATE`,
      ['id' in where ? where.id : where.providerRequestId],
      tx,
    );
    if (!row) return null;
    const allowed = outcome.state === 'paid' ? row.status === 'pending' || row.status === 'timeout' : row.status === 'pending';
    if (!allowed) return row;
    const [updated] = await query<MpesaRow>(
      `UPDATE mpesa_requests
          SET status = $2, receipt = COALESCE($3, receipt), result_code = $4, result_desc = $5, updated_at = now()
        WHERE id = $1 RETURNING ${COLS}`,
      [row.id, outcome.state, outcome.state === 'paid' ? outcome.receipt : null, outcome.resultCode, outcome.resultDesc],
      tx,
    );
    if (outcome.state === 'paid') {
      await audit({ businessId: row.businessId, action: 'mpesa_payment_received', entity: 'mpesa_request', entityId: row.id,
        details: { amountCents: row.amountCents, receipt: outcome.receipt, phone: maskPhone(row.phone) } }, tx);
    }
    return updated ?? row;
  });
}

async function deliverFromProvider(providerRequestId: string, outcome: StkOutcome): Promise<void> {
  await applyOutcome({ providerRequestId }, outcome);
}

// ---- public operations ------------------------------------------------------------------------

export async function createRequest(
  businessId: string,
  userId: string,
  input: { phone: string; amountCents: number; requestKey?: string | undefined },
  entry: AuditEntry,
) {
  const provider = getProvider();
  if (!provider) throw AppError.conflict('M-Pesa prompts are not turned on for this system');

  const phone = normalizePhone(input.phone);
  if (!phone) throw AppError.validation([{ path: 'phone', message: 'Enter a Kenyan mobile number, e.g. 0712 345 678' }]);
  if (input.amountCents % 100 !== 0) {
    throw AppError.validation([{ path: 'amountCents', message: 'M-Pesa takes whole shillings only. Take the cents in cash.' }]);
  }
  if (input.amountCents < 100 || input.amountCents > MAX_KES * 100) {
    throw AppError.validation([{ path: 'amountCents', message: `M-Pesa amounts must be between KES 1 and KES ${MAX_KES.toLocaleString('en-KE')}` }]);
  }

  if (input.requestKey) {
    const [existing] = await query<MpesaRow>(
      `SELECT ${COLS} FROM mpesa_requests WHERE business_id = $1 AND request_key = $2`,
      [businessId, input.requestKey],
    );
    if (existing) return view(existing);
  }

  const [created] = await query<MpesaRow>(
    `INSERT INTO mpesa_requests (business_id, created_by, phone, amount_cents, request_key, expires_at)
     VALUES ($1, $2, $3, $4, $5, now() + make_interval(secs => $6)) RETURNING ${COLS}`,
    [businessId, userId, phone, input.amountCents, input.requestKey ?? null, provider.timeoutSeconds],
  );
  const row = created!;

  try {
    const [biz] = await query<{ name: string }>('SELECT name FROM businesses WHERE id = $1', [businessId]);
    const sent = await provider.stkPush({
      requestId: row.id,
      phone,
      amountKes: input.amountCents / 100,
      accountRef: (biz?.name ?? 'Payment').slice(0, 12),
      description: 'Payment',
      callbackUrl: callbackUrl(row.id),
    });
    await query('UPDATE mpesa_requests SET provider_request_id = $2, merchant_request_id = $3 WHERE id = $1', [
      row.id, sent.providerRequestId, sent.merchantRequestId,
    ]);
  } catch (err) {
    await query(`UPDATE mpesa_requests SET status = 'failed', result_desc = $2, updated_at = now() WHERE id = $1`, [
      row.id, err instanceof AppError ? err.message : 'The prompt could not be sent',
    ]);
    throw err;
  }
  await audit({ ...entry, entityId: row.id, details: { amountCents: input.amountCents, phone: maskPhone(phone) } });
  return view(await load(businessId, row.id));
}

/**
 * Current state of a prompt. If the callback never arrived (network blip, our server was
 * down) this asks the provider directly, and gives up with "timeout" once the prompt expired.
 */
export async function getRequest(businessId: string, id: string) {
  let row = await load(businessId, id);
  if (row.status === 'pending') {
    const provider = getProvider();
    const expired = row.expiresAt.getTime() <= Date.now();
    const ageMs = Date.now() - row.createdAt.getTime();
    if (provider && row.providerRequestId && (expired || ageMs > 15_000)) {
      const outcome = await provider.query(row.providerRequestId).catch(() => ({ state: 'pending' }) as StkOutcome);
      if (outcome.state !== 'pending') row = (await applyOutcome({ id }, outcome)) ?? row;
    }
    if (row.status === 'pending' && expired) {
      await query(
        `UPDATE mpesa_requests SET status = 'timeout', result_desc = 'No response from the customer', updated_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [id],
      );
      row = await load(businessId, id);
    }
  }
  return view(row);
}

// Safaricom's callback body. Only the fields we use are required.
const callbackBody = z.object({
  Body: z.object({
    stkCallback: z.object({
      CheckoutRequestID: z.string(),
      ResultCode: z.coerce.number(),
      ResultDesc: z.string().optional().default(''),
      CallbackMetadata: z.object({ Item: z.array(z.object({ Name: z.string(), Value: z.union([z.string(), z.number()]).optional() })) }).optional(),
    }),
  }),
});

export async function processCallback(requestId: string, rawBody: unknown): Promise<void> {
  const parsed = callbackBody.safeParse(rawBody);
  if (!parsed.success) return; // not a Safaricom callback; acknowledge and ignore
  const cb = parsed.data.Body.stkCallback;

  const [row] = await query<MpesaRow>(`SELECT ${COLS} FROM mpesa_requests WHERE id = $1`, [requestId]);
  if (!row || (row.providerRequestId && row.providerRequestId !== cb.CheckoutRequestID)) return;

  const item = (name: string) => cb.CallbackMetadata?.Item.find((i) => i.Name === name)?.Value;
  let outcome: StkOutcome;
  if (cb.ResultCode === 0) {
    const amount = Number(item('Amount'));
    if (!Number.isFinite(amount) || Math.round(amount * 100) !== row.amountCents) {
      console.error(`[mpesa] callback amount ${String(item('Amount'))} does not match request ${row.id} (${row.amountCents / 100})`);
      await audit({ businessId: row.businessId, action: 'mpesa_amount_mismatch', entity: 'mpesa_request', entityId: row.id,
        details: { expectedCents: row.amountCents, got: item('Amount') ?? null } });
      outcome = { state: 'failed', resultCode: 0, resultDesc: 'The amount paid did not match. Check the M-Pesa statement.' };
    } else {
      const receipt = item('MpesaReceiptNumber');
      outcome = outcomeFromResult(0, cb.ResultDesc, typeof receipt === 'string' ? receipt : receipt === undefined ? null : String(receipt));
    }
  } else {
    outcome = outcomeFromResult(cb.ResultCode, cb.ResultDesc, null);
  }
  await applyOutcome({ id: row.id }, outcome);
}

export async function listRequests(businessId: string, f: { status?: string | undefined; unmatched?: boolean | undefined; page: number; pageSize: number }) {
  const where = ['m.business_id = $1'];
  const params: unknown[] = [businessId];
  if (f.status) {
    params.push(f.status);
    where.push(`m.status = $${params.length}`);
  }
  if (f.unmatched) where.push(`m.status = 'paid' AND m.sale_id IS NULL`);
  const clause = where.join(' AND ');
  const [count] = await query<{ total: number }>(`SELECT count(*) AS total FROM mpesa_requests m WHERE ${clause}`, params);
  const rows = await query<MpesaRow & { createdByName: string; receiptNo: number | null }>(
    `SELECT m.id, m.phone, m.amount_cents, m.status, m.receipt, m.result_desc, m.sale_id, m.created_at,
            u.name AS created_by_name, s.receipt_no
       FROM mpesa_requests m JOIN users u ON u.id = m.created_by LEFT JOIN sales s ON s.id = m.sale_id
      WHERE ${clause} ORDER BY m.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, f.pageSize, offsetOf(f.page, f.pageSize)],
  );
  return {
    items: rows.map((r) => ({
      id: r.id, status: r.status, amountCents: r.amountCents, phone: maskPhone(r.phone), receipt: r.receipt,
      resultDesc: r.resultDesc, createdAt: r.createdAt, createdByName: r.createdByName, receiptNo: r.receiptNo,
      /** Paid by the customer but not attached to any sale: needs a look. */
      unmatched: r.status === 'paid' && r.saleId === null,
    })),
    total: count?.total ?? 0, page: f.page, pageSize: f.pageSize,
  };
}
