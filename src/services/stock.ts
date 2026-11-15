import { query } from '../config/db';
import type { TxClient } from '../db/transaction';
import { AppError } from '../utils/AppError';

export type MovementType = 'opening' | 'purchase' | 'sale' | 'void' | 'adjustment';

export interface StockChange {
  businessId: string;
  productId: string;
  /** Positive adds stock, negative removes it. Never zero. */
  quantity: number;
  type: MovementType;
  referenceId?: string | null;
  note?: string | null;
  userId?: string | null;
}

/**
 * THE only place stock changes. Updates stock_levels and appends the ledger row in the
 * caller's transaction. The UPDATE is conditional (quantity + delta >= 0), so two
 * concurrent sales can never both take the last unit: the second one matches no row.
 * Returns the new balance.
 */
export async function applyStockChange(tx: TxClient, c: StockChange): Promise<number> {
  const rows = await query<{ quantity: number }>(
    `UPDATE stock_levels
        SET quantity = quantity + $3, updated_at = now()
      WHERE product_id = $1 AND business_id = $2 AND quantity + $3 >= 0
  RETURNING quantity`,
    [c.productId, c.businessId, c.quantity],
    tx,
  );
  const balance = rows[0]?.quantity;
  if (balance === undefined) {
    const found = await query<{ name: string; quantity: number }>(
      `SELECT p.name, s.quantity FROM products p JOIN stock_levels s ON s.product_id = p.id
        WHERE p.id = $1 AND p.business_id = $2`,
      [c.productId, c.businessId],
      tx,
    );
    const p = found[0];
    if (!p) throw AppError.notFound('Product');
    throw new AppError(
      409,
      'INSUFFICIENT_STOCK',
      `Not enough stock for "${p.name}" (${p.quantity} left)`,
      { productId: c.productId, available: p.quantity },
    );
  }
  await query(
    `INSERT INTO stock_movements
       (business_id, product_id, type, quantity, balance_after, reference_id, note, user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      c.businessId,
      c.productId,
      c.type,
      c.quantity,
      balance,
      c.referenceId ?? null,
      c.note ?? null,
      c.userId ?? null,
    ],
    tx,
  );
  return balance;
}
