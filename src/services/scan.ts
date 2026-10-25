import type { ScanDetection } from '../cloud/client';
import { fail } from '../lib/errors';
import { round3 } from '../lib/format';
import { audit } from './audit';
import { type AppContext, requirePermission, runTx } from './context';
import { applyStockChange } from './inventory';
import { searchProducts } from './products';
import type { Product } from './types';

/**
 * AI STORE SCAN - desktop side.
 * The (online, premium) backend only returns *detections*. Nothing here changes stock until
 * the user reviews / corrects the proposal and explicitly confirms it.
 *   image -> detections -> match to inventory -> proposal -> user edits -> CONFIRM -> one transaction
 */
export interface ScanProposal {
  key: string;
  detection: ScanDetection;
  product: Product | null;
  candidates: Product[];
  current: number | null;
  /** Quantity to set. null = the AI was unsure: the user must type it. */
  counted: number | null;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE';
}

export async function buildProposals(ctx: AppContext, detections: ScanDetection[]): Promise<ScanProposal[]> {
  requirePermission(ctx, 'inventory.adjust');
  const out: ScanProposal[] = [];
  const used = new Set<string>();
  for (const [i, d] of detections.entries()) {
    const found = await searchProducts(ctx, d.label, 4);
    const best = found[0];
    const matched = best && best.score >= 0.7 && !used.has(best.id) ? best : null;
    if (matched) used.add(matched.id);
    const lowConfidence = d.confidence === 'LOW' || d.quantity === null || d.quantity === undefined;
    out.push({
      key: `${i}:${d.label}`, detection: d, product: matched, candidates: found.slice(0, 4),
      current: matched ? matched.quantity : null,
      counted: !lowConfidence && matched ? Math.max(0, Math.round(d.quantity as number)) : null,
      confidence: matched ? d.confidence : 'NONE',
    });
  }
  return out;
}

export interface ScanChange { product_id: string; counted: number }

/** Applies the confirmed counts atomically: either every line is updated or none. */
export async function applyScan(ctx: AppContext, changes: ScanChange[]): Promise<number> {
  requirePermission(ctx, 'inventory.adjust');
  if (!changes.length) fail('errors.nothingToApply');
  return runTx(ctx, async (tx) => {
    let applied = 0;
    for (const c of changes) {
      if (!(c.counted >= 0)) fail('errors.invalidQuantity');
      const p = await tx.selectOne<Product>('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL', [c.product_id]);
      if (!p) return fail('errors.productNotFound');
      const delta = round3(c.counted - p.quantity);
      if (delta === 0) continue;
      await applyStockChange(tx, ctx, { productId: p.id, delta, type: delta > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT', reason: 'AI store scan (confirmed)' });
      applied++;
    }
    await audit(tx, ctx, 'stock.scan_applied', 'inventory', undefined, { lines: changes.length, changed: applied });
    return applied;
  });
}
