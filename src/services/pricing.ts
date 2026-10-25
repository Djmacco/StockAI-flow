import type { Db } from '../database/db';
import type { PriceTier, Product } from './types';

export const PRICE_TIERS: readonly PriceTier[] = ['RETAIL', 'WHOLESALE'];
export const normalizeTier = (t: unknown): PriceTier => (t === 'WHOLESALE' ? 'WHOLESALE' : 'RETAIL');

/**
 * THE one place that decides which selling price applies.
 * Wholesale customers get the product's wholesale price when it has one, otherwise the retail price.
 */
export function unitPriceFor(p: Pick<Product, 'selling_price' | 'wholesale_price'>, tier: PriceTier | string | null | undefined): number {
  // Never above retail, even if the retail price was lowered later without touching the wholesale price.
  if (tier === 'WHOLESALE' && p.wholesale_price != null && p.wholesale_price > 0) return Math.min(p.wholesale_price, p.selling_price);
  return p.selling_price;
}

/** Price tier of a registered customer (RETAIL for walk-in sales / unknown ids). */
export async function tierOfCustomer(db: Db, customerId: string | null | undefined): Promise<PriceTier> {
  if (!customerId) return 'RETAIL';
  const c = await db.selectOne<{ price_tier: string }>('SELECT price_tier FROM customers WHERE id = ? AND deleted_at IS NULL', [customerId]);
  return normalizeTier(c?.price_tier);
}
