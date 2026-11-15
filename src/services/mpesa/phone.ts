/**
 * Normalises a Kenyan mobile number to the 254XXXXXXXXX form Safaricom expects.
 * Accepts 0712345678, 712345678, +254712345678, 254 712 345 678, 0112345678 (Airtel/Telkom
 * ranges starting 01 and 07). Returns null when it cannot be a Kenyan mobile number.
 */
export function normalizePhone(input: string): string | null {
  const digits = input.replace(/[\s()-]/g, '').replace(/^\+/, '');
  if (!/^\d+$/.test(digits)) return null;
  let national: string;
  if (digits.startsWith('254')) national = digits.slice(3);
  else if (digits.startsWith('0')) national = digits.slice(1);
  else national = digits;
  return /^[17]\d{8}$/.test(national) ? `254${national}` : null;
}

/** 254712345678 -> 254712***678: enough for staff to recognise, not enough to harvest. */
export function maskPhone(phone: string): string {
  return `${phone.slice(0, 6)}***${phone.slice(-3)}`;
}
