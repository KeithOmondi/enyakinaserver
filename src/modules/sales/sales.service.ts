import { query } from '../../config/db';
import { withTransaction } from '../../db/transaction';
import { audit, type AuditEntry } from '../../services/audit';
import { applyStockChange } from '../../services/stock';
import { AppError } from '../../utils/AppError';
import { mpesaModeForBusiness } from '../../services/mpesa/credentials';
import { lineTotal } from '../../utils/money';

export type PayMethod = 'cash' | 'mpesa' | 'card';

export interface CheckoutInput {
  items: { productId: string; quantity: number }[];
  payments: { method: PayMethod; amountCents: number; reference?: string | null; mpesaRequestId?: string | null }[];
  discountCents: number;
  note?: string | null;
}

export async function getSale(businessId: string, id: string) {
  const [sale] = await query<{ id: string }>(
    `SELECT s.id, s.receipt_no, s.status, s.subtotal_cents, s.discount_cents, s.total_cents,
            s.paid_cents, s.change_cents, s.note, s.created_at, s.voided_at, s.void_reason,
            u.name AS cashier_name, vu.name AS voided_by_name
       FROM sales s
       JOIN users u ON u.id = s.created_by
       LEFT JOIN users vu ON vu.id = s.voided_by
      WHERE s.business_id = $1 AND s.id = $2`,
    [businessId, id],
  );
  if (!sale) throw AppError.notFound('Sale');
  const items = await query(
    `SELECT product_id, name, quantity, unit_price_cents, line_total_cents
       FROM sale_items WHERE sale_id = $1 ORDER BY name`,
    [id],
  );
  const payments = await query(
    `SELECT method, amount_cents, reference, (mpesa_request_id IS NOT NULL) AS verified
       FROM payments WHERE sale_id = $1 ORDER BY created_at, method`,
    [id],
  );
  return { ...sale, items, payments };
}

async function findByKey(businessId: string, key: string): Promise<string | null> {
  const [row] = await query<{ id: string }>(
    'SELECT id FROM sales WHERE business_id = $1 AND idempotency_key = $2',
    [businessId, key],
  );
  return row?.id ?? null;
}

/**
 * Records a sale atomically: prices come from the database (never the client), stock is
 * decremented with a conditional update, the receipt number is gapless, and the whole
 * thing commits or rolls back together. A repeated idempotency key returns the original
 * sale instead of recording a second one. `replayed` tells the caller which happened.
 */
export async function checkout(
  businessId: string,
  userId: string,
  key: string,
  input: CheckoutInput,
) {
  const existing = await findByKey(businessId, key);
  if (existing) return { sale: await getSale(businessId, existing), replayed: true };

  try {
    const saleId = await withTransaction(async (tx) => {
      // Merge repeated products so the cart can add the same item twice.
      const wanted = new Map<string, number>();
      for (const it of input.items) wanted.set(it.productId, (wanted.get(it.productId) ?? 0) + it.quantity);
      const ids = [...wanted.keys()].sort();

      const products = await query<{
        id: string; name: string; priceCents: number; costCents: number; allowsFraction: boolean; active: boolean;
      }>(
        `SELECT id, name, price_cents, cost_cents, allows_fraction, active
           FROM products WHERE business_id = $1 AND id = ANY($2::uuid[])`,
        [businessId, ids],
        tx,
      );
      const byId = new Map(products.map((p) => [p.id, p]));

      const lines = ids.map((id) => {
        const p = byId.get(id);
        const qty = Math.round(wanted.get(id)! * 1000) / 1000;
        if (!p) throw AppError.validation([{ path: 'items', message: 'A product in the cart no longer exists' }]);
        if (!p.active) throw AppError.validation([{ path: 'items', message: `"${p.name}" is no longer for sale` }]);
        if (!p.allowsFraction && !Number.isInteger(qty)) {
          throw AppError.validation([{ path: 'items', message: `"${p.name}" is sold in whole units` }]);
        }
        return { p, qty, total: lineTotal(p.priceCents, qty) };
      });

      const subtotal = lines.reduce((s, l) => s + l.total, 0);
      if (input.discountCents > subtotal) {
        throw AppError.validation([{ path: 'discountCents', message: 'Discount is more than the sale total' }]);
      }
      const total = subtotal - input.discountCents;
      if (total <= 0) throw AppError.validation([{ path: 'items', message: 'The sale total must be above zero' }]);

      const paid = input.payments.reduce((s, p) => s + p.amountCents, 0);
      if (paid < total) {
        throw AppError.validation([{ path: 'payments', message: `Payment is short by ${total - paid} cents` }]);
      }
      const change = paid - total;
      const cashTendered = input.payments.filter((p) => p.method === 'cash').reduce((s, p) => s + p.amountCents, 0);
      if (change > cashTendered) {
        throw AppError.validation([{ path: 'payments', message: 'Change can only be given from cash' }]);
      }

      // Stored payments are net of change, so they always add up to the sale total.
      let changeLeft = change;
      const stored = input.payments
        .map((p) => {
          if (p.method !== 'cash' || changeLeft === 0) return p;
          const cut = Math.min(changeLeft, p.amountCents);
          changeLeft -= cut;
          return { ...p, amountCents: p.amountCents - cut };
        })
        .filter((p) => p.amountCents > 0);

      // M-Pesa lines. A line backed by a confirmed prompt is verified and consumed here (once,
      // for exactly its amount). A manually typed code is still accepted, because the network
      // can be down, but it is stored unverified and shows up on the closing screen. When
      // prompts are available a manual line must at least carry a code.
      const promptsOn = (await mpesaModeForBusiness(businessId)) !== 'off';
      const claimed = new Set<string>();
      const finalPayments: { method: PayMethod; amountCents: number; reference: string | null; mpesaRequestId: string | null }[] = [];
      for (const p of stored) {
        let reference = p.reference?.trim() || null;
        let mpesaRequestId: string | null = null;
        if (p.method === 'mpesa' && p.mpesaRequestId) {
          if (claimed.has(p.mpesaRequestId)) {
            throw AppError.validation([{ path: 'payments', message: 'The same M-Pesa payment is listed twice' }]);
          }
          claimed.add(p.mpesaRequestId);
          const [r] = await query<{ status: string; amountCents: number; saleId: string | null; receipt: string | null }>(
            'SELECT status, amount_cents, sale_id, receipt FROM mpesa_requests WHERE id = $1 AND business_id = $2 FOR UPDATE',
            [p.mpesaRequestId, businessId],
            tx,
          );
          if (!r) throw AppError.validation([{ path: 'payments', message: 'That M-Pesa payment was not found' }]);
          if (r.status !== 'paid') {
            throw AppError.validation([{ path: 'payments', message: 'That M-Pesa payment has not been completed by the customer' }]);
          }
          if (r.saleId) throw AppError.validation([{ path: 'payments', message: 'That M-Pesa payment was already used on another sale' }]);
          if (r.amountCents !== p.amountCents) {
            throw AppError.validation([{ path: 'payments', message: 'The M-Pesa amount does not match what the customer paid' }]);
          }
          mpesaRequestId = p.mpesaRequestId;
          reference = r.receipt ?? reference;
        } else if (p.method === 'mpesa' && promptsOn && (reference?.length ?? 0) < 6) {
          throw AppError.validation([
            { path: 'payments', message: 'Send an M-Pesa prompt, or enter the M-Pesa confirmation code' },
          ]);
        }
        finalPayments.push({ method: p.method, amountCents: p.amountCents, reference, mpesaRequestId });
      }

      const [counter] = await query<{ lastNo: number }>(
        `INSERT INTO receipt_counters (business_id, last_no) VALUES ($1, 1)
         ON CONFLICT (business_id) DO UPDATE SET last_no = receipt_counters.last_no + 1
         RETURNING last_no`,
        [businessId],
        tx,
      );
      const receiptNo = counter!.lastNo;

      const [sale] = await query<{ id: string }>(
        `INSERT INTO sales (business_id, receipt_no, subtotal_cents, discount_cents, total_cents,
                            paid_cents, change_cents, note, idempotency_key, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [businessId, receiptNo, subtotal, input.discountCents, total, paid, change, input.note ?? null, key, userId],
        tx,
      );
      const saleId = sale!.id;

      for (const l of lines) {
        await query(
          `INSERT INTO sale_items (sale_id, product_id, name, quantity, unit_price_cents, unit_cost_cents, line_total_cents)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [saleId, l.p.id, l.p.name, l.qty, l.p.priceCents, l.p.costCents, l.total],
          tx,
        );
        await applyStockChange(tx, {
          businessId, productId: l.p.id, quantity: -l.qty, type: 'sale', referenceId: saleId, userId,
          note: `Receipt #${receiptNo}`,
        });
      }
      for (const p of finalPayments) {
        await query(
          'INSERT INTO payments (sale_id, business_id, method, amount_cents, reference, mpesa_request_id) VALUES ($1, $2, $3, $4, $5, $6)',
          [saleId, businessId, p.method, p.amountCents, p.reference, p.mpesaRequestId],
          tx,
        );
        if (p.mpesaRequestId) {
          await query('UPDATE mpesa_requests SET sale_id = $2, updated_at = now() WHERE id = $1', [p.mpesaRequestId, saleId], tx);
        }
      }
      return saleId;
    });
    return { sale: await getSale(businessId, saleId), replayed: false };
  } catch (err) {
    // Two identical requests raced; the loser returns the winner's sale.
    if ((err as { code?: string }).code === '23505') {
      const raced = await findByKey(businessId, key);
      if (raced) return { sale: await getSale(businessId, raced), replayed: true };
    }
    throw err;
  }
}

export async function voidSale(
  businessId: string,
  userId: string,
  id: string,
  reason: string,
  entry: AuditEntry,
) {
  await withTransaction(async (tx) => {
    const [sale] = await query<{ status: string; receiptNo: number; totalCents: number }>(
      'SELECT status, receipt_no, total_cents FROM sales WHERE id = $1 AND business_id = $2 FOR UPDATE',
      [id, businessId],
      tx,
    );
    if (!sale) throw AppError.notFound('Sale');
    if (sale.status === 'voided') throw AppError.conflict('This sale is already voided');

    const items = await query<{ productId: string; quantity: number }>(
      'SELECT product_id, quantity FROM sale_items WHERE sale_id = $1 ORDER BY product_id',
      [id],
      tx,
    );
    for (const it of items) {
      await applyStockChange(tx, {
        businessId, productId: it.productId, quantity: it.quantity, type: 'void', referenceId: id, userId,
        note: `Void of receipt #${sale.receiptNo}`,
      });
    }
    await query(
      `UPDATE sales SET status = 'voided', voided_at = now(), voided_by = $2, void_reason = $3 WHERE id = $1`,
      [id, userId, reason],
      tx,
    );
    await audit({ ...entry, entityId: id, details: { receiptNo: sale.receiptNo, totalCents: sale.totalCents, reason } }, tx);
  });
  return getSale(businessId, id);
}
