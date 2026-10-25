import { fail } from '../lib/errors';
import { audit } from './audit';
import { type AppContext, requirePermission, runTx } from './context';
import { getById, insertRow, softDelete, updateRow } from './repo';
import { normalizeTier } from './pricing';
import type { Customer, PriceTier, Purchase, Sale, Supplier } from './types';

// =================================================================== customers
export interface CustomerRow extends Customer { total_spent: number; purchase_count: number; balance_due: number }

/** Balance is DERIVED (sales debt - payments), never stored, so devices can't disagree on it. */
const CUSTOMER_SELECT = `
  SELECT c.*,
    COALESCE((SELECT SUM(s.total) FROM sales s WHERE s.customer_id = c.id AND s.status='COMPLETED' AND s.deleted_at IS NULL),0) AS total_spent,
    (SELECT COUNT(*) FROM sales s WHERE s.customer_id = c.id AND s.status='COMPLETED' AND s.deleted_at IS NULL) AS purchase_count,
    COALESCE((SELECT SUM(s.total - s.amount_paid) FROM sales s WHERE s.customer_id = c.id AND s.status='COMPLETED' AND s.deleted_at IS NULL),0)
      - COALESCE((SELECT SUM(p.amount) FROM customer_payments p WHERE p.customer_id = c.id AND p.deleted_at IS NULL),0) AS balance_due
  FROM customers c`;

export async function listCustomers(ctx: AppContext, search = ''): Promise<CustomerRow[]> {
  requirePermission(ctx, 'customers.read');
  const rows = await ctx.db.select<CustomerRow>(`${CUSTOMER_SELECT} WHERE c.deleted_at IS NULL ORDER BY c.name COLLATE NOCASE`);
  const s = search.trim().toLowerCase();
  return s ? rows.filter((c) => `${c.name} ${c.phone ?? ''} ${c.email ?? ''}`.toLowerCase().includes(s)) : rows;
}

export async function getCustomerBalance(db: AppContext['db'], id: string): Promise<{ balance_due: number; credit_limit: number } | undefined> {
  return db.selectOne(`SELECT balance_due, credit_limit FROM (${CUSTOMER_SELECT}) WHERE id = ?`, [id]);
}

export interface PartyInput { name: string; phone?: string | null; email?: string | null; address?: string | null }
/** Leaving `price_tier` out keeps the customer's current tier (other callers, like the assistant, never reset it). */
export interface CustomerInput extends PartyInput { credit_limit?: number; price_tier?: PriceTier | string; tax_id?: string | null }

export async function createCustomer(ctx: AppContext, input: CustomerInput): Promise<Customer> {
  requirePermission(ctx, 'customers.create');
  if (!input.name.trim()) fail('errors.requiredFields');
  return runTx(ctx, async (tx) => {
    const c = await insertRow<Customer>(tx, ctx, 'customers', {
      name: input.name.trim(), phone: input.phone?.trim() || null, email: input.email?.trim() || null, address: input.address?.trim() || null,
      credit_limit: Math.max(0, Math.round(input.credit_limit ?? 0)), price_tier: normalizeTier(input.price_tier), tax_id: input.tax_id?.trim() || null,
    });
    await audit(tx, ctx, 'customer.created', 'customer', c.id, { name: c.name, tier: c.price_tier });
    return c;
  });
}

export async function updateCustomer(ctx: AppContext, id: string, input: CustomerInput) {
  requirePermission(ctx, 'customers.update');
  if (!input.name.trim()) fail('errors.requiredFields');
  await runTx(ctx, async (tx) => {
    const before = await tx.selectOne<Customer>('SELECT * FROM customers WHERE id = ? AND deleted_at IS NULL', [id]);
    if (!before) return fail('errors.notFound');
    const next = await updateRow<Customer>(tx, ctx, 'customers', id, {
      name: input.name.trim(), phone: input.phone?.trim() || null, email: input.email?.trim() || null, address: input.address?.trim() || null,
      credit_limit: Math.max(0, Math.round(input.credit_limit ?? 0)),
      ...(input.price_tier !== undefined ? { price_tier: normalizeTier(input.price_tier) } : {}),
      ...(input.tax_id !== undefined ? { tax_id: input.tax_id?.trim() || null } : {}),
    });
    if (before.price_tier !== next.price_tier) await audit(tx, ctx, 'customer.tier_changed', 'customer', id, { from: before.price_tier, to: next.price_tier });
    await audit(tx, ctx, 'customer.updated', 'customer', id);
  });
}

export async function deleteCustomer(ctx: AppContext, id: string) {
  requirePermission(ctx, 'customers.update');
  const bal = await getCustomerBalance(ctx.db, id);
  if (bal && bal.balance_due > 0) fail('errors.customerHasDebt', { amount: bal.balance_due });
  await runTx(ctx, async (tx) => { await softDelete(tx, ctx, 'customers', id); await audit(tx, ctx, 'customer.deleted', 'customer', id); });
}

export async function recordCustomerPayment(ctx: AppContext, customerId: string, amount: number, method: string, note?: string) {
  requirePermission(ctx, 'customers.update');
  if (!(amount > 0)) fail('errors.invalidAmount');
  const bal = await getCustomerBalance(ctx.db, customerId);
  if (!bal) return fail('errors.notFound');
  if (amount > bal.balance_due) fail('errors.overpayment', { due: bal.balance_due });
  await runTx(ctx, async (tx) => {
    const p = await insertRow(tx, ctx, 'customer_payments', {
      customer_id: customerId, amount: Math.round(amount), method, note: note ?? null, paid_at: ctx.now().toISOString(), user_id: ctx.user?.id ?? null,
    });
    await audit(tx, ctx, 'customer.payment', 'customer', customerId, { amount, method, paymentId: p.id });
  });
}

export async function customerHistory(ctx: AppContext, id: string) {
  requirePermission(ctx, 'customers.read');
  const sales = await ctx.db.select<Sale>(`SELECT * FROM sales WHERE customer_id = ? AND deleted_at IS NULL ORDER BY sold_at DESC LIMIT 200`, [id]);
  const payments = await ctx.db.select<any>(`SELECT * FROM customer_payments WHERE customer_id = ? AND deleted_at IS NULL ORDER BY paid_at DESC`, [id]);
  return { sales, payments };
}

// =================================================================== suppliers
export interface SupplierRow extends Supplier { total_purchased: number; purchase_count: number; balance_due: number }

const SUPPLIER_SELECT = `
  SELECT s.*,
    COALESCE((SELECT SUM(p.total) FROM purchases p WHERE p.supplier_id = s.id AND p.deleted_at IS NULL),0) AS total_purchased,
    (SELECT COUNT(*) FROM purchases p WHERE p.supplier_id = s.id AND p.deleted_at IS NULL) AS purchase_count,
    COALESCE((SELECT SUM(p.total - p.amount_paid) FROM purchases p WHERE p.supplier_id = s.id AND p.deleted_at IS NULL),0)
      - COALESCE((SELECT SUM(x.amount) FROM supplier_payments x WHERE x.supplier_id = s.id AND x.deleted_at IS NULL),0) AS balance_due
  FROM suppliers s`;

export async function listSuppliers(ctx: AppContext, search = ''): Promise<SupplierRow[]> {
  requirePermission(ctx, 'suppliers.read');
  const rows = await ctx.db.select<SupplierRow>(`${SUPPLIER_SELECT} WHERE s.deleted_at IS NULL ORDER BY s.name COLLATE NOCASE`);
  const q = search.trim().toLowerCase();
  return q ? rows.filter((s) => `${s.name} ${s.phone ?? ''} ${s.email ?? ''}`.toLowerCase().includes(q)) : rows;
}

export async function createSupplier(ctx: AppContext, input: PartyInput & { notes?: string | null }): Promise<Supplier> {
  requirePermission(ctx, 'suppliers.create');
  if (!input.name.trim()) fail('errors.requiredFields');
  return runTx(ctx, async (tx) => {
    const s = await insertRow<Supplier>(tx, ctx, 'suppliers', {
      name: input.name.trim(), phone: input.phone?.trim() || null, email: input.email?.trim() || null,
      address: input.address?.trim() || null, notes: input.notes?.trim() || null,
    });
    await audit(tx, ctx, 'supplier.created', 'supplier', s.id, { name: s.name });
    return s;
  });
}

export async function updateSupplier(ctx: AppContext, id: string, input: PartyInput & { notes?: string | null }) {
  requirePermission(ctx, 'suppliers.update');
  if (!input.name.trim()) fail('errors.requiredFields');
  await runTx(ctx, async (tx) => {
    await updateRow(tx, ctx, 'suppliers', id, {
      name: input.name.trim(), phone: input.phone?.trim() || null, email: input.email?.trim() || null,
      address: input.address?.trim() || null, notes: input.notes?.trim() || null,
    });
    await audit(tx, ctx, 'supplier.updated', 'supplier', id);
  });
}

export async function deleteSupplier(ctx: AppContext, id: string) {
  requirePermission(ctx, 'suppliers.update');
  const s = await ctx.db.selectOne<SupplierRow>(`SELECT * FROM (${SUPPLIER_SELECT}) WHERE id = ?`, [id]);
  if (s && s.balance_due > 0) fail('errors.supplierHasDebt', { amount: s.balance_due });
  await runTx(ctx, async (tx) => { await softDelete(tx, ctx, 'suppliers', id); await audit(tx, ctx, 'supplier.deleted', 'supplier', id); });
}

export async function recordSupplierPayment(ctx: AppContext, supplierId: string, amount: number, method: string, note?: string) {
  requirePermission(ctx, 'suppliers.update');
  if (!(amount > 0)) fail('errors.invalidAmount');
  const s = await ctx.db.selectOne<SupplierRow>(`SELECT * FROM (${SUPPLIER_SELECT}) WHERE id = ?`, [supplierId]);
  if (!s) return fail('errors.notFound');
  if (amount > s.balance_due) fail('errors.overpayment', { due: s.balance_due });
  await runTx(ctx, async (tx) => {
    await insertRow(tx, ctx, 'supplier_payments', {
      supplier_id: supplierId, amount: Math.round(amount), method, note: note ?? null, paid_at: ctx.now().toISOString(), user_id: ctx.user?.id ?? null,
    });
    await audit(tx, ctx, 'supplier.payment', 'supplier', supplierId, { amount, method });
  });
}

export async function supplierHistory(ctx: AppContext, id: string) {
  requirePermission(ctx, 'suppliers.read');
  const purchases = await ctx.db.select<Purchase>('SELECT * FROM purchases WHERE supplier_id = ? AND deleted_at IS NULL ORDER BY purchased_at DESC LIMIT 200', [id]);
  const products = await ctx.db.select<{ id: string; name: string }>(
    `SELECT DISTINCT p.id, p.name FROM products p WHERE p.deleted_at IS NULL AND (p.supplier_id = ? OR p.id IN
       (SELECT pi.product_id FROM purchase_items pi JOIN purchases pu ON pu.id = pi.purchase_id WHERE pu.supplier_id = ?)) ORDER BY p.name`, [id, id]);
  const payments = await ctx.db.select<any>('SELECT * FROM supplier_payments WHERE supplier_id = ? AND deleted_at IS NULL ORDER BY paid_at DESC', [id]);
  return { purchases, products, payments };
}

export const getSupplier = (ctx: AppContext, id: string) => getById<Supplier>(ctx.db, 'suppliers', id);
export const getCustomer = (ctx: AppContext, id: string) => getById<Customer>(ctx.db, 'customers', id);
