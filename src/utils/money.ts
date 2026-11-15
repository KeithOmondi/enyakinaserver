/**
 * MONEY CONVENTION (decided once for the whole system)
 *
 * All money is stored and transmitted as an INTEGER number of KES cents
 * (1 KES = 100 cents). DB columns are BIGINT. The API accepts and returns cents.
 * The admin panel formats for display. Floats are never used for money.
 *
 *   KES 350.50  ->  35050
 *   KES 1,200   ->  120000
 */
export const CENTS_PER_UNIT = 100;
export const CURRENCY = 'KES';

export type Cents = number;

export function assertCents(value: number, field = 'amount'): Cents {
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${field} must be an integer number of cents`);
  }
  return value;
}

/**
 * Line total for a quantity that may be fractional (e.g. 1.250 kg x 80000 cents/kg).
 * Rounds half away from zero to the nearest cent. Quantities have at most 3 decimals,
 * so we scale to integer thousandths first to avoid float error.
 */
export function lineTotal(unitPrice: Cents, qty: number): Cents {
  assertCents(unitPrice, 'unitPrice');
  const milli = Math.round(qty * 1000);
  const raw = unitPrice * milli; // in cents x 1000
  if (!Number.isSafeInteger(raw)) throw new Error('line total is too large');
  const sign = raw < 0 ? -1 : 1;
  return sign * Math.round(Math.abs(raw) / 1000);
}

/** For logs and receipts only. */
export function formatKes(cents: Cents): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / CENTS_PER_UNIT).toLocaleString('en-KE');
  const frac = String(abs % CENTS_PER_UNIT).padStart(2, '0');
  return `${sign}${CURRENCY} ${whole}.${frac}`;
}
