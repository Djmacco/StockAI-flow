import { fail } from '../lib/errors';
import { round3 } from '../lib/format';
import { norm } from '../lib/text';
import { audit } from './audit';
import { type AppContext, requirePermission, runTx } from './context';
import { applyStockChange } from './inventory';
import { nextNumber } from './numbering';
import { getById, insertRow, softDelete, updateRow } from './repo';
import type { MovementType, Product, StockCount, StockCountItem } from './types';

/**
 * Physical stock count ("inventaire").
 *
 *  1. startCount        - opens a count (whole shop or one category). Writes ONE row: no per-product rows, so it is instant
 *                         even with thousands of products.
 *  2. saveCountLine     - the owner types / scans what is really on the shelf. The line freezes the system quantity at that
 *                         moment (`expected_qty`). Counting the same product again simply replaces the line.
 *  3. countReview       - differences ("expected 12, counted 9") with their value at cost.
 *  4. applyCount        - ONE transaction: every difference becomes a ledger movement (reference = the count), with the reason.
 *
 * Why the correction is `counted - expected_at_counting_time` and not "set stock to counted": the shop keeps selling while
 * someone counts. A sale made after a product was counted must stay in the stock, so we only add the *difference found*.
 * Products that were not counted are never touched.
 */

export const SHORTAGE_REASONS = ['UNKNOWN', 'THEFT', 'DAMAGED', 'EXPIRED', 'ENTRY_ERROR', 'OTHER'] as const;
export const SURPLUS_REASONS = ['FOUND', 'ENTRY_ERROR', 'OTHER'] as const;
export const COUNT_REASONS = ['UNKNOWN', 'THEFT', 'DAMAGED', 'EXPIRED', 'ENTRY_ERROR', 'FOUND', 'OTHER'] as const;
export type CountReason = (typeof COUNT_REASONS)[number];

export const defaultReason = (difference: number): CountReason | null => (difference < 0 ? 'UNKNOWN' : difference > 0 ? 'FOUND' : null);
export const reasonAllowed = (difference: number, r: string) =>
  difference < 0 ? (SHORTAGE_REASONS as readonly string[]).includes(r) : difference > 0 ? (SURPLUS_REASONS as readonly string[]).includes(r) : false;

/** Which ledger movement type records a corrected difference (so the Movements page and loss reports speak the same language). */
export function movementTypeFor(difference: number, reason: string | null): MovementType {
  if (difference > 0) return 'ADJUSTMENT_IN';
  if (reason === 'DAMAGED') return 'DAMAGED';
  if (reason === 'EXPIRED') return 'EXPIRED';
  if (reason === 'UNKNOWN' || reason === 'THEFT') return 'LOST';
  return 'ADJUSTMENT_OUT';
}

const requireCount = (ctx: AppContext) => requirePermission(ctx, 'inventory.adjust');

// ------------------------------------------------------------------ start / list / get
export interface StartCountInput { name?: string | null; category_id?: string | null; blind?: boolean; notes?: string | null }

export async function startCount(ctx: AppContext, input: StartCountInput = {}): Promise<StockCount> {
  requireCount(ctx);
  return runTx(ctx, async (tx) => {
    if (input.category_id && !(await getById(tx, 'categories', input.category_id))) return fail('errors.notFound');
    const reference = await nextNumber(tx, ctx, 'CNT');
    const c = await insertRow<StockCount>(tx, ctx, 'stock_counts', {
      reference, name: input.name?.trim() || null, category_id: input.category_id || null, blind: input.blind === false ? 0 : 1, status: 'OPEN',
      started_at: ctx.now().toISOString(), applied_at: null, user_id: ctx.user?.id ?? null, user_name: ctx.user?.full_name ?? null,
      notes: input.notes?.trim() || null, items_counted: 0, items_different: 0, shortage_value: 0, surplus_value: 0,
    });
    await audit(tx, ctx, 'stock_count.started', 'stock_count', c.id, { reference, category_id: c.category_id, blind: !!c.blind });
    return c;
  });
}

export interface CountListRow extends StockCount { category_name: string | null; lines: number }

export async function listCounts(ctx: AppContext, limit = 100): Promise<CountListRow[]> {
  requireCount(ctx);
  return ctx.db.select<CountListRow>(
    `SELECT c.*, cat.name AS category_name,
            (SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id = c.id AND i.deleted_at IS NULL) AS lines
     FROM stock_counts c LEFT JOIN categories cat ON cat.id = c.category_id
     WHERE c.deleted_at IS NULL ORDER BY c.started_at DESC, c.rowid DESC LIMIT ?`, [limit]);
}

export async function getCount(ctx: AppContext, id: string): Promise<(CountListRow & { scope_total: number }) | undefined> {
  requireCount(ctx);
  const c = await ctx.db.selectOne<CountListRow>(
    `SELECT c.*, cat.name AS category_name,
            (SELECT COUNT(*) FROM stock_count_items i WHERE i.count_id = c.id AND i.deleted_at IS NULL) AS lines
     FROM stock_counts c LEFT JOIN categories cat ON cat.id = c.category_id WHERE c.id = ? AND c.deleted_at IS NULL`, [id]);
  if (!c) return undefined;
  const total = await ctx.db.selectOne<{ n: number }>(
    `SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL ${c.category_id ? 'AND category_id = ?' : ''}`, c.category_id ? [c.category_id] : []);
  return { ...c, scope_total: total?.n ?? 0 };
}

// ------------------------------------------------------------------ the counting sheet
export interface SheetRow {
  product_id: string; name: string; sku: string | null; barcode: string | null; unit: string; category_id: string | null;
  system_qty: number;            // quantity on screen right now
  cost_price: number;
  item_id: string | null;        // null = not counted yet
  counted_qty: number | null; expected_qty: number | null; difference: number | null; reason_code: string | null;
}
export interface SheetQuery { search?: string; filter?: 'todo' | 'counted' | 'all'; limit?: number; offset?: number }

/**
 * The list the owner counts from. Only light columns are read (no images), the filter on counted / not counted is done in
 * SQL, the text search ignores case and accents, and the result is paged so the screen stays fast with a large catalogue.
 */
export async function countSheet(ctx: AppContext, countId: string, q: SheetQuery = {}): Promise<{ rows: SheetRow[]; total: number; counted: number }> {
  requireCount(ctx);
  const c = await getById<StockCount>(ctx.db, 'stock_counts', countId);
  if (!c) return fail('errors.notFound');
  const where = ['p.deleted_at IS NULL']; const params: any[] = [countId];
  if (c.category_id) { where.push('p.category_id = ?'); params.push(c.category_id); }
  const filter = q.filter ?? 'all';
  if (filter === 'todo') where.push('i.id IS NULL');
  if (filter === 'counted') where.push('i.id IS NOT NULL');
  const all = await ctx.db.select<SheetRow>(
    `SELECT p.id AS product_id, p.name, p.sku, p.barcode, p.unit, p.category_id, p.quantity AS system_qty, p.cost_price,
            i.id AS item_id, i.counted_qty, i.expected_qty, i.difference, i.reason_code
     FROM products p LEFT JOIN stock_count_items i ON i.product_id = p.id AND i.count_id = ? AND i.deleted_at IS NULL
     WHERE ${where.join(' AND ')} ORDER BY p.name COLLATE NOCASE`, params);
  let rows = all;
  const s = q.search?.trim() ? norm(q.search) : '';
  if (s) rows = all.filter((r) => norm(`${r.name} ${r.sku ?? ''} ${r.barcode ?? ''}`).includes(s));
  const counted = (await ctx.db.selectOne<{ n: number }>('SELECT COUNT(*) n FROM stock_count_items WHERE count_id = ? AND deleted_at IS NULL', [countId]))?.n ?? 0;
  const total = rows.length;
  const off = q.offset ?? 0;
  return { rows: q.limit ? rows.slice(off, off + q.limit) : rows, total, counted };
}

// ------------------------------------------------------------------ counting
async function openCount(tx: AppContext['db'], id: string): Promise<StockCount> {
  const c = await getById<StockCount>(tx, 'stock_counts', id);
  if (!c) return fail('errors.notFound');
  if (c.status !== 'OPEN') return fail('errors.countNotOpen');
  return c;
}

/** Record what was physically counted for one product. Counting it again replaces the previous line. */
export async function saveCountLine(ctx: AppContext, countId: string, productId: string, countedQty: number): Promise<StockCountItem> {
  requireCount(ctx);
  if (!Number.isFinite(countedQty) || countedQty < 0) fail('errors.invalidQuantity');
  const counted = round3(countedQty);
  return runTx(ctx, async (tx) => {
    const c = await openCount(tx, countId);
    const p = await getById<Product>(tx, 'products', productId);
    if (!p) return fail('errors.productNotFound');
    if (c.category_id && p.category_id !== c.category_id) return fail('errors.countOutOfScope', { product: p.name });
    const diff = round3(counted - p.quantity);
    const existing = await tx.selectOne<StockCountItem>('SELECT * FROM stock_count_items WHERE count_id = ? AND product_id = ? AND deleted_at IS NULL', [countId, productId]);
    // A reason the owner already chose stays, as long as it still makes sense for the new difference.
    const reason = existing?.reason_code && reasonAllowed(diff, existing.reason_code) ? existing.reason_code : defaultReason(diff);
    const fields = {
      product_name: p.name, unit: p.unit, expected_qty: p.quantity, counted_qty: counted, difference: diff, unit_cost: p.cost_price, reason_code: reason,
    };
    return existing
      ? updateRow<StockCountItem>(tx, ctx, 'stock_count_items', existing.id, fields)
      : insertRow<StockCountItem>(tx, ctx, 'stock_count_items', { count_id: countId, product_id: productId, note: null, ...fields });
  });
}

/** Remove a line (the product goes back to "not counted"). */
export async function clearCountLine(ctx: AppContext, countId: string, productId: string): Promise<void> {
  requireCount(ctx);
  await runTx(ctx, async (tx) => {
    await openCount(tx, countId);
    const it = await tx.selectOne<StockCountItem>('SELECT * FROM stock_count_items WHERE count_id = ? AND product_id = ? AND deleted_at IS NULL', [countId, productId]);
    if (it) await softDelete(tx, ctx, 'stock_count_items', it.id);
  });
}

/** Why the difference exists (theft, damaged, entry error...). */
export async function setLineReason(ctx: AppContext, itemId: string, reason: string, note?: string | null): Promise<void> {
  requireCount(ctx);
  await runTx(ctx, async (tx) => {
    const it = await getById<StockCountItem>(tx, 'stock_count_items', itemId);
    if (!it) return fail('errors.notFound');
    await openCount(tx, it.count_id);
    if (!reasonAllowed(it.difference, reason)) return fail('errors.countReasonInvalid');
    await updateRow(tx, ctx, 'stock_count_items', itemId, { reason_code: reason, ...(note !== undefined ? { note: note?.trim() || null } : {}) });
  });
}

// ------------------------------------------------------------------ review (the difference report)
export interface CountSummary {
  counted: number; matching: number; different: number; shortage_lines: number; surplus_lines: number;
  shortage_value: number; surplus_value: number; net_value: number;
}
export interface ReviewLine extends StockCountItem { value: number; moved: boolean; system_qty: number }

export function summarize(lines: Pick<StockCountItem, 'difference' | 'unit_cost'>[]): CountSummary {
  let shortage = 0, surplus = 0, sl = 0, up = 0, matching = 0;
  for (const l of lines) {
    if (l.difference < 0) { shortage += Math.round(-l.difference * l.unit_cost); sl++; }
    else if (l.difference > 0) { surplus += Math.round(l.difference * l.unit_cost); up++; }
    else matching++;
  }
  return { counted: lines.length, matching, different: sl + up, shortage_lines: sl, surplus_lines: up, shortage_value: shortage, surplus_value: surplus, net_value: surplus - shortage };
}

/** All counted lines, biggest loss first, with the number the owner will act on. `value` is negative for missing stock. */
export async function countReview(ctx: AppContext, countId: string): Promise<{ count: StockCount; lines: ReviewLine[]; summary: CountSummary; not_counted: number }> {
  requireCount(ctx);
  const count = await getById<StockCount>(ctx.db, 'stock_counts', countId);
  if (!count) return fail('errors.notFound');
  const rows = await ctx.db.select<StockCountItem & { system_qty: number | null }>(
    `SELECT i.*, p.quantity AS system_qty FROM stock_count_items i LEFT JOIN products p ON p.id = i.product_id
     WHERE i.count_id = ? AND i.deleted_at IS NULL`, [countId]);
  const lines: ReviewLine[] = rows.map((r) => ({ ...r, system_qty: r.system_qty ?? 0, value: Math.round(r.difference * r.unit_cost), moved: count.status === 'OPEN' && round3(r.system_qty ?? 0) !== round3(r.expected_qty) }))
    .sort((a, b) => a.value - b.value || a.product_name.localeCompare(b.product_name));
  const scope = await ctx.db.selectOne<{ n: number }>(
    `SELECT COUNT(*) n FROM products WHERE deleted_at IS NULL ${count.category_id ? 'AND category_id = ?' : ''}`, count.category_id ? [count.category_id] : []);
  return { count, lines, summary: summarize(lines), not_counted: Math.max(0, (scope?.n ?? 0) - lines.length) };
}

// ------------------------------------------------------------------ apply / cancel
/**
 * One tap: every difference is written to the stock ledger in ONE transaction (all or nothing), tagged with the count and
 * the reason. The count becomes read-only and keeps its report for later.
 */
export async function applyCount(ctx: AppContext, countId: string): Promise<CountSummary> {
  requireCount(ctx);
  return runTx(ctx, async (tx) => {
    const c = await openCount(tx, countId);
    const lines = await tx.select<StockCountItem>('SELECT * FROM stock_count_items WHERE count_id = ? AND deleted_at IS NULL ORDER BY rowid', [countId]);
    if (!lines.length) return fail('errors.countEmpty');
    for (const l of lines) {
      if (l.difference === 0) continue;
      const p = await getById<Product>(tx, 'products', l.product_id);
      if (!p) return fail('errors.productNotFound');
      // Sales after the count can make a shortage bigger than what is left: the counts contradict each other, so stop and ask for a recount.
      if (round3(p.quantity + l.difference) < 0) return fail('errors.countStockMoved', { product: p.name, now: p.quantity, counted: l.counted_qty });
      const reason = l.reason_code ?? defaultReason(l.difference);
      await applyStockChange(tx, ctx, {
        productId: l.product_id, delta: l.difference, type: movementTypeFor(l.difference, reason),
        reason: `${c.reference}: ${reason}${l.note ? ` (${l.note})` : ''}`, referenceType: 'stock_count', referenceId: c.id,
      });
    }
    const summary = summarize(lines);
    await updateRow(tx, ctx, 'stock_counts', c.id, {
      status: 'APPLIED', applied_at: ctx.now().toISOString(), items_counted: summary.counted, items_different: summary.different,
      shortage_value: summary.shortage_value, surplus_value: summary.surplus_value,
    });
    await audit(tx, ctx, 'stock_count.applied', 'stock_count', c.id, { reference: c.reference, ...summary });
    return summary;
  });
}

/** Abandon a count: stock is left exactly as it was. */
export async function cancelCount(ctx: AppContext, countId: string): Promise<void> {
  requireCount(ctx);
  await runTx(ctx, async (tx) => {
    const c = await openCount(tx, countId);
    await updateRow(tx, ctx, 'stock_counts', c.id, { status: 'CANCELLED' });
    await audit(tx, ctx, 'stock_count.cancelled', 'stock_count', c.id, { reference: c.reference });
  });
}

// ------------------------------------------------------------------ where is stock disappearing?
export interface LossRow { product_id: string; product_name: string; unit: string | null; times_short: number; times_counted: number; missing_qty: number; value: number; last_at: string | null }
export interface LossReport {
  rows: LossRow[];
  by_reason: { reason: string; value: number; lines: number }[];
  totals: { counts: number; shortage_value: number; surplus_value: number; net_value: number };
}

/** Losses found by APPLIED counts in a period: which products keep coming up short, and why. */
export async function lossReport(ctx: AppContext, opts: { from?: string; to?: string; limit?: number } = {}): Promise<LossReport> {
  requireCount(ctx);
  const where = ["c.status = 'APPLIED'", 'c.deleted_at IS NULL', 'i.deleted_at IS NULL']; const params: any[] = [];
  if (opts.from) { where.push('c.applied_at >= ?'); params.push(opts.from); }
  if (opts.to) { where.push('c.applied_at < ?'); params.push(opts.to); }
  const w = where.join(' AND ');
  const rows = await ctx.db.select<LossRow>(
    `SELECT i.product_id, MAX(i.product_name) AS product_name, MAX(i.unit) AS unit,
            SUM(CASE WHEN i.difference < 0 THEN 1 ELSE 0 END) AS times_short, COUNT(*) AS times_counted,
            COALESCE(SUM(CASE WHEN i.difference < 0 THEN -i.difference ELSE 0 END), 0) AS missing_qty,
            COALESCE(SUM(CASE WHEN i.difference < 0 THEN -i.difference * i.unit_cost ELSE 0 END), 0) AS value,
            MAX(CASE WHEN i.difference < 0 THEN c.applied_at END) AS last_at
     FROM stock_count_items i JOIN stock_counts c ON c.id = i.count_id WHERE ${w}
     GROUP BY i.product_id HAVING times_short > 0 ORDER BY value DESC, missing_qty DESC LIMIT ?`, [...params, opts.limit ?? 50]);
  const byReason = await ctx.db.select<{ reason: string; value: number; lines: number }>(
    `SELECT COALESCE(i.reason_code, 'UNKNOWN') AS reason, COALESCE(SUM(-i.difference * i.unit_cost), 0) AS value, COUNT(*) AS lines
     FROM stock_count_items i JOIN stock_counts c ON c.id = i.count_id WHERE ${w} AND i.difference < 0 GROUP BY 1 ORDER BY value DESC`, params);
  const t = await ctx.db.selectOne<{ counts: number; shortage: number; surplus: number }>(
    `SELECT COUNT(DISTINCT c.id) AS counts,
            COALESCE(SUM(CASE WHEN i.difference < 0 THEN -i.difference * i.unit_cost ELSE 0 END), 0) AS shortage,
            COALESCE(SUM(CASE WHEN i.difference > 0 THEN i.difference * i.unit_cost ELSE 0 END), 0) AS surplus
     FROM stock_count_items i JOIN stock_counts c ON c.id = i.count_id WHERE ${w}`, params);
  const shortage = Math.round(t?.shortage ?? 0); const surplus = Math.round(t?.surplus ?? 0);
  return {
    rows: rows.map((r) => ({ ...r, value: Math.round(r.value), missing_qty: round3(r.missing_qty) })),
    by_reason: byReason.map((r) => ({ ...r, value: Math.round(r.value) })),
    totals: { counts: t?.counts ?? 0, shortage_value: shortage, surplus_value: surplus, net_value: surplus - shortage },
  };
}
