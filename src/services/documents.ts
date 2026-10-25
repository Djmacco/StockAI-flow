import type { Db } from '../database/db';
import { fail } from '../lib/errors';
import { audit } from './audit';
import { type AppContext, requirePermission, runTx } from './context';
import { nextNumber } from './numbering';
import { normalizeTier, tierOfCustomer } from './pricing';
import { getById, insertRow, updateRow } from './repo';
import { type CartLine, cancelSale, createSale, priceCart } from './sales';
import { getSetting } from './settings';
import type { Customer, Document, DocumentItem, DocType, Sale, SaleItem } from './types';

/**
 * Invoices and proformas (quotes).
 *
 *  - Invoice  = the A4 document of a SALE. It is built from the sale (same lines, same prices, same total), so the invoice and the
 *               stock / cash figures can never disagree. One active invoice per sale. Cancelling the sale cancels the invoice and
 *               the number is kept (numbers are never reused).
 *  - Proforma = a quote built from a cart BEFORE selling. It moves no stock and records no money. When the customer accepts it,
 *               `convertProforma` makes the real sale at the quoted prices and the invoice, in one transaction.
 *
 * Prices in the app are what the customer pays. When a VAT rate is set in Settings, documents show the tax contained in the
 * total (HT / TVA / TTC); nothing is added on top.
 */

export interface DocumentParty { name?: string | null; phone?: string | null; address?: string | null; tax_id?: string | null }
export interface DocumentListRow extends Document { balance_due: number; item_count: number }
export interface DocumentDetail {
  doc: Document; items: DocumentItem[]; customer?: Customer;
  sale?: Pick<Sale, 'id' | 'receipt_no' | 'status' | 'amount_paid' | 'total' | 'payment_method'>;
  source_number: string | null; converted_number: string | null;
}

/** "2026-11-15" -> an ISO instant at local noon (keeps the same calendar day in every timezone). */
export function dayToIso(day: string | null | undefined): string | null {
  if (!day) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0).toISOString();
}
const toDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export const addDaysTo = (d: Date, n: number) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
export const isoToDay = (iso: string | null | undefined) => (iso ? toDay(new Date(iso)) : '');

/** Tax contained in a tax-inclusive total (integer FCFA). */
export const taxIncluded = (total: number, ratePct: number) => (ratePct > 0 ? Math.round(total - total / (1 + ratePct / 100)) : 0);

const taxRate = async (db: Db) => { const r = parseFloat(await getSetting(db, 'tax_rate')); return r > 0 && r < 100 ? r : 0; };

async function resolveParty(tx: Db, customerId: string | null | undefined, party: DocumentParty | undefined, fallbackName?: string | null) {
  const c = customerId ? await getById<Customer>(tx, 'customers', customerId) : undefined;
  if (customerId && !c) return fail('errors.notFound');
  const pick = (v: string | null | undefined, d: string | null | undefined) => (v?.trim() ? v.trim() : d?.trim() || null);
  return {
    customer: c,
    customer_name: pick(party?.name, c?.name ?? fallbackName),
    customer_phone: pick(party?.phone, c?.phone),
    customer_address: pick(party?.address, c?.address),
    customer_tax_id: pick(party?.tax_id, c?.tax_id),
  };
}

interface NewDoc {
  doc_type: DocType; status: Document['status']; customer_id: string | null; party: Awaited<ReturnType<typeof resolveParty>>;
  sale_id: string | null; source_document_id: string | null; due_date: string | null;
  subtotal: number; discount_total: number; total: number; amount_paid: number; price_tier: string; notes: string | null;
  items: { product_id: string; description: string; unit: string | null; quantity: number; unit_price: number; discount: number; line_total: number }[];
}

async function insertDocument(tx: Db, ctx: AppContext, d: NewDoc): Promise<{ doc: Document; items: DocumentItem[] }> {
  const prefix = await getSetting(tx, d.doc_type === 'INVOICE' ? 'invoice_prefix' : 'proforma_prefix');
  const number = await nextNumber(tx, ctx, prefix);
  const rate = await taxRate(tx);
  const doc = await insertRow<Document>(tx, ctx, 'documents', {
    doc_type: d.doc_type, number, status: d.status, customer_id: d.customer_id, customer_name: d.party.customer_name, customer_phone: d.party.customer_phone,
    customer_address: d.party.customer_address, customer_tax_id: d.party.customer_tax_id, sale_id: d.sale_id, source_document_id: d.source_document_id, converted_to: null,
    issue_date: ctx.now().toISOString(), due_date: d.due_date, subtotal: d.subtotal, discount_total: d.discount_total, total: d.total,
    tax_rate: rate, tax_total: taxIncluded(d.total, rate), amount_paid: d.amount_paid, price_tier: normalizeTier(d.price_tier), notes: d.notes,
    user_id: ctx.user?.id ?? null, user_name: ctx.user?.full_name ?? null, cancelled_at: null, cancel_reason: null,
  });
  const items: DocumentItem[] = [];
  for (const i of d.items) items.push(await insertRow<DocumentItem>(tx, ctx, 'document_items', { document_id: doc.id, ...i }));
  return { doc, items };
}

// ------------------------------------------------------------------ invoice from a sale
export interface InvoiceOptions { party?: DocumentParty; due_date?: string | null; notes?: string | null }

async function invoiceFor(tx: Db, ctx: AppContext, sale: Sale, opts: InvoiceOptions & { source_document_id?: string | null } = {}): Promise<{ doc: Document; items: DocumentItem[] }> {
  const rows = await tx.select<SaleItem & { unit: string | null }>(
    `SELECT si.*, p.unit AS unit FROM sale_items si LEFT JOIN products p ON p.id = si.product_id WHERE si.sale_id = ? AND si.deleted_at IS NULL ORDER BY si.rowid`, [sale.id]);
  const party = await resolveParty(tx, sale.customer_id, opts.party, sale.customer_name);
  const out = await insertDocument(tx, ctx, {
    doc_type: 'INVOICE', status: 'ISSUED', customer_id: sale.customer_id, party, sale_id: sale.id, source_document_id: opts.source_document_id ?? null,
    due_date: dayToIso(opts.due_date), subtotal: sale.subtotal, discount_total: sale.discount_total, total: sale.total, amount_paid: sale.amount_paid,
    price_tier: sale.price_tier, notes: opts.notes?.trim() || null,
    items: rows.map((r) => ({ product_id: r.product_id, description: r.product_name, unit: r.unit, quantity: r.quantity, unit_price: r.unit_price, discount: r.discount, line_total: r.line_total })),
  });
  await audit(tx, ctx, 'invoice.issued', 'document', out.doc.id, { number: out.doc.number, sale: sale.receipt_no, total: sale.total });
  return out;
}

/** The invoice of a sale. Asking twice returns the same invoice: one sale, one invoice number. */
export async function createInvoiceFromSale(ctx: AppContext, saleId: string, opts: InvoiceOptions = {}): Promise<Document> {
  requirePermission(ctx, 'sales.create');
  return runTx(ctx, async (tx) => {
    const sale = await getById<Sale>(tx, 'sales', saleId);
    if (!sale) return fail('errors.notFound');
    const existing = await tx.selectOne<Document>("SELECT * FROM documents WHERE sale_id = ? AND doc_type = 'INVOICE' AND status = 'ISSUED' AND deleted_at IS NULL ORDER BY created_at LIMIT 1", [saleId]);
    if (existing) return existing;
    if (sale.status === 'CANCELLED') return fail('errors.invoiceSaleCancelled');
    return (await invoiceFor(tx, ctx, sale, opts)).doc;
  });
}

export async function documentForSale(ctx: AppContext, saleId: string): Promise<Document | undefined> {
  requirePermission(ctx, 'sales.read');
  return ctx.db.selectOne<Document>("SELECT * FROM documents WHERE sale_id = ? AND doc_type = 'INVOICE' AND status = 'ISSUED' AND deleted_at IS NULL ORDER BY created_at LIMIT 1", [saleId]);
}

// ------------------------------------------------------------------ proforma
export interface ProformaInput {
  lines: CartLine[];
  customer_id?: string | null;
  party?: DocumentParty;
  /** Last day the quote is valid ("YYYY-MM-DD"). Default: today + the validity set in Settings. */
  valid_until?: string | null;
  notes?: string | null;
  cart_discount?: number;
}

/** A quote from a cart. No stock is checked or reserved, no money is recorded. */
export async function createProforma(ctx: AppContext, input: ProformaInput): Promise<Document> {
  requirePermission(ctx, 'sales.create');
  if (!input.lines.length) fail('errors.emptyCart');
  return runTx(ctx, async (tx) => {
    const tier = await tierOfCustomer(tx, input.customer_id);
    const cart = await priceCart(tx, ctx, { lines: input.lines, cart_discount: input.cart_discount }, tier);
    const party = await resolveParty(tx, input.customer_id, input.party);
    const days = Math.max(1, Math.round(parseFloat(await getSetting(tx, 'proforma_valid_days')) || 30));
    const due = input.valid_until === undefined ? toDay(addDaysTo(ctx.now(), days)) : input.valid_until;
    const { doc } = await insertDocument(tx, ctx, {
      doc_type: 'PROFORMA', status: 'OPEN', customer_id: input.customer_id || null, party, sale_id: null, source_document_id: null,
      due_date: dayToIso(due), subtotal: cart.subtotal, discount_total: cart.discountTotal, total: cart.total, amount_paid: 0, price_tier: tier, notes: input.notes?.trim() || null,
      items: cart.prepared.map((l) => ({ product_id: l.product.id, description: l.product.name, unit: l.product.unit, quantity: l.qty, unit_price: l.price, discount: l.discount, line_total: l.gross - l.discount })),
    });
    await audit(tx, ctx, 'proforma.created', 'document', doc.id, { number: doc.number, total: doc.total, items: input.lines.length });
    return doc;
  });
}

/**
 * The customer accepted the quote: make the REAL sale at the quoted prices (stock is checked and removed now) and its invoice.
 * One transaction: either the sale, the invoice and the "converted" mark all exist, or none do.
 */
export async function convertProforma(ctx: AppContext, id: string, pay: { payment_method: string; amount_tendered?: number }): Promise<{ sale: Sale; invoice: Document }> {
  requirePermission(ctx, 'sales.create');
  return runTx(ctx, async (tx) => {
    const doc = await getById<Document>(tx, 'documents', id);
    if (!doc || doc.doc_type !== 'PROFORMA') return fail('errors.notFound');
    if (doc.status !== 'OPEN') return fail('errors.proformaNotOpen');
    const items = await tx.select<DocumentItem>('SELECT * FROM document_items WHERE document_id = ? AND deleted_at IS NULL ORDER BY rowid', [id]);
    const lineDiscounts = items.reduce((s, i) => s + i.discount, 0);
    // createSale opens its own transaction on ctx.db: hand it THIS transaction (it becomes a savepoint) instead of queueing behind it.
    const inner: AppContext = { ...ctx, db: tx };
    const { sale } = await createSale(inner, {
      lines: items.map((i) => ({ product_id: i.product_id, quantity: i.quantity, unit_price: i.unit_price, discount: i.discount })),
      customer_id: doc.customer_id, customer_name: doc.customer_id ? null : doc.customer_name, payment_method: pay.payment_method,
      amount_tendered: pay.amount_tendered, cart_discount: Math.max(0, doc.discount_total - lineDiscounts), honor_quoted_prices: true,
      notes: `${doc.number}`,
    });
    const { doc: invoice } = await invoiceFor(tx, ctx, sale, {
      party: { name: doc.customer_name, phone: doc.customer_phone, address: doc.customer_address, tax_id: doc.customer_tax_id }, notes: doc.notes, source_document_id: doc.id,
    });
    await updateRow(tx, ctx, 'documents', doc.id, { status: 'CONVERTED', converted_to: invoice.id });
    await audit(tx, ctx, 'proforma.converted', 'document', doc.id, { number: doc.number, invoice: invoice.number, receipt: sale.receipt_no });
    return { sale, invoice };
  });
}

// ------------------------------------------------------------------ cancel
/**
 * A proforma is simply cancelled. An invoice is the face of its sale, so cancelling it cancels the sale (stock goes back,
 * the invoice number stays on file as CANCELLED). That needs the same permission and a reason, like any sale cancellation.
 */
export async function cancelDocument(ctx: AppContext, id: string, reason: string): Promise<void> {
  if (!reason.trim()) fail('errors.reasonRequired');
  await runTx(ctx, async (tx) => {
    const doc = await getById<Document>(tx, 'documents', id);
    if (!doc) return fail('errors.notFound');
    if (doc.doc_type === 'INVOICE') {
      requirePermission(ctx, 'sales.cancel');
      if (doc.status !== 'ISSUED' || !doc.sale_id) return fail('errors.alreadyCancelled');
      await cancelSale({ ...ctx, db: tx }, doc.sale_id, reason);   // also marks this invoice CANCELLED
      return;
    }
    requirePermission(ctx, 'sales.create');
    if (doc.status !== 'OPEN') return fail('errors.proformaNotOpen');
    await updateRow(tx, ctx, 'documents', id, { status: 'CANCELLED', cancelled_at: ctx.now().toISOString(), cancel_reason: reason.trim() });
    await audit(tx, ctx, 'proforma.cancelled', 'document', id, { number: doc.number, reason: reason.trim() });
  });
}

// ------------------------------------------------------------------ read
export interface DocumentQuery { type?: DocType; status?: string; search?: string; from?: string; to?: string; limit?: number; offset?: number }

export async function listDocuments(ctx: AppContext, q: DocumentQuery = {}): Promise<DocumentListRow[]> {
  requirePermission(ctx, 'sales.read');
  const where = ['d.deleted_at IS NULL']; const params: any[] = [];
  if (q.type) { where.push('d.doc_type = ?'); params.push(q.type); }
  if (q.status) { where.push('d.status = ?'); params.push(q.status); }
  if (q.from) { where.push('d.issue_date >= ?'); params.push(q.from); }
  if (q.to) { where.push('d.issue_date < ?'); params.push(q.to); }
  if (q.search?.trim()) { where.push('(d.number LIKE ? OR d.customer_name LIKE ?)'); params.push(`%${q.search.trim()}%`, `%${q.search.trim()}%`); }
  return ctx.db.select<DocumentListRow>(
    `SELECT d.*, CASE WHEN d.doc_type = 'INVOICE' AND d.status = 'ISSUED' THEN d.total - d.amount_paid ELSE 0 END AS balance_due,
            (SELECT COUNT(*) FROM document_items i WHERE i.document_id = d.id AND i.deleted_at IS NULL) AS item_count
     FROM documents d WHERE ${where.join(' AND ')} ORDER BY d.issue_date DESC, d.rowid DESC LIMIT ? OFFSET ?`, [...params, q.limit ?? 100, q.offset ?? 0]);
}

export async function getDocument(ctx: AppContext, id: string): Promise<DocumentDetail | undefined> {
  requirePermission(ctx, 'sales.read');
  const doc = await getById<Document>(ctx.db, 'documents', id);
  if (!doc) return undefined;
  const items = await ctx.db.select<DocumentItem>('SELECT * FROM document_items WHERE document_id = ? AND deleted_at IS NULL ORDER BY rowid', [id]);
  const customer = doc.customer_id ? await getById<Customer>(ctx.db, 'customers', doc.customer_id) : undefined;
  const sale = doc.sale_id ? await ctx.db.selectOne<DocumentDetail['sale']>('SELECT id, receipt_no, status, amount_paid, total, payment_method FROM sales WHERE id = ?', [doc.sale_id]) : undefined;
  const num = async (docId: string | null) => (docId ? (await ctx.db.selectOne<{ number: string }>('SELECT number FROM documents WHERE id = ?', [docId]))?.number ?? null : null);
  return { doc, items, customer, sale, source_number: await num(doc.source_document_id), converted_number: await num(doc.converted_to) };
}
