import { z } from 'zod';

export const pageQuery = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
};

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function offsetOf(page: number, pageSize: number): number {
  return (page - 1) * pageSize;
}

/** Query strings send booleans as "true"/"false". */
export const queryBool = z.enum(['true', 'false']).transform((v) => v === 'true');
export const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
export const uuid = z.string().uuid();
