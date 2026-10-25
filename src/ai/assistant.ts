import { AppError } from '../lib/errors';
import { formatMoney, formatQty, type Lang } from '../lib/format';
import { uuid } from '../lib/ids';
import { addDays, startOfDay } from '../lib/time';
import { type AppContext, can } from '../services/context';
import { adjustStock } from '../services/inventory';
import { customerHistory, listCustomers, listSuppliers, supplierHistory } from '../services/parties';
import { getProduct, searchProducts, updateProductPrice } from '../services/products';
import { createPurchase } from '../services/purchases';
import { bestSellers, expenseTotal, expiringBatches, inventoryValue, lowStockProducts, rangeLastMonth, rangeLastTwoWeeks, rangeLastWeek, rangeMonth, rangeToday, rangeWeek, salesSummary, type DateRange } from '../services/reports';
import { createSale, listSales } from '../services/sales';
import type { Permission } from '../services/permissions';
import type { Product } from '../services/types';
import type { EntitlementStatus } from '../entitlement/entitlement';
import type { SyncStatus } from '../sync/engine';
import { computeInsights, type Insight } from './insights';
import { insightText, dayName, type Translate } from './insightText';
import { detectLang, parse, type Intent, type Parsed, type Period } from './nlu';

export interface AssistantMessage {
  id: string;
  role: 'assistant' | 'user';
  text: string;
  rows?: { label: string; value: string }[];
  /** Present when a data-changing action is waiting for the user's explicit confirmation. */
  confirm?: { actionId: string };
  options?: string[];
  lang: Lang;
}

export interface AssistantDeps {
  ctx: () => AppContext;
  t: Translate;
  uiLang: () => Lang;
  entitlement: () => EntitlementStatus;
  syncStatus: () => Promise<SyncStatus | null>;
}

type WriteKind = 'SELL' | 'ADD_STOCK' | 'REMOVE_STOCK' | 'SET_PRICE' | 'PURCHASE';
export interface WriteAction {
  id: string; kind: WriteKind; product: Product; quantity?: number; price?: number; cost?: number; summary: string;
}
type Pending =
  | { type: 'slot'; parsed: Parsed; missing: 'product' | 'quantity' | 'cost' }
  | { type: 'choose'; parsed: Parsed; candidates: Product[] }
  | { type: 'confirm'; action: WriteAction };

const WRITE_PERMS: Record<WriteKind, Permission> = {
  SELL: 'sales.create', ADD_STOCK: 'inventory.adjust', REMOVE_STOCK: 'inventory.adjust', SET_PRICE: 'products.update', PURCHASE: 'purchases.create',
};
const READ_PERMS: Partial<Record<Intent, Permission>> = {
  SALES_SUMMARY: 'sales.read', LIST_SALES: 'sales.read', PROFIT: 'reports.read', BEST_SELLERS: 'reports.read', INVENTORY_VALUE: 'reports.read',
  STOCK_OF: 'products.read', PRICE_OF: 'products.read', LOW_STOCK: 'products.read', EXPIRING: 'products.read',
  CUSTOMER_HISTORY: 'customers.read', SUPPLIER_HISTORY: 'suppliers.read',
  INSIGHTS: 'reports.read', INSIGHT_WHY: 'reports.read', INSIGHT_DAY: 'reports.read', INSIGHT_PREPARE: 'reports.read',
};
const WRITE_INTENTS = new Set<Intent>(['SELL', 'ADD_STOCK', 'REMOVE_STOCK', 'SET_PRICE', 'PURCHASE']);

/**
 * The assistant NEVER touches the database directly: every answer comes from a named service
 * function (the "tools"), every write goes through the same services the screens use (so permissions,
 * validation and transactions apply), and every write waits for an explicit confirmation.
 *   understand -> validate -> summarise -> ask confirmation -> execute -> report
 */
export class Assistant {
  private pending: Pending | null = null;
  constructor(private d: AssistantDeps) {}

  reset() { this.pending = null; }
  hasPendingConfirmation() { return this.pending?.type === 'confirm'; }

  async send(text: string): Promise<AssistantMessage[]> {
    const lng = detectLang(text, this.d.uiLang());
    try {
      return await this.handle(text, lng);
    } catch (e) {
      this.pending = null;
      return [this.msg(lng, this.errorText(lng, e))];
    }
  }

  async confirm(): Promise<AssistantMessage[]> { return this.send(this.d.uiLang() === 'fr' ? 'oui' : 'yes'); }
  async cancel(): Promise<AssistantMessage[]> { return this.send(this.d.uiLang() === 'fr' ? 'non' : 'no'); }

  // ------------------------------------------------------------------ internals
  private T(lng: Lang, key: string, p?: Record<string, any>) { return this.d.t(lng, key, p); }
  private msg(lng: Lang, text: string, extra: Partial<AssistantMessage> = {}): AssistantMessage {
    return { id: uuid(), role: 'assistant', text, lang: lng, ...extra };
  }
  private errorText(lng: Lang, e: unknown): string {
    if (e instanceof AppError) {
      const p: Record<string, any> = { ...e.params };
      if (typeof p.amount === 'number') p.amount = formatMoney(p.amount, lng);
      return this.T(lng, e.key, p);
    }
    return this.T(lng, 'errors.unexpected');
  }

  private async handle(text: string, lng: Lang): Promise<AssistantMessage[]> {
    const ctx = this.d.ctx();
    let parsed = parse(text);

    // ---- continue a multi-turn flow
    const pend = this.pending;
    if (pend) {
      if (pend.type === 'confirm') {
        if (parsed.intent === 'CONFIRM') { this.pending = null; return this.execute(pend.action, lng); }
        if (parsed.intent === 'CANCEL') { this.pending = null; return [this.msg(lng, this.T(lng, 'ai.cancelled'))]; }
        this.pending = null; // anything else abandons the pending write: nothing is ever executed implicitly
      } else if (pend.type === 'slot' && (parsed.intent === 'UNKNOWN' || parsed.intent === 'CONFIRM')) {
        this.pending = null;
        return this.fillSlot(pend, text, lng);
      } else if (pend.type === 'choose' && (parsed.intent === 'UNKNOWN' || parsed.intent === 'CONFIRM')) {
        this.pending = null;
        const idx = parseInt(text.trim(), 10);
        const pick = pend.candidates[idx - 1] ?? (await this.pickByName(pend.candidates, text));
        if (!pick) return this.askChoice(pend.parsed, pend.candidates, lng);
        return this.continueWrite({ ...pend.parsed }, pick, lng);
      } else this.pending = null;
    }

    if (parsed.intent === 'CONFIRM' || parsed.intent === 'CANCEL') return [this.msg(lng, this.T(lng, 'ai.nothingPending'))];

    // ---- permission gate (same rules as the screens)
    const needed = WRITE_INTENTS.has(parsed.intent) ? WRITE_PERMS[parsed.intent as WriteKind] : READ_PERMS[parsed.intent];
    if (needed && !can(ctx, needed)) return [this.msg(lng, this.T(lng, 'ai.notAllowed'))];

    if (WRITE_INTENTS.has(parsed.intent)) return this.startWrite(parsed, lng);
    return this.read(parsed, text, lng);
  }

  // ------------------------------------------------------------------ products
  private async resolve(phrase: string): Promise<{ found?: Product; candidates: Product[] }> {
    const res = await searchProducts(this.d.ctx(), phrase, 5);
    if (!res.length) return { candidates: [] };
    const [a, b] = res;
    if (a.score >= 0.95 || (!b && a.score >= 0.6)) return { found: a, candidates: [a] };
    if (b && b.score >= 0.6 && a.score - b.score < 0.08) return { candidates: res.filter((r) => r.score >= 0.6 && a.score - r.score < 0.15).slice(0, 4) };
    return a.score >= 0.6 ? { found: a, candidates: [a] } : { candidates: [] };
  }
  private async pickByName(cands: Product[], text: string) {
    const r = await this.resolve(text);
    return r.found && cands.some((c) => c.id === r.found!.id) ? r.found : undefined;
  }
  private askChoice(parsed: Parsed, candidates: Product[], lng: Lang): AssistantMessage[] {
    this.pending = { type: 'choose', parsed, candidates };
    return [this.msg(lng, this.T(lng, 'ai.whichProduct'), { options: candidates.map((c) => c.name) })];
  }

  // ------------------------------------------------------------------ writes
  private async startWrite(parsed: Parsed, lng: Lang): Promise<AssistantMessage[]> {
    if (!parsed.product) { this.pending = { type: 'slot', parsed, missing: 'product' }; return [this.msg(lng, this.T(lng, 'ai.askProduct'))]; }
    const r = await this.resolve(parsed.product);
    if (!r.found) {
      if (r.candidates.length) return this.askChoice(parsed, r.candidates, lng);
      return [this.msg(lng, this.T(lng, 'ai.productNotFound', { name: parsed.product }))];
    }
    return this.continueWrite(parsed, r.found, lng);
  }

  private async fillSlot(p: Extract<Pending, { type: 'slot' }>, text: string, lng: Lang): Promise<AssistantMessage[]> {
    if (p.missing === 'product') return this.startWrite({ ...p.parsed, product: text.trim() }, lng);
    const n = parseFloat((text.match(/\d+(?:[.,]\d+)?/)?.[0] ?? '').replace(',', '.'));
    if (!(n > 0)) { this.pending = p; return [this.msg(lng, this.T(lng, p.missing === 'quantity' ? 'ai.askQuantity' : 'ai.askCost'))]; }
    const product = (await this.resolve(p.parsed.product!)).found;
    if (!product) return [this.msg(lng, this.T(lng, 'ai.productNotFound', { name: p.parsed.product }))];
    return this.continueWrite(p.missing === 'quantity' ? { ...p.parsed, quantity: n } : { ...p.parsed, price: n }, product, lng);
  }

  /** Product is known: collect remaining slots, validate, summarise, ask for confirmation. */
  private async continueWrite(parsed: Parsed, product: Product, lng: Lang): Promise<AssistantMessage[]> {
    const ctx = this.d.ctx();
    const kind = parsed.intent as WriteKind;
    const money = (n: number) => formatMoney(n, lng);
    const q = parsed.quantity;
    const keep = { ...parsed, product: product.name };

    if (kind !== 'SET_PRICE' && !(q && q > 0)) { this.pending = { type: 'slot', parsed: keep, missing: 'quantity' }; return [this.msg(lng, this.T(lng, 'ai.askQuantity'))]; }
    if (kind === 'SET_PRICE' && !(parsed.price !== undefined && parsed.price >= 0)) { this.pending = { type: 'slot', parsed: keep, missing: 'cost' }; return [this.msg(lng, this.T(lng, 'ai.askPrice'))]; }
    if (kind === 'PURCHASE' && !(parsed.price && parsed.price > 0)) {
      this.pending = { type: 'slot', parsed: keep, missing: 'cost' };
      return [this.msg(lng, this.T(lng, 'ai.askCost', { name: product.name, cost: money(product.cost_price) }))];
    }

    const unit = product.unit;
    let summary: string; const action: WriteAction = { id: uuid(), kind, product, quantity: q, price: parsed.price, summary: '' };
    switch (kind) {
      case 'SELL': {
        const price = parsed.price ?? product.selling_price;
        if (price !== product.selling_price && !can(ctx, 'sales.discount')) return [this.msg(lng, this.T(lng, 'ai.notAllowed'))];
        if (q! > product.quantity) return [this.msg(lng, this.T(lng, 'ai.notEnoughStock', { name: product.name, stock: formatQty(product.quantity, lng), unit }))];
        action.price = price;
        summary = this.T(lng, 'ai.confirmSell', { qty: formatQty(q!, lng), name: product.name, price: money(price), total: money(Math.round(q! * price)), left: formatQty(product.quantity - q!, lng), unit });
        break;
      }
      case 'ADD_STOCK':
        summary = this.T(lng, 'ai.confirmAdd', { qty: formatQty(q!, lng), unit, name: product.name, from: formatQty(product.quantity, lng), to: formatQty(product.quantity + q!, lng) });
        break;
      case 'REMOVE_STOCK':
        if (q! > product.quantity) return [this.msg(lng, this.T(lng, 'ai.notEnoughStock', { name: product.name, stock: formatQty(product.quantity, lng), unit }))];
        summary = this.T(lng, 'ai.confirmRemove', { qty: formatQty(q!, lng), unit, name: product.name, from: formatQty(product.quantity, lng), to: formatQty(product.quantity - q!, lng) });
        break;
      case 'SET_PRICE':
        summary = this.T(lng, 'ai.confirmPrice', { name: product.name, from: money(product.selling_price), to: money(parsed.price!) });
        break;
      case 'PURCHASE':
        action.cost = parsed.price;
        summary = this.T(lng, 'ai.confirmPurchase', { qty: formatQty(q!, lng), unit, name: product.name, cost: money(parsed.price!), total: money(Math.round(q! * parsed.price!)), to: formatQty(product.quantity + q!, lng) });
        break;
    }
    action.summary = summary;
    this.pending = { type: 'confirm', action };
    return [this.msg(lng, summary, { confirm: { actionId: action.id } })];
  }

  private async execute(a: WriteAction, lng: Lang): Promise<AssistantMessage[]> {
    const ctx = this.d.ctx();
    const money = (n: number) => formatMoney(n, lng);
    switch (a.kind) {
      case 'SELL': {
        const r = await createSale(ctx, { lines: [{ product_id: a.product.id, quantity: a.quantity!, unit_price: a.price }], payment_method: 'CASH', notes: 'AI assistant' });
        const left = (await getProduct(ctx, a.product.id))!.quantity;
        return [this.msg(lng, this.T(lng, 'ai.doneSell', { receipt: r.sale.receipt_no, total: money(r.sale.total), left: formatQty(left, lng), unit: a.product.unit }))];
      }
      case 'ADD_STOCK': case 'REMOVE_STOCK': {
        const r = await adjustStock(ctx, { product_id: a.product.id, kind: a.kind === 'ADD_STOCK' ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT', quantity: a.quantity!, reason: 'AI assistant' });
        return [this.msg(lng, this.T(lng, 'ai.doneStock', { name: a.product.name, qty: formatQty(r.product.quantity, lng), unit: a.product.unit }))];
      }
      case 'SET_PRICE': {
        const p = await updateProductPrice(ctx, a.product.id, a.price!);
        return [this.msg(lng, this.T(lng, 'ai.donePrice', { name: p.name, price: money(p.selling_price) }))];
      }
      case 'PURCHASE': {
        const r = await createPurchase(ctx, { lines: [{ product_id: a.product.id, quantity: a.quantity!, cost_price: a.cost! }], notes: 'AI assistant' });
        const left = (await getProduct(ctx, a.product.id))!.quantity;
        return [this.msg(lng, this.T(lng, 'ai.donePurchase', { ref: r.purchase.reference, total: money(r.purchase.total), qty: formatQty(left, lng), unit: a.product.unit }))];
      }
    }
  }

  // ------------------------------------------------------------------ reads
  private range(p: Period, now: Date): DateRange {
    if (p === 'yesterday') { const t = startOfDay(now); return { from: addDays(t, -1), to: t }; }
    if (p === 'last_week') return rangeLastWeek(now);
    if (p === 'last_two_weeks') return rangeLastTwoWeeks(now);
    if (p === 'last_month') return rangeLastMonth(now);
    return p === 'week' ? rangeWeek(now) : p === 'month' ? rangeMonth(now) : rangeToday(now);
  }

  private queryRange(parsed: Parsed, now: Date): DateRange {
    if (!parsed.fromDate || !parsed.toDate) return this.range(parsed.period ?? 'today', now);
    const from = new Date(`${parsed.fromDate}T00:00:00`);
    const to = new Date(`${parsed.toDate}T00:00:00`);
    return { from, to: addDays(to, 1) };
  }

  private queryPeriod(parsed: Parsed, lng: Lang): string {
    if (!parsed.fromDate || !parsed.toDate) return this.T(lng, `ai.period.${parsed.period ?? 'today'}`);
    const date = (value: string) => new Intl.DateTimeFormat(lng === 'fr' ? 'fr-FR' : 'en-GB').format(new Date(`${value}T00:00:00`));
    return this.T(lng, 'ai.period.range', { from: date(parsed.fromDate), to: date(parsed.toDate) });
  }

  private async read(parsed: Parsed, text: string, lng: Lang): Promise<AssistantMessage[]> {
    const ctx = this.d.ctx();
    const now = ctx.now();
    const money = (n: number) => formatMoney(n, lng);
    const period = (p: Period) => this.T(lng, `ai.period.${p}`);
    const M = (t: string, extra: Partial<AssistantMessage> = {}) => [this.msg(lng, t, extra)];

    switch (parsed.intent) {
      case 'SALES_SUMMARY': {
        const s = await salesSummary(ctx, this.queryRange(parsed, now));
        return M(this.T(lng, s.count ? 'ai.sales' : 'ai.salesNone', { period: this.queryPeriod(parsed, lng), total: money(s.revenue), count: s.count }));
      }
      case 'PROFIT': {
        const r = this.queryRange(parsed, now);
        const [s, expenses] = await Promise.all([salesSummary(ctx, r), expenseTotal(ctx, r)]);
        return M(this.T(lng, 'ai.profit', { period: this.queryPeriod(parsed, lng), profit: money(s.profit), expenses: money(expenses), net: money(s.profit - expenses), margin: Math.round(s.margin), total: money(s.revenue) }));
      }
      case 'LIST_SALES': {
        const p = parsed.period ?? 'today';
        const r = this.queryRange(parsed, now);
        const sales = await listSales(ctx, { from: r.from.toISOString(), to: r.to.toISOString(), status: 'COMPLETED', limit: 8 });
        if (!sales.length) return M(this.T(lng, 'ai.salesNone', { period: this.queryPeriod(parsed, lng) }));
        return M(this.T(lng, 'ai.salesList', { period: period(p), count: sales.length }), { rows: sales.map((s) => ({ label: `${s.receipt_no} · ${new Date(s.sold_at).toLocaleTimeString(lng === 'fr' ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit' })}`, value: money(s.total) })) });
      }
      case 'STOCK_OF': case 'PRICE_OF': {
        if (!parsed.product) return M(this.T(lng, 'ai.askProduct'));
        const r = await this.resolve(parsed.product);
        if (!r.found) return r.candidates.length ? this.askForRead(parsed, r.candidates, lng) : M(this.T(lng, 'ai.productNotFound', { name: parsed.product }));
        return M(this.readProduct(parsed.intent, r.found, lng));
      }
      case 'LOW_STOCK': {
        const low = await lowStockProducts(ctx, 10);
        if (!low.length) return M(this.T(lng, 'ai.lowNone'));
        return M(this.T(lng, 'ai.lowList', { count: low.length }), { rows: low.map((p) => ({ label: p.name, value: `${formatQty(p.quantity, lng)} / ${formatQty(p.minimum_stock, lng)} ${p.unit}` })) });
      }
      case 'EXPIRING': {
        const days = parsed.days ?? 30;
        const e = await expiringBatches(ctx);
        const soon = e.soon.filter((b) => b.days <= days);
        if (!soon.length && !e.expired.length) return M(this.T(lng, 'ai.expiringNone', { days }));
        const rows = [...e.expired.map((b) => ({ label: `${b.product_name} (${this.T(lng, 'ai.expired')})`, value: `${formatQty(b.quantity_remaining, lng)} ${b.unit}` })),
          ...soon.map((b) => ({ label: `${b.product_name} · ${b.expiry_date}`, value: `${formatQty(b.quantity_remaining, lng)} ${b.unit}` }))].slice(0, 10);
        return M(this.T(lng, 'ai.expiringList', { days, soon: soon.length, expired: e.expired.length }), { rows });
      }
      case 'BEST_SELLERS': {
        const p = parsed.period ?? 'month';
        const list = await bestSellers(ctx, this.range(p, now), 5);
        if (!list.length) return M(this.T(lng, 'ai.salesNone', { period: period(p) }));
        return M(this.T(lng, 'ai.best', { period: period(p) }), { rows: list.map((b) => ({ label: b.name, value: `${formatQty(b.quantity, lng)} ${b.unit}` })) });
      }
      case 'INVENTORY_VALUE': {
        const v = await inventoryValue(ctx);
        return M(this.T(lng, 'ai.inventoryValue', { cost: money(v.value_cost), retail: money(v.value_retail), count: v.products }));
      }
      case 'SYNC_STATUS': {
        const st = await this.d.syncStatus();
        if (!st || st.state === 'DISABLED') return M(this.T(lng, 'ai.syncDisabled'));
        return M(this.T(lng, `ai.sync.${st.state}`, { pending: st.pending }));
      }
      case 'SUBSCRIPTION': {
        const e = this.d.entitlement();
        return M(e.state === 'ACTIVE' ? this.T(lng, 'ai.premiumActive', { days: e.daysLeft ?? 0, date: e.expiresAt?.slice(0, 10) ?? '' }) : this.T(lng, e.state === 'EXPIRED' ? 'ai.premiumExpired' : 'ai.premiumFree'));
      }
      case 'INSIGHTS': case 'INSIGHT_WHY': case 'INSIGHT_DAY': case 'INSIGHT_PREPARE':
        return this.insights(parsed, text, lng);
      case 'CUSTOMER_HISTORY': {
        const q = (parsed.name ?? '').toLowerCase();
        const c = (await listCustomers(ctx)).find((x) => x.name.toLowerCase().includes(q));
        if (!c) return M(this.T(lng, 'ai.partyNotFound', { name: parsed.name ?? '' }));
        const h = await customerHistory(ctx, c.id);
        return M(this.T(lng, 'ai.customer', { name: c.name, total: money(c.total_spent), count: c.purchase_count, due: money(c.balance_due) }), { rows: h.sales.slice(0, 5).map((s) => ({ label: s.receipt_no, value: money(s.total) })) });
      }
      case 'SUPPLIER_HISTORY': {
        const q = (parsed.name ?? '').toLowerCase();
        const s = (await listSuppliers(ctx)).find((x) => x.name.toLowerCase().includes(q));
        if (!s) return M(this.T(lng, 'ai.partyNotFound', { name: parsed.name ?? '' }));
        const h = await supplierHistory(ctx, s.id);
        return M(this.T(lng, 'ai.supplier', { name: s.name, total: money(s.total_purchased), count: s.purchase_count, due: money(s.balance_due) }), { rows: h.purchases.slice(0, 5).map((p) => ({ label: p.reference, value: money(p.total) })) });
      }
      case 'HELP': return M(this.T(lng, 'ai.help'));
      default: return M(this.T(lng, 'ai.unknown'));
    }
  }

  private askForRead(parsed: Parsed, candidates: Product[], lng: Lang): AssistantMessage[] {
    void parsed;
    return [this.msg(lng, this.T(lng, 'ai.whichProduct'), { options: candidates.map((c) => c.name) })];
  }

  private readProduct(intent: Intent, p: Product, lng: Lang): string {
    if (intent === 'PRICE_OF') return this.T(lng, 'ai.price', { name: p.name, price: formatMoney(p.selling_price, lng), unit: p.unit });
    return this.T(lng, p.quantity <= 0 ? 'ai.stockOut' : 'ai.stock', { name: p.name, qty: formatQty(p.quantity, lng), unit: p.unit, min: formatQty(p.minimum_stock, lng) });
  }

  // ------------------------------------------------------------------ insights Q&A (section 51.4)
  private async insights(parsed: Parsed, text: string, lng: Lang): Promise<AssistantMessage[]> {
    const ctx = this.d.ctx();
    const M = (t: string, extra: Partial<AssistantMessage> = {}) => [this.msg(lng, t, extra)];
    const res = await computeInsights(ctx);
    if (!res.enoughData) return M(this.T(lng, 'insight.notEnough'));
    const line = (i: Insight) => insightText(this.d.t, lng, i);

    if (parsed.intent === 'INSIGHTS') {
      if (!res.insights.length) return M(this.T(lng, 'insight.nothing'));
      return M(this.T(lng, 'ai.insightsIntro'), { rows: res.insights.slice(0, 5).map((i) => ({ label: line(i).title, value: '' })) });
    }
    if (parsed.intent === 'INSIGHT_WHY') {
      let product = parsed.product ? (await this.resolve(parsed.product)).found : undefined;
      if (!product) product = (await this.resolve(text)).found;
      if (!product) return M(this.T(lng, 'ai.askProduct'));
      const mine = res.insights.filter((i) => i.productId === product!.id);
      if (!mine.length) return M(this.T(lng, 'ai.whyNone', { name: product.name }));
      const peak = mine.find((i) => i.type === 'WEEKDAY_PEAK');
      const risk = mine.find((i) => i.type === 'STOCK_RISK');
      const parts = [peak && this.T(lng, 'ai.whyPeak', { name: product.name, day: dayName(Number(peak.params.dow), lng), avgPeak: peak.params.avgPeak, avgOther: peak.params.avgOther }),
        risk ? this.T(lng, 'ai.whyRisk', { stock: formatQty(product.quantity, lng), unit: product.unit })
             : mine.filter((i) => i !== peak).slice(0, 2).map((i) => line(i).title).join(' ')].filter(Boolean);
      return M(parts.join(' '));
    }
    if (parsed.intent === 'INSIGHT_DAY') {
      const dow = parsed.dow!;
      const list = res.insights.filter((i) => i.type === 'WEEKDAY_PEAK' && Number(i.params.dow) === dow);
      if (!list.length) return M(this.T(lng, 'ai.dayNone', { day: dayName(dow, lng) }));
      return M(this.T(lng, 'ai.dayList', { day: dayName(dow, lng) }), { rows: list.map((i) => ({ label: String(i.params.product), value: `${i.params.avgPeak} vs ${i.params.avgOther}` })) });
    }
    // INSIGHT_PREPARE
    const dow = parsed.dow ?? addDays(ctx.now(), 1).getDay();
    const list = res.insights.filter((i) => (i.type === 'WEEKDAY_PEAK' && Number(i.params.dow) === dow) || (i.type === 'STOCK_RISK' && Number(i.params.dow) === dow));
    if (!list.length) return M(this.T(lng, 'ai.prepareNone', { day: dayName(dow, lng) }));
    const risks = list.filter((i) => i.type === 'STOCK_RISK');
    const peaks = list.filter((i) => i.type === 'WEEKDAY_PEAK' && !risks.some((r) => r.productId === i.productId));
    const names = [...new Set(list.map((i) => String(i.params.product)))].join(', ');
    const txt = this.T(lng, 'ai.prepare', { day: dayName(dow, lng), names }) + (risks.length ? ' ' + this.T(lng, 'ai.prepareRisk', { names: risks.map((r) => String(r.params.product)).join(', ') }) : '');
    void peaks;
    return M(txt, { rows: risks.map((r) => ({ label: String(r.params.product), value: `+${r.params.addMin}–${r.params.addMax} ${r.params.unit}` })) });
  }
}
