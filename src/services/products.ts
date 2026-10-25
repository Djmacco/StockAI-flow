import { fail } from '../lib/errors';
import { norm, similarity } from '../lib/text';
import { audit } from './audit';
import { type AppContext, requirePermission, runTx } from './context';
import { expiryLevel, stockLevel, type ExpiryLevel, type StockLevel } from './expiry';
import { applyStockChange } from './inventory';
import { getById, softDelete, updateRow, insertRow } from './repo';
import { getSetting } from './settings';
import type { Product } from './types';

export interface ProductListItem extends Product {
  category_name: string | null;
  supplier_name: string | null;
  stock_level: StockLevel;
  expiry_level: ExpiryLevel;
  expiry_days: number | null;
}

export interface ProductInput {
  name: string; sku?: string | null; barcode?: string | null; category_id?: string | null; description?: string | null;
  cost_price: number; selling_price: number; minimum_stock?: number; unit?: string; supplier_id?: string | null; image?: string | null;
  /** Wholesale price. `null` / 0 removes it; leaving the field out keeps the current value. */
  wholesale_price?: number | null;
}

export type SortKey = 'name' | 'selling_price' | 'quantity' | 'expiry_date' | 'updated_at';
export interface ProductQuery {
  search?: string; categoryId?: string | null; status?: 'all' | 'low' | 'out' | 'expiring' | 'expired';
  sort?: SortKey; dir?: 'asc' | 'desc'; limit?: number; offset?: number;
}

const SORT_SQL: Record<SortKey, string> = {
  name: 'p.name COLLATE NOCASE', selling_price: 'p.selling_price', quantity: 'p.quantity',
  expiry_date: '(p.expiry_date IS NULL), p.expiry_date', updated_at: 'p.updated_at',
};

async function alertDays(ctx: AppContext): Promise<number[]> {
  try { return JSON.parse(await getSetting(ctx.db, 'expiry_alert_days')); } catch { return [30, 7, 1]; }
}

function decorate(rows: any[], now: Date, days: number[]): ProductListItem[] {
  return rows.map((r) => {
    const e = expiryLevel(r.expiry_date, now, days);
    return { ...r, stock_level: stockLevel(r.quantity, r.minimum_stock), expiry_level: e.level, expiry_days: e.days } as ProductListItem;
  });
}

export async function listProducts(ctx: AppContext, q: ProductQuery = {}): Promise<{ items: ProductListItem[]; total: number }> {
  requirePermission(ctx, 'products.read');
  const where = ['p.deleted_at IS NULL']; const params: any[] = [];
  if (q.categoryId) { where.push('p.category_id = ?'); params.push(q.categoryId); }
  if (q.status === 'out') where.push('p.quantity <= 0');
  if (q.status === 'low') where.push('p.quantity > 0 AND p.minimum_stock > 0 AND p.quantity <= p.minimum_stock');
  const days = await alertDays(ctx);
  const now = ctx.now();
  const base = `FROM products p LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN suppliers s ON s.id = p.supplier_id WHERE ${where.join(' AND ')}`;
  const order = `${SORT_SQL[q.sort ?? 'name']} ${q.dir === 'desc' ? 'DESC' : 'ASC'}`;
  let rows = await ctx.db.select(`SELECT p.*, c.name AS category_name, s.name AS supplier_name ${base} ORDER BY ${order}`, params);
  let items = decorate(rows, now, days);
  if (q.search?.trim()) {
    const s = norm(q.search);
    items = items.filter((p) => norm(`${p.name} ${p.sku ?? ''} ${p.barcode ?? ''} ${p.category_name ?? ''}`).includes(s));
  }
  if (q.status === 'expiring') items = items.filter((p) => ['CRITICAL', 'WARNING', 'NOTICE'].includes(p.expiry_level));
  if (q.status === 'expired') items = items.filter((p) => p.expiry_level === 'EXPIRED');
  const total = items.length;
  if (q.limit) items = items.slice(q.offset ?? 0, (q.offset ?? 0) + q.limit);
  rows = [];
  return { items, total };
}

export async function getProduct(ctx: AppContext, id: string): Promise<ProductListItem | undefined> {
  const r = await ctx.db.selectOne(
    `SELECT p.*, c.name AS category_name, s.name AS supplier_name FROM products p
     LEFT JOIN categories c ON c.id = p.category_id LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.id = ? AND p.deleted_at IS NULL`, [id]);
  return r ? decorate([r], ctx.now(), await alertDays(ctx))[0] : undefined;
}

export async function findByBarcodeOrSku(ctx: AppContext, code: string): Promise<Product | undefined> {
  const c = code.trim();
  if (!c) return undefined;
  return ctx.db.selectOne<Product>(
    'SELECT * FROM products WHERE deleted_at IS NULL AND (barcode = ? OR lower(sku) = lower(?)) LIMIT 1', [c, c]);
}

/** Fuzzy search used by POS, purchase forms and the AI assistant. */
export async function searchProducts(ctx: AppContext, text: string, limit = 8): Promise<(Product & { score: number })[]> {
  const rows = await ctx.db.select<Product>('SELECT * FROM products WHERE deleted_at IS NULL');
  return rows
    .map((p) => ({ ...p, score: Math.max(similarity(text, p.name), p.sku ? similarity(text, p.sku) : 0) }))
    .filter((p) => p.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function validate(ctx: AppContext, input: ProductInput, exceptId?: string) {
  if (!input.name?.trim()) fail('errors.requiredFields');
  if (!(input.cost_price >= 0) || !(input.selling_price >= 0)) fail('errors.invalidPrice');
  if ((input.minimum_stock ?? 0) < 0) fail('errors.invalidQuantity');
  if (input.wholesale_price != null) {
    if (!(input.wholesale_price >= 0)) fail('errors.invalidPrice');
    if (input.wholesale_price > input.selling_price) fail('errors.wholesaleAboveRetail');
  }
  if (input.sku?.trim()) {
    const d = await ctx.db.selectOne('SELECT 1 x FROM products WHERE lower(sku)=lower(?) AND deleted_at IS NULL AND id <> ?', [input.sku.trim(), exceptId ?? '']);
    if (d) fail('errors.skuExists', { sku: input.sku });
  }
  if (input.barcode?.trim()) {
    const d = await ctx.db.selectOne('SELECT 1 x FROM products WHERE barcode=? AND deleted_at IS NULL AND id <> ?', [input.barcode.trim(), exceptId ?? '']);
    if (d) fail('errors.barcodeExists', { barcode: input.barcode });
  }
}

const clean = (i: ProductInput) => ({
  name: i.name.trim(), sku: i.sku?.trim() || null, barcode: i.barcode?.trim() || null, category_id: i.category_id || null,
  description: i.description?.trim() || null, cost_price: Math.round(i.cost_price), selling_price: Math.round(i.selling_price),
  minimum_stock: i.minimum_stock ?? 0, unit: i.unit?.trim() || 'pcs', supplier_id: i.supplier_id || null, image: i.image ?? null,
  ...(i.wholesale_price !== undefined ? { wholesale_price: i.wholesale_price && i.wholesale_price > 0 ? Math.round(i.wholesale_price) : null } : {}),
});

export async function createProduct(
  ctx: AppContext, input: ProductInput & { initial_quantity?: number; expiry_date?: string | null; lot_code?: string | null },
): Promise<Product> {
  requirePermission(ctx, 'products.create');
  await validate(ctx, input);
  return runTx(ctx, async (tx) => {
    const p = await insertRow<Product>(tx, ctx, 'products', { ...clean(input), quantity: 0, expiry_date: null });
    let result = p;
    if ((input.initial_quantity ?? 0) > 0) {
      const r = await applyStockChange(tx, ctx, {
        productId: p.id, delta: input.initial_quantity!, type: 'INITIAL', reason: 'Initial stock',
        newBatch: input.expiry_date ? { expiry_date: input.expiry_date, lot_code: input.lot_code ?? null } : null,
      });
      result = r.product;
    }
    await audit(tx, ctx, 'product.created', 'product', p.id, { name: p.name, price: p.selling_price, initial: input.initial_quantity ?? 0 });
    return result;
  });
}

export async function updateProduct(ctx: AppContext, id: string, input: ProductInput): Promise<Product> {
  requirePermission(ctx, 'products.update');
  const before = await getById<Product>(ctx.db, 'products', id);
  if (!before) return fail('errors.productNotFound');
  await validate(ctx, input, id);
  return runTx(ctx, async (tx) => {
    const next = await updateRow<Product>(tx, ctx, 'products', id, clean(input));
    if (before.selling_price !== next.selling_price)
      await audit(tx, ctx, 'product.price_changed', 'product', id, { field: 'selling_price', from: before.selling_price, to: next.selling_price });
    if (before.cost_price !== next.cost_price)
      await audit(tx, ctx, 'product.price_changed', 'product', id, { field: 'cost_price', from: before.cost_price, to: next.cost_price });
    if ((before.wholesale_price ?? null) !== (next.wholesale_price ?? null))
      await audit(tx, ctx, 'product.price_changed', 'product', id, { field: 'wholesale_price', from: before.wholesale_price ?? null, to: next.wholesale_price ?? null });
    await audit(tx, ctx, 'product.updated', 'product', id, { name: next.name });
    return next;
  });
}

export async function updateProductPrice(ctx: AppContext, id: string, selling_price: number): Promise<Product> {
  requirePermission(ctx, 'products.update');
  const p = await getById<Product>(ctx.db, 'products', id);
  if (!p) return fail('errors.productNotFound');
  if (!(selling_price >= 0)) fail('errors.invalidPrice');
  return runTx(ctx, async (tx) => {
    const next = await updateRow<Product>(tx, ctx, 'products', id, { selling_price: Math.round(selling_price) });
    await audit(tx, ctx, 'product.price_changed', 'product', id, { field: 'selling_price', from: p.selling_price, to: next.selling_price });
    return next;
  });
}

/** Soft delete: history (sales, movements) keeps referencing the product. */
export async function deleteProduct(ctx: AppContext, id: string) {
  requirePermission(ctx, 'products.delete');
  const p = await getById<Product>(ctx.db, 'products', id);
  if (!p) return fail('errors.productNotFound');
  await runTx(ctx, async (tx) => {
    await softDelete(tx, ctx, 'products', id);
    await audit(tx, ctx, 'product.deleted', 'product', id, { name: p.name, stock: p.quantity });
  });
}

/** Product names used to bias speech recognition toward this shop's own words (most recently touched first). */
export async function speechVocabulary(ctx: AppContext, limit = 40): Promise<string[]> {
  const rows = await ctx.db.select<{ name: string }>('SELECT name FROM products WHERE deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?', [limit]);
  return rows.map((r) => r.name);
}
