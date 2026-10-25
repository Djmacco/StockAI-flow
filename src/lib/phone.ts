/** Cameroon mobile numbers: 9 digits starting with 6 (+237). Returns 237XXXXXXXXX (no plus) or null when invalid. */
export function normalizeCmPhone(input: string): string | null {
  let d = input.replace(/\D/g, '');
  if (d.startsWith('00237')) d = d.slice(5);
  else if (d.startsWith('237') && d.length === 12) d = d.slice(3);
  return /^6\d{8}$/.test(d) ? `237${d}` : null;
}
/** 6 77 00 00 01 -> "677 00 00 01" style grouping for display. */
export function formatCmPhone(normalized: string): string {
  const n = normalized.slice(-9);
  return `+237 ${n.slice(0, 3)} ${n.slice(3, 5)} ${n.slice(5, 7)} ${n.slice(7)}`;
}
export const maskCmPhone = (normalized: string) => `+237 ${normalized.slice(-9, -6)} ** ** ${normalized.slice(-2)}`;
