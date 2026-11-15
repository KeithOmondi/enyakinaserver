import { z } from 'zod';

const threeDecimals = (v: number) => Math.abs(Math.round(v * 1000) - v * 1000) < 1e-6;

/** A quantity with at most 3 decimals (matches NUMERIC(12,3)). Sign is allowed: see the variants. */
export const quantity = z
  .number()
  .finite()
  .max(999_999_999)
  .refine(threeDecimals, 'At most 3 decimal places');

export const positiveQuantity = quantity.refine((v) => v > 0, 'Must be greater than zero');
export const nonNegativeQuantity = quantity.refine((v) => v >= 0, 'Cannot be negative');

/** Integer KES cents. The upper bound keeps sums of line totals inside the safe-integer range. */
export const cents = z.number().int().min(0).max(100_000_000_000);

/** Trims; empty string becomes null. For optional free-text fields. */
export const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional();

export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}
