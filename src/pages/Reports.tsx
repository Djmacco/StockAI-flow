import { Download, FileText, Plus, Printer, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PrintPortal } from '../components/PrintPortal';
import { Badge, Button, Card, Empty, Field, Input, PageHeader, PageLoader, Segmented, Select, Tabs, useAction } from '../components/ui';
import { formatDate, formatMoney, formatQty } from '../lib/format';
import { toCsv } from '../lib/csv';
import { addDays, startOfDay } from '../lib/time';
import { createExpense, deleteExpense, listExpenses } from '../services/purchases';
import {
  bestSellers, dailySeries, expenseTotal, expiringBatches, inventoryValue, lowStockProducts, mostProfitable, purchaseTotals, rangeMonth, rangeToday, rangeWeek,
  salesByPaymentMethod, salesSummary, slowMovers, supplierPurchases, topCustomers, type DateRange,
} from '../services/reports';
import { getPaymentMethods } from '../services/settings';
import { listSales, type SaleListRow } from '../services/sales';
import { useApp, useCan, useCtx } from '../state/app';
import { useLive } from '../state/hooks';

type Tab = 'sales' | 'profit' | 'inventory' | 'products' | 'purchases' | 'customers' | 'expenses';
type Preset = 'today' | 'week' | 'month' | 'custom';

function Bars({ data, color = 'fill-brand' }: { data: { label: string; value: number }[]; color?: string }) {
  const max = Math.max(1, ...data.map((d) => d.value));
  const w = 100 / Math.max(1, data.length);
  return (
    <svg viewBox="0 0 100 40" className="h-44 w-full" preserveAspectRatio="none">
      {data.map((d, i) => <rect key={i} x={i * w + w * 0.12} width={w * 0.76} y={38 - (d.value / max) * 36} height={Math.max(0.3, (d.value / max) * 36)} rx="0.5" className={color}><title>{d.label}: {d.value}</title></rect>)}
      <line x1="0" y1="38" x2="100" y2="38" className="stroke-line" strokeWidth="0.3" />
    </svg>
  );
}
const Stat = ({ k, v, tone }: { k: string; v: string; tone?: string }) => (<div className="rounded-lg border border-line bg-surface p-4 shadow-card"><div className="text-[11px] font-semibold uppercase tracking-wide text-faint">{k}</div><div className={`num font-display text-[22px] font-bold ${tone ?? 'text-ink'}`}>{v}</div></div>);

export function Reports() {
  const { t } = useTranslation(); const can = useCan(); const ctx = useCtx(); const { lang } = useApp();
  const m = (n: number) => formatMoney(n, lang);
  const [tab, setTab] = useState<Tab>('sales');
  const [preset, setPreset] = useState<Preset>('month');
  const today = ymdLocal(new Date());
  const [from, setFrom] = useState(today); const [to, setTo] = useState(today);
  const now = ctx.now();
  const range: DateRange = preset === 'today' ? rangeToday(now) : preset === 'week' ? rangeWeek(now) : preset === 'month' ? rangeMonth(now)
    : { from: startOfDay(new Date(from + 'T00:00:00')), to: addDays(startOfDay(new Date(to + 'T00:00:00')), 1) };
  const key = [preset, from, to];

  const tabs: { id: Tab; label: string }[] = [{ id: 'sales', label: t('reports.sales') }, { id: 'profit', label: t('reports.profit') }, { id: 'inventory', label: t('reports.inventory') },
    { id: 'products', label: t('reports.products') }, { id: 'purchases', label: t('reports.purchases') }, { id: 'customers', label: t('reports.customers') }, ...(can('expenses.manage') ? [{ id: 'expenses' as Tab, label: t('reports.expenses') }] : [])];

  return (
    <div>
      <PageHeader title={t('nav.reports')} subtitle={t('reports.subtitle')}
        actions={tab !== 'inventory' && <>
          {preset === 'custom' && <div className="flex items-center gap-2"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="w-40" /><span className="text-faint">→</span><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="w-40" /></div>}
          <Segmented<Preset> options={[{ id: 'today', label: t('common.today') }, { id: 'week', label: t('common.thisWeek') }, { id: 'month', label: t('common.thisMonth') }, { id: 'custom', label: t('common.custom') }]} value={preset} onChange={setPreset} /></>} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} />
      <div className="pt-4">
        {tab === 'sales' && <SalesTab range={range} k={key} profit={false} />}
        {tab === 'profit' && <SalesTab range={range} k={key} profit />}
        {tab === 'inventory' && <InventoryTab />}
        {tab === 'products' && <ProductsTab range={range} k={key} />}
        {tab === 'purchases' && <PurchasesTab range={range} k={key} />}
        {tab === 'customers' && <CustomersTab range={range} k={key} />}
        {tab === 'expenses' && <ExpensesTab range={range} k={key} />}
      </div>
      <span className="hidden">{m(0)}</span>
    </div>
  );
}
const ymdLocal = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function SalesTab({ range, k, profit }: { range: DateRange; k: unknown[]; profit: boolean }) {
  const { t } = useTranslation(); const { lang } = useApp(); const ctx = useCtx(); const m = (n: number) => formatMoney(n, lang);
  const [printRows, setPrintRows] = useState<SaleListRow[] | null>(null);
  const [printReady, setPrintReady] = useState(false);
  useEffect(() => {
    if (!printReady) return;
    const timer = window.setTimeout(() => { window.print(); setPrintReady(false); }, 100);
    return () => window.clearTimeout(timer);
  }, [printReady]);
  const { data } = useLive(async (c) => ({
    s: await salesSummary(c, range), d: await dailySeries(c, range), e: await expenseTotal(c, range),
    methods: profit ? [] : await getPaymentMethods(c.db), byMethod: profit ? [] : await salesByPaymentMethod(c, range),
  }), k);
  const loadSales = async () => {
    const rows: SaleListRow[] = [];
    for (let offset = 0; ; offset += 500) {
      const page = await listSales(ctx, { from: range.from.toISOString(), to: range.to.toISOString(), status: 'COMPLETED', limit: 500, offset });
      rows.push(...page);
      if (page.length < 500) return rows;
    }
  };
  const exportSpreadsheet = async () => {
    const rows = await loadSales();
    const headers = [t('common.date'), t('receipt.no'), t('receipt.customer'), t('pos.paymentMethod'), t('reports.revenue'), t('reports.cost'), t('reports.grossProfit')];
    const records = rows.map((sale) => [sale.sold_at, sale.receipt_no, sale.customer_name ?? '', t(`methods.${sale.payment_method}`, { defaultValue: sale.payment_method }), sale.total, sale.cost_total, sale.total - sale.cost_total]);
    const blob = new Blob([toCsv([headers, ...records])], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob); const link = document.createElement('a');
    link.href = url; link.download = `sales-${ymdLocal(range.from)}-to-${ymdLocal(addDays(range.to, -1))}.csv`;
    document.body.appendChild(link); link.click(); link.remove(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const preparePdf = async () => { setPrintRows(await loadSales()); setPrintReady(true); };
  const excelExport = useAction(exportSpreadsheet);
  const pdfExport = useAction(preparePdf);
  if (!data) return <PageLoader />;
  const { s, d, e } = data;
  return (
    <div className="space-y-4">
      {!profit && <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" size="sm" loading={excelExport.busy} icon={<Download className="h-4 w-4" />} onClick={() => void excelExport.run()}>{t('reports.exportExcel')}</Button>
        <Button variant="secondary" size="sm" loading={pdfExport.busy} icon={<FileText className="h-4 w-4" />} onClick={() => void pdfExport.run()}>{t('reports.exportPdf')}</Button>
        <Button variant="secondary" size="sm" loading={pdfExport.busy} icon={<Printer className="h-4 w-4" />} onClick={() => void pdfExport.run()}>{t('reports.printReport')}</Button>
      </div>}
      <div className="grid grid-cols-4 gap-4">
        {profit ? <><Stat k={t('reports.revenue')} v={m(s.revenue)} /><Stat k={t('reports.cost')} v={m(s.cost)} /><Stat k={t('reports.grossProfit')} v={m(s.profit)} tone="text-ok-text" /><Stat k={t('reports.margin')} v={`${Math.round(s.margin)}%`} />
          <Stat k={t('reports.expenses')} v={m(e)} /><Stat k={t('reports.netProfit')} v={m(s.profit - e)} tone={s.profit - e >= 0 ? 'text-ok-text' : 'text-bad-text'} /></>
          : <><Stat k={t('reports.revenue')} v={m(s.revenue)} /><Stat k={t('dashboard.tickets')} v={String(s.count)} /><Stat k={t('dashboard.avgTicket')} v={m(s.avg_ticket)} /><Stat k={t('reports.cancelled')} v={String(s.cancelled)} /></>}
      </div>
      {!profit && <Card title={t('reports.byPaymentMethod')}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {data.methods.filter((method) => method.enabled || data.byMethod.some((row) => row.method === method.code)).map((method) => {
            const row = data.byMethod.find((x) => x.method === method.code);
            return <div key={method.code} className="rounded-lg border border-line bg-surface p-3">
              <div className="text-[12px] font-semibold text-faint">{lang === 'fr' ? method.label_fr : method.label_en}</div>
              <div className="num mt-1 font-display text-[20px] font-bold text-ink">{m(row?.collected ?? 0)}</div>
              <div className="mt-1 text-[11px] text-faint">{t('reports.paymentCollected')} · {t('reports.paymentSales', { count: row?.count ?? 0, total: m(row?.salesTotal ?? 0) })}</div>
            </div>;
          })}
          {data.methods.length === 0 && <Empty title="—" />}
        </div>
      </Card>}
      <Card title={profit ? t('reports.dailyProfit') : t('reports.dailySales')}><Bars data={d.map((p) => ({ label: p.day, value: profit ? p.profit : p.revenue }))} color={profit ? 'fill-ok' : 'fill-brand'} />
        <div className="mt-1 flex justify-between text-[11px] text-faint"><span>{d[0]?.day}</span><span>{d[d.length - 1]?.day}</span></div></Card>
      <Card bodyClass="!p-0"><div className="max-h-72 overflow-auto"><table className="tbl"><thead><tr><th>{t('common.date')}</th><th className="r">{t('dashboard.tickets')}</th><th className="r">{t('reports.revenue')}</th>{profit && <th className="r">{t('reports.grossProfit')}</th>}</tr></thead>
        <tbody>{[...d].reverse().map((p) => <tr key={p.day}><td>{formatDate(p.day + 'T12:00:00', lang)}</td><td className="r">{p.count}</td><td className="r">{m(p.revenue)}</td>{profit && <td className="r text-ok-text">{m(p.profit)}</td>}</tr>)}</tbody></table></div></Card>
      {printRows && <PrintPortal><div className="sales-report-print">
        <h1>{t('reports.exportTitle')}</h1><p>{t('reports.exportPeriod', { from: formatDate(range.from.toISOString(), lang), to: formatDate(addDays(range.to, -1).toISOString(), lang) })}</p>
        <section><b>{t('reports.revenue')}: {m(s.revenue)}</b><b>{t('reports.cost')}: {m(s.cost)}</b><b>{t('reports.grossProfit')}: {m(s.profit)}</b><b>{t('reports.expenses')}: {m(e)}</b><b>{t('reports.netProfit')}: {m(s.profit - e)}</b></section>
        <table><thead><tr>{[t('common.date'), t('receipt.no'), t('receipt.customer'), t('pos.paymentMethod'), t('reports.revenue'), t('reports.cost'), t('reports.grossProfit')].map((label) => <th key={label}>{label}</th>)}</tr></thead>
          <tbody>{printRows.map((sale) => <tr key={sale.id}><td>{formatDate(sale.sold_at, lang, true)}</td><td>{sale.receipt_no}</td><td>{sale.customer_name ?? '—'}</td><td>{t(`methods.${sale.payment_method}`, { defaultValue: sale.payment_method })}</td><td>{m(sale.total)}</td><td>{m(sale.cost_total)}</td><td>{m(sale.total - sale.cost_total)}</td></tr>)}</tbody>
        </table>
      </div></PrintPortal>}
    </div>
  );
}

function InventoryTab() {
  const { t } = useTranslation(); const { lang } = useApp(); const m = (n: number) => formatMoney(n, lang);
  const { data } = useLive(async (c) => ({ v: await inventoryValue(c), low: await lowStockProducts(c, 200), e: await expiringBatches(c) }));
  if (!data) return <PageLoader />;
  const list = (rows: { a: string; b: string; tone?: 'bad' | 'warn' }[]) => rows.length ? <ul className="divide-y divide-line/60">{rows.map((r, i) => <li key={i} className="flex justify-between px-4 py-2 text-[13px]"><span>{r.a}</span><Badge tone={r.tone ?? 'neutral'}>{r.b}</Badge></li>)}</ul> : <p className="p-4 text-[13px] text-faint">—</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-4 gap-4"><Stat k={t('dashboard.stockValue')} v={m(data.v.value_cost)} /><Stat k={t('dashboard.retail')} v={m(data.v.value_retail)} /><Stat k={t('dashboard.products')} v={String(data.v.products)} /><Stat k={t('dashboard.units')} v={formatQty(data.v.units, lang)} /></div>
      <div className="grid grid-cols-3 gap-4">
        <Card title={t('reports.lowStock')} bodyClass="!p-0">{list(data.low.map((p) => ({ a: p.name, b: p.quantity <= 0 ? t('products.out') : `${formatQty(p.quantity, lang)}/${formatQty(p.minimum_stock, lang)}`, tone: p.quantity <= 0 ? 'bad' : 'warn' })))}</Card>
        <Card title={t('reports.expiredStock')} bodyClass="!p-0">{list(data.e.expired.map((b) => ({ a: `${b.product_name} · ${b.expiry_date}`, b: `${formatQty(b.quantity_remaining, lang)} ${b.unit}`, tone: 'bad' as const })))}</Card>
        <Card title={t('reports.expiringStock')} bodyClass="!p-0">{list(data.e.soon.map((b) => ({ a: `${b.product_name} · ${b.expiry_date}`, b: t('products.inDays', { count: b.days }), tone: b.days <= 7 ? ('warn' as const) : undefined })))}</Card>
      </div>
    </div>
  );
}

function ProductsTab({ range, k }: { range: DateRange; k: unknown[] }) {
  const { t } = useTranslation(); const { lang } = useApp(); const m = (n: number) => formatMoney(n, lang);
  const { data } = useLive(async (c) => ({ best: await bestSellers(c, range, 10), prof: await mostProfitable(c, range, 10), slow: await slowMovers(c, range, 10) }), k);
  if (!data) return <PageLoader />;
  const T = ({ rows }: { rows: [string, string][] }) => rows.length ? <ul className="divide-y divide-line/60">{rows.map(([a, b], i) => <li key={i} className="flex justify-between px-4 py-2 text-[13px]"><span className="truncate">{i + 1}. {a}</span><b className="num">{b}</b></li>)}</ul> : <p className="p-4 text-[13px] text-faint">—</p>;
  return (
    <div className="grid grid-cols-3 gap-4">
      <Card title={t('reports.bestSellers')} bodyClass="!p-0"><T rows={data.best.map((p) => [p.name, `${formatQty(p.quantity, lang)} ${p.unit}`])} /></Card>
      <Card title={t('reports.mostProfitable')} bodyClass="!p-0"><T rows={data.prof.map((p) => [p.name, m(p.profit)])} /></Card>
      <Card title={t('reports.slowMovers')} bodyClass="!p-0"><T rows={data.slow.map((p) => [p.name, `${formatQty(p.sold, lang)} / ${formatQty(p.quantity, lang)}`])} /></Card>
    </div>
  );
}

function PurchasesTab({ range, k }: { range: DateRange; k: unknown[] }) {
  const { t } = useTranslation(); const { lang } = useApp(); const m = (n: number) => formatMoney(n, lang);
  const { data } = useLive(async (c) => ({ tot: await purchaseTotals(c, range), by: await supplierPurchases(c, range) }), k);
  if (!data) return <PageLoader />;
  return (<div className="space-y-4"><div className="grid grid-cols-3 gap-4"><Stat k={t('reports.purchaseTotal')} v={m(data.tot.total)} /><Stat k={t('reports.purchaseCount')} v={String(data.tot.count)} /><Stat k={t('purchases.outstanding')} v={m(data.tot.total - data.tot.paid)} tone="text-warn-text" /></div>
    <Card title={t('reports.bySupplier')} bodyClass="!p-0"><table className="tbl"><thead><tr><th>{t('purchases.supplier')}</th><th className="r">{t('purchases.tabPurchases')}</th><th className="r">{t('common.total')}</th></tr></thead><tbody>{data.by.map((r, i) => <tr key={i}><td>{r.name ?? '—'}</td><td className="r">{r.count}</td><td className="r font-semibold">{m(r.total)}</td></tr>)}</tbody></table>{data.by.length === 0 && <Empty title="—" />}</Card></div>);
}

function CustomersTab({ range, k }: { range: DateRange; k: unknown[] }) {
  const { t } = useTranslation(); const { lang } = useApp();
  const { data } = useLive((c) => topCustomers(c, range, 15), k);
  if (!data) return <PageLoader />;
  return <Card title={t('reports.topCustomers')} bodyClass="!p-0">{data.length === 0 ? <Empty title="—" /> : <table className="tbl"><thead><tr><th>{t('common.name')}</th><th className="r">{t('customers.purchases')}</th><th className="r">{t('common.total')}</th></tr></thead><tbody>{data.map((r) => <tr key={r.customer_id}><td className="font-medium">{r.name}</td><td className="r">{r.count}</td><td className="r font-semibold">{formatMoney(r.total, lang)}</td></tr>)}</tbody></table>}</Card>;
}

function ExpensesTab({ range, k }: { range: DateRange; k: unknown[] }) {
  const { t } = useTranslation(); const ctx = useCtx(); const { lang, toast } = useApp();
  const { data } = useLive((c) => listExpenses(c, range.from.toISOString(), range.to.toISOString()), k);
  const [f, setF] = useState({ category: '', description: '', amount: '' });
  const add = useAction(async () => { await createExpense(ctx, { category: f.category, description: f.description, amount: Number(f.amount) }); setF({ category: '', description: '', amount: '' }); toast('success', t('common.saved')); });
  const total = (data ?? []).reduce((s, e) => s + e.amount, 0);
  return (
    <div className="space-y-4">
      <Card title={t('reports.addExpense')}><form className="grid grid-cols-[1fr_2fr_160px_auto] items-end gap-3" onSubmit={(e) => { e.preventDefault(); add.run(); }}>
        <Field label={t('reports.expenseCategory')}><Input list="expcats" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} /><datalist id="expcats">{['Loyer', 'Électricité', 'Transport', 'Salaires', 'Internet'].map((x) => <option key={x} value={x} />)}</datalist></Field>
        <Field label={t('common.notes')}><Input value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></Field>
        <Field label={t('common.amount')}><Input type="number" min={0} value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></Field>
        <Button type="submit" loading={add.busy} disabled={!f.category || !(Number(f.amount) > 0)} icon={<Plus className="h-4 w-4" />}>{t('common.add')}</Button></form></Card>
      <Card title={`${t('reports.expenses')} · ${formatMoney(total, lang)}`} bodyClass="!p-0">{!data || data.length === 0 ? <Empty title="—" /> :
        <table className="tbl"><tbody>{data.map((e) => <tr key={e.id}><td className="text-faint">{formatDate(e.spent_at, lang)}</td><td className="font-medium">{e.category}</td><td className="text-faint">{e.description}</td><td className="r font-semibold">{formatMoney(e.amount, lang)}</td>
          <td className="w-10"><button className="text-faint hover:text-bad" onClick={() => deleteExpense(ctx, e.id)}><Trash2 className="h-3.5 w-3.5" /></button></td></tr>)}</tbody></table>}</Card>
    </div>
  );
}
void Select;
