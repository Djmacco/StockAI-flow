import type { Db } from '../database/db';
import { fail } from '../lib/errors';
import { round3 } from '../lib/format';
import { uuid } from '../lib/ids';
import { audit } from './audit';
import { markCheckoutInFlight } from './checkoutJournal';
import { type AppContext, can, requirePermission, requireUser, runTx } from './context';
import { applyStockChange } from './inventory';
import { getCustomerBalance } from './parties';
import { normalizeTier, unitPriceFor } from './pricing';
import { getById, insertRow, updateRow } from './repo';
import { getPaymentMethods, getSetting, setSetting } from './settings';
import type { CashSession, Customer, PriceTier, Product, Sale, SaleItem, StockMovement } from './types';

export interface CartLine {
  product_id: string;
  quantity: number;
  /** Override of the price that applies to this customer (retail or wholesale). Needs the `sales.discount` permission. */
  unit_price?: number;
  /** Absolute discount on this line, in FCFA. */
  discount?: number;
}
export interface SaleInput {
  lines: CartLine[];
  customer_id?: string | null;
  /** Optional name printed on the receipt (for customers without an account). Ignored when a registered customer is chosen. */
  customer_name?: string | null;
  payment_method: string;
  /** Money handed over by the customer. Less than total = credit sale (customer required). Default: exact total. */
  amount_tendered?: number;
  /** Extra discount on the whole cart, in FCFA. */
  cart_discount?: number;
  notes?: string | null;
  /** Set only when turning a proforma into a sale: the quoted prices are honoured without the discount permission. */
  honor_quoted_prices?: boolean;
}
export interface SaleResult { sale: Sale; items: SaleItem[] }

const fallbackDeviceCode = (ctx: AppContext) => ctx.deviceId.replace(/-/g, '').slice(-4).toUpperCase();
const ymd = (d: Date) => `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;

export interface PreparedLine { product: Product; qty: number; price: number; discount: number; gross: number }
export interface PricedCart { prepared: PreparedLine[]; subtotal: number; cartDiscount: number; discountTotal: number; total: number }

/**
 * The pricing and discount rules of a cart, in ONE place so a sale and a proforma can never disagree:
 * price list by customer tier, price-override permission, line / cart discounts, maximum discount percentage.
 * `honor_quoted_prices` (a proforma becoming a sale) keeps the quoted prices and discounts: they were authorised when quoted.
 */
export async function priceCart(tx: Db, ctx: AppContext, input: Pick<SaleInput, 'lines' | 'cart_discount' | 'honor_quoted_prices'>, tier: PriceTier): Promise<PricedCart> {
  const user = requireUser(ctx);
  const prepared: PreparedLine[] = [];
  for (const l of input.lines) {
    const product = await tx.selectOne<Product>('SELECT * FROM products WHERE id = ? AND deleted_at IS NULL', [l.product_id]);
    if (!product) return fail('errors.productNotFound');
    const qty = round3(l.quantity);
    if (!(qty > 0)) fail('errors.invalidQuantity');
    const tierPrice = unitPriceFor(product, tier);
    const price = l.unit_price ?? tierPrice;
    if (!(price >= 0)) fail('errors.invalidPrice');
    if (price !== tierPrice && !input.honor_quoted_prices && !can(ctx, 'sales.discount')) fail('errors.priceOverrideForbidden');
    const gross = Math.round(qty * price);
    const discount = Math.round(l.discount ?? 0);
    if (discount < 0 || discount > gross) fail('errors.invalidDiscount');
    prepared.push({ product, qty, price, discount, gross });
  }
  const subtotal = prepared.reduce((s, l) => s + l.gross, 0);
  const cartDiscount = Math.round(input.cart_discount ?? 0);
  const discountTotal = prepared.reduce((s, l) => s + l.discount, 0) + cartDiscount;
  if (cartDiscount < 0 || discountTotal > subtotal) fail('errors.invalidDiscount');
  if (discountTotal > 0 && !input.honor_quoted_prices) {
    if (!can(ctx, 'sales.discount')) fail('errors.discountForbidden');
    const maxPct = parseFloat(await getSetting(tx, 'max_discount_percent')) || 100;
    if (user.role_code !== 'ADMIN' && subtotal > 0 && (discountTotal / subtotal) * 100 > maxPct) fail('errors.discountTooHigh', { max: maxPct });
  }
  return { prepared, subtotal, cartDiscount, discountTotal, total: subtotal - discountTotal };
}

/**
 * Create a sale. Everything below happens in ONE transaction: either the sale, its lines,
 * the stock reduction, the ledger rows and the sync-queue entries all exist, or none do.
 *   validate -> check stock -> totals -> sale -> items -> stock (FEFO) -> ledger -> queue
 */
export async function createSale(ctx: AppContext, input: SaleInput): Promise<SaleResult> {
  requirePermission(ctx, 'sales.create');
  const user = requireUser(ctx);
  if (!input.lines.length) fail('errors.emptyCart');

  const methods = await getPaymentMethods(ctx.db);
  if (!methods.some((m) => m.code === input.payment_method && m.enabled)) fail('errors.invalidPaymentMethod');

  const saleId = uuid();
  const coordinated = !!ctx.authorizeShopSale;
  if (coordinated) {
    markCheckoutInFlight(saleId, true);
    try {
      // Durable intent closes the crash window between the hub reservation and local SQLite commit.
      await ctx.db.execute('INSERT INTO local_sale_intents (id, created_at) VALUES (?, ?)', [saleId, ctx.now().toISOString()]);
      await ctx.authorizeShopSale!(saleId, input.lines.map((l) => ({ productId: l.product_id, quantity: round3(l.quantity) })));
    } catch (error) {
      markCheckoutInFlight(saleId, false);
      throw error;
    }
  }

  try {
  const result = await runTx(ctx, async (tx) => {
    // 0. who buys decides the price list: registered wholesale customers get wholesale prices automatically
    const registered = input.customer_id ? await getById<Customer>(tx, 'customers', input.customer_id) : undefined;
    if (input.customer_id && !registered) fail('errors.notFound');
    const tier = normalizeTier(registered?.price_tier);

    // 1-2. prices of the right list, line checks, totals, discount policy (shared with proformas: services/documents.ts)
    const { prepared, subtotal, discountTotal, total } = await priceCart(tx, ctx, input, tier);

    // 3. payment / credit
    const tendered = Math.round(input.amount_tendered ?? total);
    if (tendered < 0) fail('errors.invalidAmount');
    const amountPaid = Math.min(total, tendered);
    const change = Math.max(0, tendered - total);
    const debt = total - amountPaid;
    if (debt > 0) {
      if (!input.customer_id) fail('errors.creditNeedsCustomer');
      const bal = await getCustomerBalance(tx, input.customer_id!);
      if (!bal) return fail('errors.notFound');
      if (bal.credit_limit > 0 && bal.balance_due + debt > bal.credit_limit) fail('errors.creditLimitExceeded', { limit: bal.credit_limit });
    }
    // Snapshot of the name: the receipt stays correct even if the customer is renamed or deleted later.
    const receiptName = (registered?.name ?? input.customer_name?.trim().slice(0, 60)) || null;

    // 4. sale header
    const session = await tx.selectOne<CashSession>("SELECT * FROM cash_sessions WHERE user_id = ? AND status = 'OPEN' AND deleted_at IS NULL LIMIT 1", [user.id]);
    const storedCounter = Number.parseInt(await getSetting(tx, 'receipt_counter'), 10) || 0;
    // Paired PCs use the unique code assigned by the main PC, including while the hub is offline.
    // Standalone installs keep the existing short device suffix.
    const pairedCode = (await getSetting(tx, 'net_device_code')).trim().toUpperCase();
    const receiptDeviceCode = /^[A-Z]{1,2}$/.test(pairedCode) ? pairedCode : fallbackDeviceCode(ctx);
    const previous = await tx.selectOne<{ n: number | null }>(
      "SELECT MAX(CAST(substr(receipt_no, 12 + length(?), 20) AS INTEGER)) n FROM sales WHERE receipt_no GLOB ?",
      [receiptDeviceCode, `R????????-${receiptDeviceCode}-[0-9]*`],
    );
    const counter = Math.max(storedCounter, previous?.n ?? 0) + 1;
    await setSetting(tx, 'receipt_counter', String(counter));
    const sale = await insertRow<Sale>(tx, ctx, 'sales', {
      receipt_no: `R${ymd(ctx.now())}-${receiptDeviceCode}-${String(counter).padStart(4, '0')}`,
      customer_id: input.customer_id ?? null, customer_name: receiptName, user_id: user.id, user_name: user.full_name, cash_session_id: session?.id ?? null,
      subtotal, discount_total: discountTotal, total, amount_paid: amountPaid, change_due: change, payment_method: input.payment_method,
      cost_total: 0, status: 'COMPLETED', notes: input.notes ?? null, sold_at: ctx.now().toISOString(), cancelled_at: null, cancel_reason: null,
      price_tier: tier,
    }, saleId);

    // 5. lines + stock reduction + ledger (throws on insufficient stock -> whole sale rolls back)
    const items: SaleItem[] = [];
    let costTotal = 0;
    for (const l of prepared) {
      const stock = await applyStockChange(tx, ctx, {
        productId: l.product.id, delta: -l.qty, type: 'SALE', referenceType: 'sale', referenceId: sale.id, reason: sale.receipt_no,
      });
      const unitCost = Math.round(stock.unitCostAvg);
      costTotal += Math.round(unitCost * l.qty);
      items.push(await insertRow<SaleItem>(tx, ctx, 'sale_items', {
        sale_id: sale.id, product_id: l.product.id, product_name: l.product.name, quantity: l.qty, unit_price: l.price,
        unit_cost: unitCost, discount: l.discount, line_total: l.gross - l.discount,
      }));
    }
    // Cart-level discount is spread nowhere: it lives on the sale header only (line_total sum + cartDiscount = total).
    const finalSale = await updateRow<Sale>(tx, ctx, 'sales', sale.id, { cost_total: costTotal });
    await audit(tx, ctx, 'sale.created', 'sale', sale.id, { receipt: sale.receipt_no, total, items: items.length, method: input.payment_method });
    return { sale: finalSale, items };
  });
  return result;
  } catch (error) {
    if (coordinated) {
      // A committed local sale keeps its intent for sync recovery. On transaction failure the
      // sale row does not exist, so release the reserved quantity and clear the journal.
      let committed: { found: number } | undefined | null;
      try { committed = await ctx.db.selectOne<{ found: number }>('SELECT 1 AS found FROM sales WHERE id = ?', [saleId]); }
      catch { committed = null; } // an unreadable local commit state is ambiguous; keep the durable intent and reservation
      if (committed === undefined) {
        try {
          if (ctx.releaseShopSale) {
            await ctx.releaseShopSale(saleId);
            await ctx.db.execute('DELETE FROM local_sale_intents WHERE id = ?', [saleId]);
          }
        } catch { /* keep the intent so the next connection can release an ambiguous reservation */ }
      }
    }
    throw error;
  } finally {
    if (coordinated) markCheckoutInFlight(saleId, false);
  }
}

/**
 * Cancelling never deletes anything: the sale is flagged CANCELLED and compensating ledger
 * rows put the stock back (into the very same batches). Completed financial records stay intact.
 */
export async function cancelSale(ctx: AppContext, saleId: string, reason: string): Promise<Sale> {
  requirePermission(ctx, 'sales.cancel');
  if (!reason.trim()) fail('errors.reasonRequired');
  return runTx(ctx, async (tx) => {
    const sale = await getById<Sale>(tx, 'sales', saleId);
    if (!sale) return fail('errors.notFound');
    if (sale.status === 'CANCELLED') fail('errors.alreadyCancelled');
    const moves = await tx.select<StockMovement>(
      "SELECT * FROM stock_movements WHERE reference_type = 'sale' AND reference_id = ? AND type = 'SALE' ORDER BY rowid", [saleId]);
    for (const m of moves) {
      await applyStockChange(tx, ctx, {
        productId: m.product_id, delta: -m.quantity, type: 'SALE_CANCEL', referenceType: 'sale', referenceId: saleId,
        reason: `${sale.receipt_no}: ${reason}`, toBatchId: m.batch_id, unitCost: m.unit_cost,
      });
    }
    const next = await updateRow<Sale>(tx, ctx, 'sales', saleId, { status: 'CANCELLED', cancelled_at: ctx.now().toISOString(), cancel_reason: reason.trim() });
    // An invoice is the printed face of its sale: cancelling the sale cancels the invoice (the number is kept, never reused).
    const invoices = await tx.select<{ id: string }>("SELECT id FROM documents WHERE sale_id = ? AND doc_type = 'INVOICE' AND status = 'ISSUED' AND deleted_at IS NULL", [saleId]);
    for (const d of invoices) await updateRow(tx, ctx, 'documents', d.id, { status: 'CANCELLED', cancelled_at: ctx.now().toISOString(), cancel_reason: reason.trim() });
    await audit(tx, ctx, 'sale.cancelled', 'sale', saleId, { receipt: sale.receipt_no, total: sale.total, reason });
    return next;
  });
}

export interface SaleListRow extends Sale { customer_name: string | null; item_count: number }
export async function listSales(
  ctx: AppContext, opts: { from?: string; to?: string; status?: string; customerId?: string; search?: string; limit?: number; offset?: number } = {},
): Promise<SaleListRow[]> {
  requirePermission(ctx, 'sales.read');
  const where = ['s.deleted_at IS NULL']; const params: any[] = [];
  if (opts.from) { where.push('s.sold_at >= ?'); params.push(opts.from); }
  if (opts.to) { where.push('s.sold_at < ?'); params.push(opts.to); }
  if (opts.status) { where.push('s.status = ?'); params.push(opts.status); }
  if (opts.customerId) { where.push('s.customer_id = ?'); params.push(opts.customerId); }
  if (opts.search?.trim()) { where.push('(s.receipt_no LIKE ? OR c.name LIKE ? OR s.customer_name LIKE ?)'); params.push(`%${opts.search.trim()}%`, `%${opts.search.trim()}%`, `%${opts.search.trim()}%`); }
  return ctx.db.select<SaleListRow>(
    `SELECT s.*, COALESCE(c.name, s.customer_name) AS customer_name, (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = s.id) AS item_count
     FROM sales s LEFT JOIN customers c ON c.id = s.customer_id WHERE ${where.join(' AND ')}
     ORDER BY s.sold_at DESC LIMIT ? OFFSET ?`, [...params, opts.limit ?? 200, opts.offset ?? 0]);
}

export async function getSale(ctx: AppContext, id: string) {
  requirePermission(ctx, 'sales.read');
  const sale = await getById<Sale>(ctx.db, 'sales', id);
  if (!sale) return undefined;
  const items = await ctx.db.select<SaleItem>('SELECT * FROM sale_items WHERE sale_id = ? AND deleted_at IS NULL ORDER BY rowid', [id]);
  const customer = sale.customer_id ? await getById<Customer>(ctx.db, 'customers', sale.customer_id) : undefined;
  return { sale, items, customer };
}

// ------------------------------------------------------------------ cash register sessions (Z report)
export async function getOpenSession(ctx: AppContext): Promise<CashSession | undefined> {
  if (!ctx.user) return undefined;
  return ctx.db.selectOne<CashSession>("SELECT * FROM cash_sessions WHERE user_id = ? AND status = 'OPEN' AND deleted_at IS NULL LIMIT 1", [ctx.user.id]);
}

export async function openSession(ctx: AppContext, openingFloat: number): Promise<CashSession> {
  requirePermission(ctx, 'cash.manage');
  const user = requireUser(ctx);
  if (await getOpenSession(ctx)) fail('errors.sessionAlreadyOpen');
  return runTx(ctx, async (tx) => {
    const s = await insertRow<CashSession>(tx, ctx, 'cash_sessions', {
      user_id: user.id, user_name: user.full_name, opened_at: ctx.now().toISOString(), opening_float: Math.max(0, Math.round(openingFloat)),
      closed_at: null, expected_cash: null, counted_cash: null, difference: null, status: 'OPEN', notes: null,
    });
    await audit(tx, ctx, 'cash.opened', 'cash_session', s.id, { float: s.opening_float });
    return s;
  });
}

export interface ZReport {
  session: CashSession;
  sales_count: number; cancelled_count: number; gross: number; discounts: number; net: number;
  by_method: { method: string; total: number; count: number }[];
  credit_given: number; customer_payments_cash: number; expected_cash: number;
}

export async function zReport(ctx: AppContext, sessionId: string): Promise<ZReport> {
  requirePermission(ctx, 'cash.manage');
  const session = await getById<CashSession>(ctx.db, 'cash_sessions', sessionId);
  if (!session) return fail('errors.notFound');
  const end = session.closed_at ?? ctx.now().toISOString();
  const sales = await ctx.db.select<Sale>('SELECT * FROM sales WHERE cash_session_id = ? AND deleted_at IS NULL', [sessionId]);
  const done = sales.filter((s) => s.status === 'COMPLETED');
  const methodMap = new Map<string, { total: number; count: number }>();
  done.forEach((s) => {
    const m = methodMap.get(s.payment_method) ?? { total: 0, count: 0 };
    m.total += s.amount_paid; m.count++; methodMap.set(s.payment_method, m);
  });
  const cashIn = methodMap.get('CASH')?.total ?? 0;
  const custCash = (await ctx.db.selectOne<{ t: number | null }>(
    `SELECT SUM(amount) t FROM customer_payments WHERE method = 'CASH' AND user_id = ? AND paid_at >= ? AND paid_at <= ? AND deleted_at IS NULL`,
    [session.user_id, session.opened_at, end]))?.t ?? 0;
  return {
    session, sales_count: done.length, cancelled_count: sales.length - done.length,
    gross: done.reduce((s, x) => s + x.subtotal, 0), discounts: done.reduce((s, x) => s + x.discount_total, 0), net: done.reduce((s, x) => s + x.total, 0),
    by_method: [...methodMap].map(([method, v]) => ({ method, ...v })),
    credit_given: done.reduce((s, x) => s + (x.total - x.amount_paid), 0), customer_payments_cash: custCash,
    expected_cash: session.opening_float + cashIn + custCash,
  };
}

export async function closeSession(ctx: AppContext, sessionId: string, countedCash: number, notes?: string): Promise<ZReport> {
  requirePermission(ctx, 'cash.manage');
  const report = await zReport(ctx, sessionId);
  if (report.session.status !== 'OPEN') fail('errors.sessionClosed');
  if (!(countedCash >= 0)) fail('errors.invalidAmount');
  await runTx(ctx, async (tx) => {
    await updateRow(tx, ctx, 'cash_sessions', sessionId, {
      status: 'CLOSED', closed_at: ctx.now().toISOString(), expected_cash: report.expected_cash, counted_cash: Math.round(countedCash),
      difference: Math.round(countedCash) - report.expected_cash, notes: notes ?? null,
    });
    await audit(tx, ctx, 'cash.closed', 'cash_session', sessionId, { expected: report.expected_cash, counted: countedCash });
  });
  return zReport(ctx, sessionId);
}

export async function listSessions(ctx: AppContext, limit = 30) {
  requirePermission(ctx, 'cash.manage');
  return ctx.db.select<CashSession>('SELECT * FROM cash_sessions WHERE deleted_at IS NULL ORDER BY opened_at DESC LIMIT ?', [limit]);
}
