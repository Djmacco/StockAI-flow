import { fail } from '../lib/errors';
import { round3 } from '../lib/format';
import { audit } from './audit';
import { type AppContext, requirePermission, requireUser, runTx } from './context';
import { applyStockChange } from './inventory';
import { getById, insertRow, softDelete } from './repo';
import { nextCounter } from './settings';
import type { Expense, Product, Purchase, PurchaseItem, Supplier } from './types';

export interface PurchaseLine { product_id: string; quantity: number; cost_price: number; expiry_date?: string | null; lot_code?: string | null }
export interface PurchaseInput {
  supplier_id?: string | null; lines: PurchaseLine[]; amount_paid?: number; reference?: string; notes?: string | null; purchased_at?: string;
}

const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

/**
 * Confirm a purchase: purchase + items + stock increase + batch + ledger + product cost
 * refresh + sync entries, all in one transaction.
 */
export async function createPurchase(ctx: AppContext, input: PurchaseInput): Promise<{ purchase: Purchase; items: PurchaseItem[] }> {
  requirePermission(ctx, 'purchases.create');
  const user = requireUser(ctx);
  if (!input.lines.length) fail('errors.emptyCart');
  return runTx(ctx, async (tx) => {
    if (input.supplier_id && !(await getById<Supplier>(tx, 'suppliers', input.supplier_id))) fail('errors.notFound');
    const lines = input.lines.map((l) => ({ ...l, quantity: round3(l.quantity), cost_price: Math.round(l.cost_price) }));
    for (const l of lines) {
      if (!(l.quantity > 0)) fail('errors.invalidQuantity');
      if (!(l.cost_price >= 0)) fail('errors.invalidPrice');
    }
    const total = lines.reduce((s, l) => s + Math.round(l.quantity * l.cost_price), 0);
    const paid = Math.min(total, Math.max(0, Math.round(input.amount_paid ?? total)));
    if (paid < total && !input.supplier_id) fail('errors.creditNeedsSupplier');
    const counter = await nextCounter(tx, 'purchase_counter');
    const reference = input.reference?.trim() || `A${ymd(ctx.now())}-${ctx.deviceId.replace(/-/g, '').slice(-4).toUpperCase()}-${String(counter).padStart(4, '0')}`;
    const purchase = await insertRow<Purchase>(tx, ctx, 'purchases', {
      reference, supplier_id: input.supplier_id ?? null, total, amount_paid: paid, notes: input.notes ?? null,
      purchased_at: input.purchased_at ?? ctx.now().toISOString(), user_id: user.id, user_name: user.full_name, status: 'CONFIRMED',
    });
    const items: PurchaseItem[] = [];
    for (const l of lines) {
      if (!(await getById<Product>(tx, 'products', l.product_id))) fail('errors.productNotFound');
      items.push(await insertRow<PurchaseItem>(tx, ctx, 'purchase_items', {
        purchase_id: purchase.id, product_id: l.product_id, quantity: l.quantity, cost_price: l.cost_price,
        expiry_date: l.expiry_date || null, lot_code: l.lot_code || null, line_total: Math.round(l.quantity * l.cost_price),
      }));
      await applyStockChange(tx, ctx, {
        productId: l.product_id, delta: l.quantity, type: 'PURCHASE', unitCost: l.cost_price, referenceType: 'purchase', referenceId: purchase.id,
        reason: reference, newBatch: { expiry_date: l.expiry_date || null, lot_code: l.lot_code || null, purchase_id: purchase.id, supplier_id: input.supplier_id ?? null, cost_price: l.cost_price },
      });
    }
    await audit(tx, ctx, 'purchase.created', 'purchase', purchase.id, { reference, total, lines: lines.length, supplier: input.supplier_id ?? null });
    return { purchase, items };
  });
}

export interface PurchaseRow extends Purchase { supplier_name: string | null; item_count: number }
export async function listPurchases(ctx: AppContext, opts: { supplierId?: string; from?: string; to?: string; limit?: number } = {}): Promise<PurchaseRow[]> {
  requirePermission(ctx, 'purchases.read');
  const where = ['p.deleted_at IS NULL']; const params: any[] = [];
  if (opts.supplierId) { where.push('p.supplier_id = ?'); params.push(opts.supplierId); }
  if (opts.from) { where.push('p.purchased_at >= ?'); params.push(opts.from); }
  if (opts.to) { where.push('p.purchased_at < ?'); params.push(opts.to); }
  return ctx.db.select<PurchaseRow>(
    `SELECT p.*, s.name AS supplier_name, (SELECT COUNT(*) FROM purchase_items i WHERE i.purchase_id = p.id) AS item_count
     FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE ${where.join(' AND ')} ORDER BY p.purchased_at DESC LIMIT ?`,
    [...params, opts.limit ?? 200]);
}

export async function getPurchase(ctx: AppContext, id: string) {
  requirePermission(ctx, 'purchases.read');
  const purchase = await getById<Purchase>(ctx.db, 'purchases', id);
  if (!purchase) return undefined;
  const items = await ctx.db.select<PurchaseItem & { product_name: string }>(
    `SELECT i.*, p.name AS product_name FROM purchase_items i JOIN products p ON p.id = i.product_id WHERE i.purchase_id = ? AND i.deleted_at IS NULL`, [id]);
  const supplier = purchase.supplier_id ? await getById<Supplier>(ctx.db, 'suppliers', purchase.supplier_id) : undefined;
  return { purchase, items, supplier };
}

// ------------------------------------------------------------------ expenses
export async function listExpenses(ctx: AppContext, from?: string, to?: string): Promise<Expense[]> {
  requirePermission(ctx, 'expenses.manage');
  return ctx.db.select<Expense>(
    'SELECT * FROM expenses WHERE deleted_at IS NULL AND spent_at >= ? AND spent_at < ? ORDER BY spent_at DESC',
    [from ?? '0000', to ?? '9999']);
}

export async function createExpense(ctx: AppContext, input: { category: string; description?: string; amount: number; spent_at?: string }): Promise<Expense> {
  requirePermission(ctx, 'expenses.manage');
  if (!input.category.trim()) fail('errors.requiredFields');
  if (!(input.amount > 0)) fail('errors.invalidAmount');
  return runTx(ctx, async (tx) => {
    const e = await insertRow<Expense>(tx, ctx, 'expenses', {
      category: input.category.trim(), description: input.description?.trim() || null, amount: Math.round(input.amount),
      spent_at: input.spent_at ?? ctx.now().toISOString(), user_id: ctx.user?.id ?? null,
    });
    await audit(tx, ctx, 'expense.created', 'expense', e.id, { amount: e.amount, category: e.category });
    return e;
  });
}

export async function deleteExpense(ctx: AppContext, id: string) {
  requirePermission(ctx, 'expenses.manage');
  await runTx(ctx, async (tx) => { await softDelete(tx, ctx, 'expenses', id); await audit(tx, ctx, 'expense.deleted', 'expense', id); });
}
