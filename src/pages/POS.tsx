import { Banknote, CheckCircle2, CreditCard, FilePlus2, FileText, Lock, Minus, Percent, Plus, Printer, Smartphone, Trash2, Unlock, Wallet } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { DocumentView } from '../components/DocumentView';
import { InvoiceDetailsModal } from '../components/InvoiceDetailsModal';
import { PrintPortal } from '../components/PrintPortal';
import { Receipt } from '../components/Receipt';
import { Badge, Button, Empty, Field, Input, Modal, SearchInput, Segmented, Select, cn, useAction } from '../components/ui';
import { formatDate, formatMoney, formatQty } from '../lib/format';
import { listCategories } from '../services/categories';
import { addDaysTo, createProforma, isoToDay } from '../services/documents';
import { listCustomers } from '../services/parties';
import { normalizeTier, unitPriceFor } from '../services/pricing';
import { findByBarcodeOrSku, listProducts, type ProductListItem } from '../services/products';
import { closeSession, createSale, getOpenSession, getSale, openSession, zReport, type ZReport } from '../services/sales';
import { getPaymentMethods } from '../services/settings';
import { useApp, useCan, useCtx } from '../state/app';
import { useDebounced, useLive } from '../state/hooks';

interface CartItem { p: ProductListItem; qty: number; discount: number }
const METHOD_ICON: Record<string, React.ReactNode> = { CASH: <Banknote className="h-4 w-4" />, MOBILE_MONEY: <Smartphone className="h-4 w-4" />, CARD: <CreditCard className="h-4 w-4" />, OTHER: <Wallet className="h-4 w-4" /> };

export function POS() {
  const { t } = useTranslation();
  const ctx = useCtx();
  const can = useCan();
  const { lang, toast, settings } = useApp();
  const m = (n: number) => formatMoney(n, lang);
  const searchRef = useRef<HTMLInputElement>(null);

  const [search, setSearch] = useState(''); const dq = useDebounced(search, 120);
  const [cat, setCat] = useState<string | null>(null);
  const [cart, setCart] = useState<CartItem[]>([]);
  const [customerId, setCustomerId] = useState('');
  const [customerName, setCustomerName] = useState('');
  const [method, setMethod] = useState('CASH');
  const [cartDiscount, setCartDiscount] = useState(0);
  const [tendered, setTendered] = useState('');
  const [done, setDone] = useState<string | null>(null);
  const [sessionModal, setSessionModal] = useState<'open' | 'close' | null>(null);
  // Proforma (quote) mode: same cart, same price lists, but nothing is sold, no stock is needed and no money is taken.
  const [params, setParams] = useSearchParams();
  const quote = params.get('mode') === 'proforma';
  const defaultValidUntil = () => isoToDay(addDaysTo(new Date(), Math.max(1, parseInt(settings.proforma_valid_days, 10) || 30)).toISOString());
  const [validUntil, setValidUntil] = useState(defaultValidUntil);
  const [quoteAddress, setQuoteAddress] = useState(''); const [quoteNotes, setQuoteNotes] = useState('');
  const [docView, setDocView] = useState<string | null>(null);       // a document being shown (new proforma / invoice)
  // Back to selling from a proforma: a quote may hold more than the stock has, a sale may not. Trim and say so.
  const wasQuote = useRef(quote);
  useEffect(() => {
    if (wasQuote.current && !quote && cart.some((l) => l.qty > l.p.quantity)) {
      setCart(cart.map((l) => ({ ...l, qty: Math.min(l.qty, l.p.quantity) })).filter((l) => l.qty > 0));
      toast('info', t('pos.trimmedToStock'));
    }
    wasQuote.current = quote;
  }, [quote]); // eslint-disable-line react-hooks/exhaustive-deps
  const [invoiceSale, setInvoiceSale] = useState<string | null>(null); // sale an invoice is being created for

  const { data: products } = useLive((c) => listProducts(c, { search: dq, categoryId: cat, limit: 60 }), [dq, cat]);
  const { data: cats } = useLive((c) => listCategories(c));
  const { data: customers } = useLive((c) => (c.permissions.has('customers.read') ? listCustomers(c) : Promise.resolve([])));
  const { data: methods } = useLive((c) => getPaymentMethods(c.db));
  const { data: session } = useLive((c) => getOpenSession(c));
  const enabled = (methods ?? []).filter((x) => x.enabled);
  useEffect(() => { if (enabled.length && !enabled.some((x) => x.code === method)) setMethod(enabled[0].code); }, [methods]); // eslint-disable-line
  useEffect(() => { searchRef.current?.focus(); }, []);

  // The customer decides the price list: choosing a wholesale customer re-prices the whole cart at once.
  const customerList = useMemo(() => customers ?? [], [customers]);
  const tier = normalizeTier(customerList.find((c) => c.id === customerId)?.price_tier);
  const priceOf = (p: ProductListItem) => unitPriceFor(p, tier);
  const subtotal = cart.reduce((s, l) => s + Math.round(l.qty * priceOf(l.p)), 0);
  const lineDisc = cart.reduce((s, l) => s + l.discount, 0);
  const total = Math.max(0, subtotal - lineDisc - cartDiscount);
  const paid = tendered === '' ? total : Math.round(Number(tendered) || 0);
  const change = Math.max(0, paid - total);
  const debt = Math.max(0, total - paid);

  const add = (p: ProductListItem) => {
    if (!quote && p.quantity <= 0) return toast('error', t('errors.insufficientStock', { product: p.name, available: 0, requested: 1 }));
    setCart((c) => {
      const i = c.findIndex((l) => l.p.id === p.id);
      if (i >= 0) { const n = [...c]; n[i] = { ...n[i], qty: quote ? n[i].qty + 1 : Math.min(p.quantity, n[i].qty + 1) }; return n; }
      return [...c, { p, qty: 1, discount: 0 }];
    });
    setSearch(''); searchRef.current?.focus();
  };
  const setQty = (id: string, q: number) => setCart((c) => c.map((l) => (l.p.id === id ? { ...l, qty: Math.max(0, quote ? q : Math.min(l.p.quantity, q)) } : l)).filter((l) => l.qty > 0));

  /** Enter in the search box: exact barcode/SKU first (USB scanners "type" the code + Enter), else a single match. */
  const onEnter = async () => {
    const code = search.trim(); if (!code) return;
    const hit = await findByBarcodeOrSku(ctx, code);
    if (hit) { const full = (await listProducts(ctx, { search: hit.name })).items.find((x) => x.id === hit.id); if (full) return add(full); }
    if (products?.items.length === 1) add(products.items[0]);
    else toast('error', t('pos.notFound', { code }));
  };

  const reset = () => { setCart([]); setCustomerId(''); setCustomerName(''); setCartDiscount(0); setTendered(''); setSearch(''); setQuoteAddress(''); setQuoteNotes(''); setValidUntil(defaultValidUntil()); searchRef.current?.focus(); };
  const checkout = useAction(async () => {
    if (quote) {
      const d = await createProforma(ctx, {
        lines: cart.map((l) => ({ product_id: l.p.id, quantity: l.qty, discount: l.discount })), customer_id: customerId || null,
        party: { name: customerName, address: quoteAddress }, valid_until: validUntil || null, notes: quoteNotes, cart_discount: cartDiscount,
      });
      toast('success', t('documents.proformaCreated', { number: d.number })); setDocView(d.id); reset(); return;
    }
    const r = await createSale(ctx, {
      lines: cart.map((l) => ({ product_id: l.p.id, quantity: l.qty, discount: l.discount })), customer_id: customerId || null, customer_name: customerId ? null : customerName,
      payment_method: method, amount_tendered: paid, cart_discount: cartDiscount,
    });
    setDone(r.sale.id); reset();
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if ((e.key === 'F9' || (e.ctrlKey && e.key === 'Enter')) && cart.length && !checkout.busy) { e.preventDefault(); checkout.run(); } };
    window.addEventListener('keydown', h); return () => window.removeEventListener('keydown', h);
  });

  const canDiscount = can('sales.discount');

  return (
    <div className="-m-6 flex min-h-[calc(100%+3rem)] flex-col xl:h-[calc(100%+3rem)] xl:min-h-0 xl:flex-row">
      {/* ---------------- catalogue */}
      <section className="flex min-h-[52vh] min-w-0 flex-1 flex-col border-b border-line p-3 sm:p-4 xl:min-h-0 xl:border-b-0 xl:p-5">
        <div className="mb-3 flex flex-wrap items-center gap-2 sm:gap-3">
          <div className="flex-1"><SearchInput inputRef={searchRef} value={search} onChange={setSearch} onEnter={onEnter} placeholder={t('pos.searchPlaceholder')} shortcut="↵" /></div>
          <Segmented options={[{ id: 'sale', label: t('pos.modeSale') }, { id: 'proforma', label: t('pos.modeProforma') }]} value={quote ? 'proforma' : 'sale'}
            onChange={(v) => { setParams(v === 'proforma' ? { mode: 'proforma' } : {}); }} />
          {can('cash.manage') && !quote && (session
            ? <Button variant="secondary" icon={<Lock className="h-4 w-4" />} onClick={() => setSessionModal('close')}>{t('pos.closeRegister')}</Button>
            : <Button variant="secondary" icon={<Unlock className="h-4 w-4" />} onClick={() => setSessionModal('open')}>{t('pos.openRegister')}</Button>)}
        </div>
        <div className="mb-3 flex flex-wrap gap-1.5">
          <button onClick={() => setCat(null)} className={cn('rounded-full border px-3 py-1 text-[12px] font-medium', !cat ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-surface hover:bg-muted')}>{t('common.all')}</button>
          {(cats ?? []).map((c) => <button key={c.id} onClick={() => setCat(c.id)} className={cn('rounded-full border px-3 py-1 text-[12px] font-medium', cat === c.id ? 'border-brand bg-brand-soft text-brand' : 'border-line bg-surface hover:bg-muted')}>{c.name}</button>)}
        </div>
        <div className="grid max-h-[38vh] min-h-0 flex-1 auto-rows-min grid-cols-2 gap-2 overflow-y-auto pb-2 sm:gap-3 xl:max-h-none xl:grid-cols-3 2xl:grid-cols-4">
          {(products?.items ?? []).map((p) => (
            <button key={p.id} onClick={() => add(p)} disabled={!quote && p.quantity <= 0}
              className={cn('flex flex-col rounded-lg border bg-surface p-3 text-left shadow-card transition hover:border-brand hover:shadow-pop disabled:cursor-not-allowed disabled:opacity-50', can('products.stock.read') && p.stock_level === 'LOW' ? 'border-warn/40' : 'border-line')}>
              {p.image ? <img src={p.image} alt="" className="mb-2 h-16 w-full rounded object-cover" /> : <div className="mb-2 flex h-16 items-center justify-center rounded bg-muted font-display text-[22px] font-bold text-faint">{p.name.slice(0, 2).toUpperCase()}</div>}
              <div className="line-clamp-2 min-h-[34px] text-[13px] font-semibold leading-[17px] text-ink">{p.name}</div>
              <div className="mt-1 flex items-end justify-between"><span className="num font-display text-[15px] font-bold text-brand">{m(priceOf(p))}{priceOf(p) !== p.selling_price && <span className="ml-1 text-[10px] font-semibold uppercase text-ok-text">{t('pos.wholesaleTag')}</span>}</span>
                {can('products.stock.read') && <span className={cn('num text-[11px]', p.stock_level === 'OK' ? 'text-faint' : p.stock_level === 'LOW' ? 'text-warn-text' : 'text-bad-text')}>{p.quantity <= 0 ? t('products.out') : `${formatQty(p.quantity, lang)} ${p.unit}`}</span>}</div>
            </button>
          ))}
          {products && products.items.length === 0 && <div className="col-span-full"><Empty title={t('pos.noResults')} /></div>}
        </div>
      </section>

      {/* ---------------- cart */}
      <aside className="flex min-h-[65vh] min-w-0 flex-col bg-surface xl:min-h-0 xl:w-[min(400px,38vw)] xl:shrink-0 xl:border-l xl:border-line">
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 className="font-display text-[16px] font-semibold text-ink">{t('pos.cart')} {cart.length > 0 && <Badge tone="info">{cart.length}</Badge>}</h2>
          {cart.length > 0 && <button onClick={reset} className="text-[12px] text-faint hover:text-bad">{t('pos.clear')}</button>}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {cart.length === 0 ? <Empty title={t('pos.emptyCart')} hint={t('pos.emptyCartHint')} /> : (
            <ul className="divide-y divide-line/60">{cart.map((l) => (
              <li key={l.p.id} className="px-4 py-2.5">
                <div className="flex items-start justify-between gap-2"><span className="text-[13px] font-semibold text-ink">{l.p.name}</span>
                  <button onClick={() => setQty(l.p.id, 0)} className="text-faint hover:text-bad" aria-label="remove"><Trash2 className="h-3.5 w-3.5" /></button></div>
                <div className="mt-1.5 flex items-center justify-between">
                  <div className="flex items-center gap-1">
                    <button className="flex h-7 w-7 items-center justify-center rounded border border-line-strong hover:bg-muted" onClick={() => setQty(l.p.id, l.qty - 1)}><Minus className="h-3 w-3" /></button>
                    <input value={l.qty} onChange={(e) => setQty(l.p.id, parseFloat(e.target.value.replace(',', '.')) || 0)} className="num h-7 w-14 rounded border border-line-strong bg-surface text-center text-[13px] focus-ring" />
                    <button className="flex h-7 w-7 items-center justify-center rounded border border-line-strong hover:bg-muted" onClick={() => setQty(l.p.id, l.qty + 1)}><Plus className="h-3 w-3" /></button>
                    <span className="ml-1 text-[11px] text-faint">× {m(priceOf(l.p))}</span>
                  </div>
                  <span className="num text-[14px] font-bold text-ink">{m(Math.round(l.qty * priceOf(l.p)) - l.discount)}</span>
                </div>
                {canDiscount && <div className="mt-1.5 flex items-center gap-2 text-[11px] text-faint"><Percent className="h-3 w-3" />{t('pos.lineDiscount')}
                  <input type="number" min={0} value={l.discount || ''} onChange={(e) => setCart((c) => c.map((x) => (x.p.id === l.p.id ? { ...x, discount: Math.max(0, Math.round(Number(e.target.value) || 0)) } : x)))} className="num h-6 w-20 rounded border border-line bg-surface px-1.5 text-right text-[12px] focus-ring" placeholder="0" /></div>}
              </li>))}</ul>)}
        </div>

        <div className="space-y-2 border-t border-line bg-muted/30 p-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          {customerList.length > 0 || can('customers.read') ? (
            <Select value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
              <option value="">{t('pos.walkIn')}</option>{customerList.map((c) => <option key={c.id} value={c.id}>{c.name}{c.price_tier === 'WHOLESALE' ? ` · ${t('customers.tierWholesale')}` : ''}{c.balance_due > 0 ? ` (${t('customers.owes')} ${m(c.balance_due)})` : ''}</option>)}
            </Select>) : null}
          {!customerId && <Input value={customerName} maxLength={60} onChange={(e) => setCustomerName(e.target.value)} placeholder={t('pos.customerNameOptional')} aria-label={t('pos.customerNameOptional')} />}
          </div>
          {tier === 'WHOLESALE' && <div className="rounded border border-ok/40 bg-ok-soft px-2.5 py-1.5 text-[12px] font-semibold text-ok-text">{t('pos.wholesalePrices')}</div>}
          {!quote && <div className="grid grid-cols-4 gap-1">{enabled.map((x) => (
            <button key={x.code} onClick={() => setMethod(x.code)} className={cn('flex flex-col items-center gap-0.5 rounded border px-1 py-1.5 text-[10px] font-semibold sm:text-[11px]', method === x.code ? 'border-brand bg-brand-soft text-brand' : 'border-line-strong bg-surface hover:bg-muted')}>
              {METHOD_ICON[x.code] ?? <Wallet className="h-4 w-4" />}{lang === 'fr' ? x.label_fr : x.label_en}</button>))}</div>}
          <div className="space-y-0.5 text-[12px]">
            <div className="flex justify-between text-faint"><span>{t('pos.subtotal')}</span><span className="num">{m(subtotal)}</span></div>
            {lineDisc > 0 && <div className="flex justify-between text-faint"><span>{t('pos.lineDiscounts')}</span><span className="num">-{m(lineDisc)}</span></div>}
            {canDiscount && <div className="flex items-center justify-between text-faint"><span>{t('pos.discount')}</span>
              <input type="number" min={0} value={cartDiscount || ''} onChange={(e) => setCartDiscount(Math.max(0, Math.round(Number(e.target.value) || 0)))} placeholder="0" className="num h-7 w-24 rounded border border-line bg-surface px-2 text-right text-[12px] focus-ring" /></div>}
            <div className="flex items-end justify-between border-t border-line pt-1.5"><span className="font-semibold text-ink">{t('pos.total')}</span><span className="num font-display text-[22px] font-bold leading-7 text-ink">{m(total)}</span></div>
          </div>
          {quote ? (
            <div className="space-y-2">
              {!customerId && <Input value={quoteAddress} maxLength={120} onChange={(e) => setQuoteAddress(e.target.value)} placeholder={t('documents.customerAddress')} aria-label={t('documents.customerAddress')} />}
              <div className="grid grid-cols-2 gap-2">
                <Field label={t('documents.validUntil')}><Input type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} /></Field>
                <Field label={t('documents.notes')}><Input value={quoteNotes} maxLength={200} onChange={(e) => setQuoteNotes(e.target.value)} /></Field>
              </div>
              <p className="text-[11px] text-faint">{t('pos.proformaHint')}</p>
            </div>
          ) : (
          <div className="grid grid-cols-2 gap-2">
            <Field label={t('pos.received')}><Input type="number" min={0} value={tendered} onChange={(e) => setTendered(e.target.value)} placeholder={String(total)} /></Field>
            <div className="flex flex-col justify-end text-right text-[12px]">
              {debt > 0 ? <span className="font-semibold text-warn-text">{t('pos.onCredit')}: {m(debt)}</span> : <span className="text-faint">{t('pos.change')}: <b className="num text-ink">{m(change)}</b></span>}
            </div>
          </div>
          )}
          <Button className="w-full" loading={checkout.busy} disabled={!cart.length} onClick={() => checkout.run()} icon={quote ? <FileText className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}>{quote ? `${t('pos.createProforma')} · ` : `${t('pos.charge')} `}{m(total)} <span className="kbd ml-1 !bg-white/20 !text-white !border-white/30">F9</span></Button>
        </div>
      </aside>

      <SaleDone saleId={done} receiptPrint={!invoiceSale && !docView} onInvoice={can('sales.create') ? (id) => setInvoiceSale(id) : undefined} onClose={() => { setDone(null); searchRef.current?.focus(); }} />
      {invoiceSale && <InvoiceDetailsModal saleId={invoiceSale} onClose={() => setInvoiceSale(null)} onCreated={(id) => { setInvoiceSale(null); setDocView(id); }} />}
      {docView && <DocumentView id={docView} onClose={() => setDocView(null)} onOpen={(id) => setDocView(id)} />}
      <SessionModal mode={sessionModal} onClose={() => setSessionModal(null)} sessionId={session?.id} />
    </div>
  );
}

function SaleDone({ saleId, onClose, onInvoice, receiptPrint }: { saleId: string | null; onClose: () => void; onInvoice?: (saleId: string) => void; receiptPrint: boolean }) {
  const { t } = useTranslation();
  const { lang } = useApp();
  const { data } = useLive((c) => (saleId ? getSale(c, saleId) : Promise.resolve(undefined)), [saleId]);
  if (!saleId) return null;
  return (
    <Modal open title={t('pos.saleDone')} onClose={onClose}
      footer={<>{onInvoice && <Button variant="secondary" icon={<FilePlus2 className="h-4 w-4" />} onClick={() => onInvoice(saleId)}>{t('pos.invoice')}</Button>}<Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('pos.printReceipt')}</Button><Button onClick={onClose} autoFocus>{t('pos.newSale')}</Button></>}>
      {data && (<>
        <div className="mb-3 flex items-center gap-2 text-ok-text"><CheckCircle2 className="h-5 w-5" /><span className="font-semibold">{data.sale.receipt_no}</span></div>
        <div className="num font-display text-[28px] font-bold text-ink">{formatMoney(data.sale.total, lang)}</div>
        {data.sale.change_due > 0 && <div className="text-[14px] text-body">{t('pos.change')}: <b>{formatMoney(data.sale.change_due, lang)}</b></div>}
        {data.sale.total > data.sale.amount_paid && <div className="text-[14px] text-warn-text">{t('pos.onCredit')}: <b>{formatMoney(data.sale.total - data.sale.amount_paid, lang)}</b></div>}
        <p className="mt-3 text-[12px] text-faint">{t('pos.savedLocally')}</p>
        {receiptPrint && <Receipt sale={data.sale} items={data.items} customer={data.customer} />}
      </>)}
    </Modal>
  );
}

function SessionModal({ mode, onClose, sessionId }: { mode: 'open' | 'close' | null; onClose: () => void; sessionId?: string }) {
  const { t } = useTranslation();
  const ctx = useCtx();
  const { lang, toast } = useApp();
  const [amount, setAmount] = useState('');
  const [report, setReport] = useState<ZReport | null>(null);
  const [final, setFinal] = useState(false);
  const m = (n: number) => formatMoney(n, lang);
  useEffect(() => { setAmount(''); setFinal(false); setReport(null); if (mode === 'close' && sessionId) zReport(ctx, sessionId).then(setReport); }, [mode, sessionId]); // eslint-disable-line
  const act = useAction(async () => {
    if (mode === 'open') { await openSession(ctx, Number(amount) || 0); toast('success', t('pos.registerOpened')); onClose(); }
    else if (sessionId) { setReport(await closeSession(ctx, sessionId, Number(amount) || 0)); setFinal(true); }
  });
  if (!mode) return null;
  return (
    <Modal open title={mode === 'open' ? t('pos.openRegister') : t('pos.zReport')} onClose={onClose} wide={mode === 'close'}
      footer={final ? <><Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('pos.printReceipt')}</Button><Button onClick={onClose}>{t('common.close')}</Button></>
        : <><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={act.busy} onClick={() => act.run()}>{mode === 'open' ? t('pos.openRegister') : t('pos.closeRegister')}</Button></>}>
      {final && report && <ZSheet report={report} />}
      {mode === 'open' ? (
        <Field label={t('pos.openingFloat')} hint={t('pos.openingFloatHint')}><Input autoFocus type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" /></Field>
      ) : report && (
        <div className="space-y-4 text-[13px]">
          <div className="grid grid-cols-3 gap-3">
            {[[t('pos.salesCount'), String(report.sales_count)], [t('pos.netSales'), m(report.net)], [t('pos.discounts'), m(report.discounts)]].map(([k, v]) => (
              <div key={k} className="rounded border border-line bg-muted/40 p-3"><div className="text-[11px] uppercase text-faint">{k}</div><div className="num font-display text-[18px] font-bold text-ink">{v}</div></div>))}
          </div>
          <table className="tbl"><thead><tr><th>{t('pos.paymentMethod')}</th><th className="r">{t('pos.salesCount')}</th><th className="r">{t('common.total')}</th></tr></thead>
            <tbody>{report.by_method.map((b) => <tr key={b.method}><td>{t(`methods.${b.method}`, { defaultValue: b.method })}</td><td className="r">{b.count}</td><td className="r">{m(b.total)}</td></tr>)}</tbody></table>
          <div className="space-y-1 rounded border border-line p-3">
            <div className="flex justify-between"><span>{t('pos.openingFloat')}</span><span className="num">{m(report.session.opening_float)}</span></div>
            <div className="flex justify-between font-semibold"><span>{t('pos.expectedCash')}</span><span className="num">{m(report.expected_cash)}</span></div>
            {final && <><div className="flex justify-between"><span>{t('pos.countedCash')}</span><span className="num">{m(report.session.counted_cash ?? 0)}</span></div>
              <div className={cn('flex justify-between font-bold', (report.session.difference ?? 0) === 0 ? 'text-ok-text' : 'text-bad-text')}><span>{t('pos.difference')}</span><span className="num">{m(report.session.difference ?? 0)}</span></div></>}
          </div>
          {!final && <Field label={t('pos.countedCash')}><Input autoFocus type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>}
        </div>)}
    </Modal>
  );
}

/** Printable Z-report (closing summary), rendered in #print-root. */
function ZSheet({ report }: { report: ZReport }) {
  const { t } = useTranslation();
  const { lang, settings } = useApp();
  const m = (n: number) => formatMoney(n, lang);
  const row = (a: string, b: string, bold = false) => <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: bold ? 700 : 400 }}><span>{a}</span><span>{b}</span></div>;
  const line = <div style={{ borderTop: '1px dashed #000', margin: '4px 0' }} />;
  const s = report.session;
  return (
    <PrintPortal>
      <div className="receipt-root">
        <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 13 }}>{settings.business_name}</div>
        <div style={{ textAlign: 'center' }}>{settings.branch_name}</div>
        <div style={{ textAlign: 'center', fontWeight: 700, margin: '4px 0' }}>{t('pos.zReport')}</div>
        {line}
        <div>{t('receipt.cashier')}: {s.user_name}</div>
        <div>{t('pos.openedAt')}: {formatDate(s.opened_at, lang, true)}</div>
        {s.closed_at && <div>{t('pos.closedAt')}: {formatDate(s.closed_at, lang, true)}</div>}
        {line}
        {row(t('pos.salesCount'), String(report.sales_count))}
        {row(t('pos.discounts'), m(report.discounts))}
        {row(t('pos.netSales'), m(report.net), true)}
        {line}
        {report.by_method.map((b) => row(`${t(`methods.${b.method}`, { defaultValue: b.method })} (${b.count})`, m(b.total)))}
        {line}
        {row(t('pos.openingFloat'), m(s.opening_float))}
        {row(t('pos.expectedCash'), m(report.expected_cash), true)}
        {row(t('pos.countedCash'), m(s.counted_cash ?? 0))}
        {row(t('pos.difference'), m(s.difference ?? 0), true)}
      </div>
    </PrintPortal>
  );
}
