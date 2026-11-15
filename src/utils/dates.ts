import { env } from '../config/env';

/** Today's date (YYYY-MM-DD) in the business timezone, not the server's. */
export function businessToday(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: env.BUSINESS_TIMEZONE }).format(now);
}

/**
 * Adds "column falls on or after `from` and before the day after `to`" conditions,
 * with day boundaries in BUSINESS_TIMEZONE. Mutates `where` and `params`.
 */
export function addDateRange(
  where: string[],
  params: unknown[],
  column: string,
  from?: string,
  to?: string,
): void {
  if (from) {
    params.push(from, env.BUSINESS_TIMEZONE);
    where.push(`${column} >= ($${params.length - 1}::date::timestamp AT TIME ZONE $${params.length})`);
  }
  if (to) {
    params.push(to, env.BUSINESS_TIMEZONE);
    where.push(`${column} < (($${params.length - 1}::date + 1)::timestamp AT TIME ZONE $${params.length})`);
  }
}
