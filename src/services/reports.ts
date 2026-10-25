import { addDays, iso, startOfDay, startOfMonth, startOfWeek } from '../lib/time';
import { type AppContext, requirePermission } from './context';
import { expiryLevel } from './expiry';
import { getSetting } from './settings';
import type { Purchase, Sale } from './types';

export interface DateRange { from: Date; to: Date } // [from, to)

export const rangeToday = (now: Date): DateRange => ({ from: startOfDay(now), to: addDays(startOfDay(now), 1) });
export const rangeWeek = (now: Date): DateRange => ({ from: startOfWeek(now), to: addDays(startOfWeek(now), 7) });
export const rangeMonth = (now: Date): DateRange => ({ from: startOfMonth(now), to: new Date(now.getFullYear(), now.getMonth() + 1, 1) });
/** The most recently completed Monday-to-Sunday week. */
export const rangeLastWeek = (now: Date): DateRange => ({ from: addDays(startOfWeek(now), -7), to: startOfWeek(now) });
/** The trailing 14 local calendar days, including today. */
export const rangeLastTwoWeeks = (now: Date): DateRange => ({ from: addDays(startOfDay(now), -13), to: addDays(startOfDay(now), 1) });
/** The most recently completed calendar month. */
export const rangeLastMonth = (now: Date): DateRange => {
  const to = startOfMonth(now);
  return { from: new Date(to.getFullYear(), to.getMonth() - 1, 1), to };
};

export interface SalesSummary {
  count: number; revenue: number; discounts: number; cost: number; profit: number; margin: number; cancelled: number; avg_ticket: number;
}

export async function salesSummary(ctx: AppContext, r: DateRange): Promise<SalesSummary> {
  const rows = await ctx.db.select<Sale>('SELECT * FROM sales WHERE deleted_at IS NULL AND sold_at >= ? AND sold_at < ?', [iso(r.from), iso(r.to)]);
  const done = rows.filter((s) => s.status === 'COMPLETED');
  const revenue = done.reduce((s, x) => s + x.total, 0);
  const cost = done.reduce((s, x) => s + x.cost_total, 0);
  return {
    count: done.length, revenue, discounts: done.reduce((s, x) => s + x.discount_total, 0), cost, profit: revenue - cost,
    margin: revenue ? ((revenue - cost) / revenue) * 100 : 0, cancelled: rows.length - done.length, avg_ticket: done.length ? revenue / done.length : 0,
  };
}

export interface PaymentMethodSales { method: string; count: number; salesTotal: number; collected: number }

/** Completed sales grouped by the method recorded at checkout. `collected` excludes any unpaid customer balance. */
export async function salesByPaymentMethod(ctx: AppContext, r: DateRange): Promise<PaymentMethodSales[]> {
  requirePermission(ctx, 'reports.read');
  return ctx.db.select<PaymentMethodSales>(
    `SELECT payment_method AS method, COUNT(*) AS count, COALESCE(SUM(total), 0) AS salesTotal,
       COALESCE(SUM(amount_paid), 0) AS collected
     FROM sales
     WHERE deleted_at IS NULL AND status = 'COMPLETED' AND sold_at >= ? AND sold_at < ?
     GROUP BY payment_method ORDER BY collected DESC`, [iso(r.from), iso(r.to)]);
}

export interface DayPoint { day: string; revenue: number; profit: number; count: number }

/** Revenue / profit per local calendar day inside the range (gaps filled with zeros). */
export async function dailySeries(ctx: AppContext, r: DateRange): Promise<DayPoint[]> {
  requirePermission(ctx, 'reports.read');
  const rows = await ctx.db.select<Sale>("SELECT * FROM sales WHERE deleted_at IS NULL AND status='COMPLETED' AND sold_at >= ? AND sold_at < ?", [iso(r.from), iso(r.to)]);
  const key = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const map = new Map<string, DayPoint>();
  for (let d = startOfDay(r.from); d < r.to; d = addDays(d, 1)) map.set(key(d), { day: key(d), revenue: 0, profit: 0, count: 0 });
  rows.forEach((s) => {
    const p = map.get(key(new Date(s.sold_at)));
    if (p) { p.revenue += s.total; p.profit += s.total - s.cost_total; p.count++; }
  });
  return [...map.values()];
}

export interface ProductPerf { product_id: string; name: string; unit: string; quantity: number; revenue: number; profit: number }

export async function productPerformance(ctx: AppContext, r: DateRange): Promise<ProductPerf[]> {
  requirePermission(ctx, 'reports.read');
  return ctx.db.select<ProductPerf>(
    `SELECT i.product_id, COALESCE(p.name, i.product_name) AS name, COALESCE(p.unit,'') AS unit,
       SUM(i.quantity) AS quantity, SUM(i.line_total) AS revenue, SUM(i.line_total - ROUND(i.unit_cost * i.quantity)) AS profit
     FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN products p ON p.id = i.product_id
     WHERE s.status='COMPLETED' AND s.deleted_at IS NULL AND i.deleted_at IS NULL AND s.sold_at >= ? AND s.sold_at < ?
     GROUP BY i.product_id`, [iso(r.from), iso(r.to)]);
}

export async function bestSellers(ctx: AppContext, r: DateRange, limit = 10) {
  return (await productPerformance(ctx, r)).sort((a, b) => b.quantity - a.quantity).slice(0, limit);
}
export async function mostProfitable(ctx: AppContext, r: DateRange, limit = 10) {
  return (await productPerformance(ctx, r)).sort((a, b) => b.profit - a.profit).slice(0, limit);
}

/** Active products with no (or very few) sales in the range: slow movers. */
export async function slowMovers(ctx: AppContext, r: DateRange, limit = 10) {
  requirePermission(ctx, 'reports.read');
  return ctx.db.select<{ id: string; name: string; quantity: number; sold: number }>(
    `SELECT p.id, p.name, p.quantity, COALESCE((SELECT SUM(i.quantity) FROM sale_items i JOIN sales s ON s.id = i.sale_id
        WHERE i.product_id = p.id AND s.status='COMPLETED' AND s.deleted_at IS NULL AND s.sold_at >= ? AND s.sold_at < ?),0) AS sold
     FROM products p WHERE p.deleted_at IS NULL AND p.quantity > 0 ORDER BY sold ASC, p.quantity DESC LIMIT ?`, [iso(r.from), iso(r.to), limit]);
}

export async function topCustomers(ctx: AppContext, r: DateRange, limit = 10) {
  requirePermission(ctx, 'reports.read');
  return ctx.db.select<{ customer_id: string; name: string; total: number; count: number }>(
    `SELECT c.id AS customer_id, c.name, SUM(s.total) AS total, COUNT(*) AS count FROM sales s JOIN customers c ON c.id = s.customer_id
     WHERE s.status='COMPLETED' AND s.deleted_at IS NULL AND s.sold_at >= ? AND s.sold_at < ? GROUP BY c.id ORDER BY total DESC LIMIT ?`,
    [iso(r.from), iso(r.to), limit]);
}

export async function supplierPurchases(ctx: AppContext, r: DateRange) {
  requirePermission(ctx, 'reports.read');
  return ctx.db.select<{ supplier_id: string | null; name: string | null; total: number; count: number }>(
    `SELECT p.supplier_id, s.name, SUM(p.total) AS total, COUNT(*) AS count FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
     WHERE p.deleted_at IS NULL AND p.purchased_at >= ? AND p.purchased_at < ? GROUP BY p.supplier_id ORDER BY total DESC`, [iso(r.from), iso(r.to)]);
}

export async function purchaseTotals(ctx: AppContext, r: DateRange) {
  const rows = await ctx.db.select<Purchase>('SELECT * FROM purchases WHERE deleted_at IS NULL AND purchased_at >= ? AND purchased_at < ?', [iso(r.from), iso(r.to)]);
  return { count: rows.length, total: rows.reduce((s, p) => s + p.total, 0), paid: rows.reduce((s, p) => s + p.amount_paid, 0) };
}

export async function expenseTotal(ctx: AppContext, r: DateRange) {
  return (await ctx.db.selectOne<{ t: number | null }>('SELECT SUM(amount) t FROM expenses WHERE deleted_at IS NULL AND spent_at >= ? AND spent_at < ?', [iso(r.from), iso(r.to)]))?.t ?? 0;
}

export interface InventoryValue { value_cost: number; value_retail: number; products: number; units: number }
export async function inventoryValue(ctx: AppContext): Promise<InventoryValue> {
  const r = await ctx.db.selectOne<any>(
    `SELECT COALESCE(SUM(MAX(quantity,0) * cost_price),0) vc, COALESCE(SUM(MAX(quantity,0) * selling_price),0) vr, COUNT(*) n, COALESCE(SUM(MAX(quantity,0)),0) u
     FROM products WHERE deleted_at IS NULL`);
  return { value_cost: Math.round(r.vc), value_retail: Math.round(r.vr), products: r.n, units: r.u };
}

export interface ExpiringBatch { id: string; product_id: string; product_name: string; lot_code: string | null; expiry_date: string; quantity_remaining: number; unit: string; days: number; level: string }
export async function expiringBatches(ctx: AppContext): Promise<{ expired: ExpiringBatch[]; soon: ExpiringBatch[] }> {
  let days = [30, 7, 1];
  try { days = JSON.parse(await getSetting(ctx.db, 'expiry_alert_days')); } catch { /* defaults */ }
  const rows = await ctx.db.select<any>(
    `SELECT b.id, b.product_id, p.name AS product_name, b.lot_code, b.expiry_date, b.quantity_remaining, p.unit
     FROM product_batches b JOIN products p ON p.id = b.product_id
     WHERE b.deleted_at IS NULL AND p.deleted_at IS NULL AND b.quantity_remaining > 0 AND b.expiry_date IS NOT NULL ORDER BY b.expiry_date`);
  const now = ctx.now();
  const out = { expired: [] as ExpiringBatch[], soon: [] as ExpiringBatch[] };
  for (const b of rows) {
    const e = expiryLevel(b.expiry_date, now, days);
    const row = { ...b, days: e.days!, level: e.level } as ExpiringBatch;
    if (e.level === 'EXPIRED') out.expired.push(row);
    else if (e.level === 'CRITICAL' || e.level === 'WARNING' || e.level === 'NOTICE') out.soon.push(row);
  }
  return out;
}

export async function lowStockProducts(ctx: AppContext, limit = 100) {
  return ctx.db.select<{ id: string; name: string; quantity: number; minimum_stock: number; unit: string }>(
    `SELECT id, name, quantity, minimum_stock, unit FROM products WHERE deleted_at IS NULL AND (quantity <= 0 OR (minimum_stock > 0 AND quantity <= minimum_stock))
     ORDER BY quantity ASC LIMIT ?`, [limit]);
}

export interface DashboardData {
  today: SalesSummary; yesterday: SalesSummary; stock: InventoryValue;
  low: Awaited<ReturnType<typeof lowStockProducts>>; expiry: Awaited<ReturnType<typeof expiringBatches>>;
  recentSales: (Sale & { customer_name: string | null })[];
  recentMovements: { id: string; product_name: string; type: string; quantity: number; created_at: string; unit: string }[];
  recentPurchases: { id: string; reference: string; total: number; supplier_name: string | null; purchased_at: string }[];
  sparkline: DayPoint[];
}

export async function dashboard(ctx: AppContext): Promise<DashboardData> {
  const now = ctx.now();
  const today = rangeToday(now);
  const yesterday: DateRange = { from: addDays(today.from, -1), to: today.from };
  const canSales = ctx.permissions.has('sales.read');
  const canPurch = ctx.permissions.has('purchases.read');
  return {
    today: await salesSummary(ctx, today), yesterday: await salesSummary(ctx, yesterday),
    stock: await inventoryValue(ctx), low: await lowStockProducts(ctx, 8), expiry: await expiringBatches(ctx),
    recentSales: canSales ? await ctx.db.select(
      `SELECT s.*, COALESCE(c.name, s.customer_name) AS customer_name FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE s.deleted_at IS NULL ORDER BY s.sold_at DESC LIMIT 6`) : [],
    recentMovements: await ctx.db.select(
      `SELECT m.id, p.name AS product_name, m.type, m.quantity, m.created_at, p.unit FROM stock_movements m JOIN products p ON p.id = m.product_id
       ORDER BY m.created_at DESC, m.rowid DESC LIMIT 6`),
    recentPurchases: canPurch ? await ctx.db.select(
      `SELECT p.id, p.reference, p.total, s.name AS supplier_name, p.purchased_at FROM purchases p LEFT JOIN suppliers s ON s.id = p.supplier_id
       WHERE p.deleted_at IS NULL ORDER BY p.purchased_at DESC LIMIT 5`) : [],
    sparkline: canSales ? await dailySeries({ ...ctx, permissions: new Set([...ctx.permissions, 'reports.read']) }, { from: addDays(today.from, -6), to: today.to }) : [],
  };
}
