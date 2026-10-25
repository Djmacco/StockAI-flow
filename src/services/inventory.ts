import type { Db } from '../database/db';
import { fail } from '../lib/errors';
import { round3 } from '../lib/format';
import { audit } from './audit';
import { type AppContext, requirePermission, runTx } from './context';
import { insertRow, updateRow } from './repo';
import type { Batch, MovementType, Product, StockMovement } from './types';

export interface StockChange {
  productId: string;
  /** Signed quantity: positive adds stock, negative removes it. */
  delta: number;
  type: MovementType;
  reason?: string | null;
  referenceType?: string | null;
  referenceId?: string | null;
  unitCost?: number;
  /** When adding stock: create a batch with these properties. */
  newBatch?: { expiry_date?: string | null; lot_code?: string | null; purchase_id?: string | null; supplier_id?: string | null; cost_price?: number } | null;
  /** When removing stock for a specific batch (expired write-off). */
  fromBatchId?: string | null;
  /** When restoring stock (sale cancel) into a known batch. */
  toBatchId?: string | null;
  allowNegative?: boolean;
}

export interface StockResult { movements: StockMovement[]; product: Product; unitCostAvg: number }

/**
 * THE one place where stock changes. Must be called inside a transaction.
 *  - writes one ledger row per touched batch (+1 for un-batched stock)
 *  - keeps products.quantity === SUM(ledger)
 *  - keeps products.expiry_date = earliest expiry among batches with stock left
 *  - consumes batches first-expiring-first-out (FEFO)
 */
export async function applyStockChange(tx: Db, ctx: AppContext, c: StockChange): Promise<StockResult> {
  const product = await tx.selectOne<Product>('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL', [c.productId]);
  if (!product) return fail('errors.productNotFound');
  const delta = round3(c.delta);
  if (delta === 0) return fail('errors.invalidQuantity');
  const startQty = product.quantity;
  const endQty = round3(startQty + delta);
  if (endQty < 0 && !c.allowNegative) fail('errors.insufficientStock', { product: product.name, available: startQty, requested: Math.abs(delta) });

  const movements: StockMovement[] = [];
  let running = startQty;
  const record = async (qty: number, batchId: string | null, unitCost: number) => {
    const next = round3(running + qty);
    const m = await insertRow<StockMovement>(tx, ctx, 'stock_movements', {
      product_id: product.id, batch_id: batchId, type: c.type, quantity: qty, previous_stock: running, new_stock: next,
      unit_cost: unitCost, reason: c.reason ?? null, reference_type: c.referenceType ?? null, reference_id: c.referenceId ?? null,
      user_id: ctx.user?.id ?? null, user_name: ctx.user?.full_name ?? null,
    });
    movements.push(m);
    running = next;
  };

  let costSum = 0;
  if (delta > 0) {
    let batchId: string | null = c.toBatchId ?? null;
    const cost = c.unitCost ?? c.newBatch?.cost_price ?? product.cost_price;
    if (batchId) {
      const b = await tx.selectOne<Batch>('SELECT * FROM product_batches WHERE id = ?', [batchId]);
      if (b) await updateRow(tx, ctx, 'product_batches', b.id, { quantity_remaining: round3(b.quantity_remaining + delta) });
    } else if (c.newBatch) {
      const b = await insertRow<Batch>(tx, ctx, 'product_batches', {
        product_id: product.id, lot_code: c.newBatch.lot_code ?? null, expiry_date: c.newBatch.expiry_date || null,
        quantity_initial: delta, quantity_remaining: delta, cost_price: cost, received_at: ctx.now().toISOString(),
        purchase_id: c.newBatch.purchase_id ?? null, supplier_id: c.newBatch.supplier_id ?? null,
      });
      batchId = b.id;
    }
    await record(delta, batchId, cost);
    costSum = cost * delta;
  } else {
    let toRemove = -delta;
    const batches = c.fromBatchId
      ? await tx.select<Batch>('SELECT * FROM product_batches WHERE id = ? AND quantity_remaining > 0', [c.fromBatchId])
      : await tx.select<Batch>(
          `SELECT * FROM product_batches WHERE product_id = ? AND deleted_at IS NULL AND quantity_remaining > 0
           ORDER BY (expiry_date IS NULL), expiry_date, received_at`,
          [product.id],
        );
    for (const b of batches) {
      if (toRemove <= 0) break;
      const take = round3(Math.min(b.quantity_remaining, toRemove));
      await updateRow(tx, ctx, 'product_batches', b.id, { quantity_remaining: round3(b.quantity_remaining - take) });
      await record(-take, b.id, b.cost_price);
      costSum += b.cost_price * take;
      toRemove = round3(toRemove - take);
    }
    if (toRemove > 0) {
      // Stock that was never tied to a batch (or negative stock when allowed).
      await record(-toRemove, null, product.cost_price);
      costSum += product.cost_price * toRemove;
    }
  }

  // Next expiry among batches that still hold stock.
  const next = await tx.selectOne<{ e: string | null }>(
    `SELECT MIN(expiry_date) e FROM product_batches WHERE product_id = ? AND deleted_at IS NULL AND quantity_remaining > 0 AND expiry_date IS NOT NULL`,
    [product.id],
  );
  const patch: Record<string, any> = { quantity: endQty };
  if ((next?.e ?? null) !== product.expiry_date) patch.expiry_date = next?.e ?? null;
  // Weighted cost refresh on purchases keeps profit reports honest.
  if (c.type === 'PURCHASE' && c.unitCost !== undefined && startQty + delta > 0) {
    const stockValue = Math.max(startQty, 0) * product.cost_price + delta * c.unitCost;
    patch.cost_price = Math.round(stockValue / (Math.max(startQty, 0) + delta));
  }
  const updated = await updateRow<Product>(tx, ctx, 'products', product.id, patch);
  return { movements, product: updated, unitCostAvg: Math.abs(delta) > 0 ? costSum / Math.abs(delta) : 0 };
}

// ------------------------------------------------------------------ public API
export type AdjustKind = 'ADJUSTMENT_IN' | 'ADJUSTMENT_OUT' | 'DAMAGED' | 'LOST' | 'RETURN' | 'SET';

export interface AdjustInput {
  product_id: string;
  kind: AdjustKind;
  /** For SET this is the counted quantity; otherwise the amount to add/remove. */
  quantity: number;
  reason?: string;
  expiry_date?: string | null;
  lot_code?: string | null;
}

export async function adjustStock(ctx: AppContext, input: AdjustInput) {
  requirePermission(ctx, 'inventory.adjust');
  if (!(input.quantity >= 0) || (input.kind !== 'SET' && input.quantity === 0)) fail('errors.invalidQuantity');
  return runTx(ctx, async (tx) => {
    const p = await tx.selectOne<Product>('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL', [input.product_id]);
    if (!p) return fail('errors.productNotFound');
    let delta: number;
    let type: MovementType;
    switch (input.kind) {
      case 'SET':
        delta = round3(input.quantity - p.quantity);
        type = delta >= 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT';
        if (delta === 0) return { movements: [], product: p, unitCostAvg: 0 } as StockResult;
        break;
      case 'ADJUSTMENT_IN': case 'RETURN': delta = input.quantity; type = input.kind; break;
      default: delta = -input.quantity; type = input.kind; // ADJUSTMENT_OUT, DAMAGED, LOST
    }
    const res = await applyStockChange(tx, ctx, {
      productId: p.id, delta, type, reason: input.reason ?? null,
      newBatch: delta > 0 && input.expiry_date ? { expiry_date: input.expiry_date, lot_code: input.lot_code } : null,
    });
    await audit(tx, ctx, 'stock.adjusted', 'product', p.id, { type, delta, previous: p.quantity, now: res.product.quantity, reason: input.reason ?? null });
    return res;
  });
}

export interface MovementRow extends StockMovement { product_name: string; unit: string }
export async function listMovements(ctx: AppContext, opts: { productId?: string; type?: string; limit?: number; offset?: number } = {}): Promise<MovementRow[]> {
  const where: string[] = []; const params: any[] = [];
  if (opts.productId) { where.push('m.product_id = ?'); params.push(opts.productId); }
  if (opts.type) { where.push('m.type = ?'); params.push(opts.type); }
  return ctx.db.select<MovementRow>(
    `SELECT m.*, p.name AS product_name, p.unit AS unit FROM stock_movements m JOIN products p ON p.id = m.product_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY m.created_at DESC, m.rowid DESC LIMIT ? OFFSET ?`,
    [...params, opts.limit ?? 200, opts.offset ?? 0],
  );
}

export interface BatchRow extends Batch { product_name: string; unit: string }
export async function listBatches(ctx: AppContext, opts: { productId?: string; onlyWithStock?: boolean } = {}): Promise<BatchRow[]> {
  const where = ['b.deleted_at IS NULL']; const params: any[] = [];
  if (opts.productId) { where.push('b.product_id = ?'); params.push(opts.productId); }
  if (opts.onlyWithStock !== false) where.push('b.quantity_remaining > 0');
  return ctx.db.select<BatchRow>(
    `SELECT b.*, p.name AS product_name, p.unit AS unit FROM product_batches b JOIN products p ON p.id = b.product_id
     WHERE ${where.join(' AND ')} ORDER BY (b.expiry_date IS NULL), b.expiry_date, b.received_at`,
    params,
  );
}

/** Explicit, user-triggered removal of expired stock. Expired products are never deleted automatically. */
export async function writeOffBatch(ctx: AppContext, batchId: string, reason?: string) {
  requirePermission(ctx, 'inventory.adjust');
  return runTx(ctx, async (tx) => {
    const b = await tx.selectOne<Batch>('SELECT * FROM product_batches WHERE id = ? AND deleted_at IS NULL', [batchId]);
    if (!b || b.quantity_remaining <= 0) return fail('errors.notFound');
    const res = await applyStockChange(tx, ctx, {
      productId: b.product_id, delta: -b.quantity_remaining, type: 'EXPIRED', reason: reason ?? 'Expired stock written off', fromBatchId: b.id, allowNegative: true,
    });
    await audit(tx, ctx, 'stock.expired_writeoff', 'batch', b.id, { quantity: b.quantity_remaining, lot: b.lot_code });
    return res;
  });
}

/** Rebuild products.quantity from the ledger (used after sync merges). */
export async function recomputeQuantityFromLedger(tx: Db, productId: string): Promise<number> {
  const r = await tx.selectOne<{ q: number | null }>(
    'SELECT SUM(quantity) q FROM stock_movements WHERE product_id = ? AND deleted_at IS NULL', [productId]);
  const q = round3(r?.q ?? 0);
  await tx.execute('UPDATE products SET quantity = ? WHERE id = ?', [q, productId]);
  return q;
}
