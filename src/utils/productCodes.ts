/** EAN-13 check digit for the first 12 digits. */
export function ean13CheckDigit(body12: string): number {
  if (!/^\d{12}$/.test(body12)) throw new Error('EAN-13 needs 12 digits');
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(body12[i]) * (i % 2 === 0 ? 1 : 3);
  return (10 - (sum % 10)) % 10;
}

/**
 * In-store EAN-13: "29" + 10-digit counter + check digit. Numbers starting 20 to 29 are reserved
 * by GS1 for internal use, so they never collide with a manufacturer's barcode on stocked goods.
 */
export function internalBarcode(seq: number): string {
  const body = `29${String(seq).padStart(10, '0')}`;
  return `${body}${ean13CheckDigit(body)}`;
}

/** "go-fish" -> "GF", "enyakin" -> "ENY": a short prefix for the business's SKUs. */
export function skuPrefix(businessCode: string): string {
  const parts = businessCode.toUpperCase().split(/[^A-Z0-9]+/).filter(Boolean);
  if (parts.length > 1) return parts.map((p) => p[0]).join('').slice(0, 4);
  return (parts[0] ?? 'P').slice(0, 3);
}

export const skuFor = (businessCode: string, seq: number): string => `${skuPrefix(businessCode)}-${String(seq).padStart(6, '0')}`;
