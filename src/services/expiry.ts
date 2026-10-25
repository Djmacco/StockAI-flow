import { daysUntil } from '../lib/time';

export type ExpiryLevel = 'EXPIRED' | 'CRITICAL' | 'WARNING' | 'NOTICE' | 'OK' | 'NONE';

/**
 * Classify an expiry date against the configured alert thresholds
 * (default 30 / 7 / 1 days). `expired` = strictly before today.
 *   1 day or less  -> CRITICAL, 7 days or less -> WARNING, 30 days or less -> NOTICE.
 */
export function expiryLevel(expiry: string | null | undefined, now: Date, alertDays: number[] = [30, 7, 1]): { level: ExpiryLevel; days: number | null } {
  if (!expiry) return { level: 'NONE', days: null };
  const days = daysUntil(expiry, now);
  if (days < 0) return { level: 'EXPIRED', days };
  const [far, mid, near] = [...alertDays].sort((a, b) => b - a);
  if (near !== undefined && days <= near) return { level: 'CRITICAL', days };
  if (mid !== undefined && days <= mid) return { level: 'WARNING', days };
  if (far !== undefined && days <= far) return { level: 'NOTICE', days };
  return { level: 'OK', days };
}

export type StockLevel = 'OUT' | 'LOW' | 'OK';
/** OUT: nothing left. LOW: at or under the product's minimum (e.g. 4 left, minimum 10). */
export function stockLevel(quantity: number, minimum: number): StockLevel {
  if (quantity <= 0) return 'OUT';
  if (minimum > 0 && quantity <= minimum) return 'LOW';
  return 'OK';
}
