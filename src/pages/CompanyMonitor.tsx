import { Activity, ArrowDownToLine, CalendarDays, Clock3, Cloud, LogOut, RefreshCw, Search, ShieldCheck, ShoppingBag, TrendingUp, WalletCards } from 'lucide-react';
import { type FormEvent, type ReactNode, useCallback, useEffect, useState } from 'react';
import { PrintPortal } from '../components/PrintPortal';
import { Button, Card, Field, Input } from '../components/ui';
import { clearMonitorSession, getMonitorAccount, getMonitorSales, hasMonitorSession, monitorLogin, monitorLogout, type MonitorAccount, type MonitorResponse, type MonitorSale } from '../cloud/company-monitor';

const localDay = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const dayOffset = (days: number) => { const d = new Date(); d.setDate(d.getDate() - days); return localDay(d); };
const money = (value: number) => new Intl.NumberFormat(undefined, { style: 'currency', currency: 'XAF', maximumFractionDigits: 0 }).format(Number(value || 0));
const dateTime = (value: string | Date) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
const methodName = (value: string) => ({ CASH: 'Cash', MOBILE_MONEY: 'Mobile Money', ORANGE_MONEY: 'Orange Money', CARD: 'Card', OTHER: 'Other' }[value] || value.replaceAll('_', ' '));

export function CompanyMonitor({ onBack }: { onBack?: () => void }) {
  const [account, setAccount] = useState<MonitorAccount | null>(null);
  const [checking, setChecking] = useState(hasMonitorSession());
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [loginBusy, setLoginBusy] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(''); const [transactions, setTransactions] = useState<MonitorSale[]>([]);
  const [summary, setSummary] = useState<MonitorResponse['summary']>({ count: 0, completed: 0, profit: 0, cancelled: 0 });
  const [paymentBreakdown, setPaymentBreakdown] = useState<MonitorResponse['paymentBreakdown']>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null); const [updatedAt, setUpdatedAt] = useState<Date | null>(null);
  const [from, setFrom] = useState(dayOffset(29)); const [to, setTo] = useState(localDay(new Date()));
  const [paymentMethod, setPaymentMethod] = useState(''); const [query, setQuery] = useState(''); const [search, setSearch] = useState('');
  const [print, setPrint] = useState<CompanyMonitorPrint | null>(null);

  useEffect(() => {
    if (!hasMonitorSession()) { setChecking(false); return; }
    let live = true;
    getMonitorAccount().then((value) => { if (live) setAccount(value); }).catch((e: Error) => { clearMonitorSession(); if (live) setError(e.message); }).finally(() => { if (live) setChecking(false); });
    return () => { live = false; };
  }, []);

  const fetchPage = useCallback(async (cursor: string | null = null, append = false, quiet = false) => {
    if (!account) return;
    if (!quiet) setBusy(true);
    setError('');
    try {
      const data = await getMonitorSales({ from, to, paymentMethod, search, cursor });
      if (quiet) setTransactions((old) => {
        const merged = new Map(old.map((sale) => [sale.id, sale]));
        data.transactions.forEach((sale) => merged.set(sale.id, sale));
        return [...merged.values()].sort((a, b) => b.soldAt.localeCompare(a.soldAt));
      });
      else setTransactions((old) => append ? [...old, ...data.transactions] : data.transactions);
      setSummary(data.summary); setPaymentBreakdown(data.paymentBreakdown); setNextCursor(data.nextCursor); setUpdatedAt(new Date());
    } catch (e) { setError((e as Error).message); }
    finally { if (!quiet) setBusy(false); }
  }, [account, from, to, paymentMethod, search]);

  useEffect(() => { const timer = window.setTimeout(() => setSearch(query.trim()), 300); return () => window.clearTimeout(timer); }, [query]);
  useEffect(() => { if (account) { setTransactions([]); void fetchPage(); } }, [account, from, to, paymentMethod, search, fetchPage]);
  useEffect(() => { if (!account) return; const timer = window.setInterval(() => void fetchPage(null, false, true), 30_000); return () => window.clearInterval(timer); }, [account, fetchPage]);

  const signIn = async (event: FormEvent) => {
    event.preventDefault(); setLoginBusy(true); setError('');
    try { setAccount(await monitorLogin(email.trim(), password)); setPassword(''); }
    catch (e) { setError((e as Error).message); }
    finally { setLoginBusy(false); }
  };
  const signOut = async () => { await monitorLogout().catch(() => clearMonitorSession()); setAccount(null); setTransactions([]); };
  const printReport = async () => {
    setBusy(true); setError('');
    try {
      const rows: MonitorSale[] = []; let cursor: string | null = null; let pages = 0; let firstPage: MonitorResponse | null = null;
      do {
        const response = await getMonitorSales({ from, to, paymentMethod, search, cursor, limit: 100 });
        firstPage ??= response;
        rows.push(...response.transactions); cursor = response.nextCursor; pages += 1;
        if (cursor && pages % 45 === 0) await new Promise((resolve) => window.setTimeout(resolve, 1100));
      } while (cursor);
      setPrint({ kind: 'report', rows, summary: firstPage?.summary ?? summary, paymentBreakdown: firstPage?.paymentBreakdown ?? paymentBreakdown }); window.setTimeout(() => window.print(), 120);
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (checking) return <div className="flex min-h-full items-center justify-center gap-3 text-faint"><RefreshCw className="h-5 w-5 animate-spin" />Checking secure cloud session…</div>;
  if (!account) return <div className="mx-auto flex min-h-full max-w-5xl items-center justify-center py-8">
    <div className="grid w-full overflow-hidden rounded-xl border border-line bg-surface shadow-pop md:grid-cols-2">
      <div className="hidden bg-brand p-10 text-on-brand md:flex md:flex-col md:justify-center"><div className="mb-8 grid h-12 w-12 place-items-center rounded-xl bg-white/15"><Activity /></div><p className="text-xs font-bold tracking-[.18em] text-white/75">STOCKFLOW · COMPANY VIEW</p><h1 className="mt-3 font-display text-4xl font-bold leading-tight">Your shop,<br />in view.</h1><p className="mt-4 max-w-sm text-sm leading-6 text-white/80">Check company sales from anywhere. Sign in with the administrator cloud account.</p></div>
      <div className="p-6 sm:p-9"><div className="mb-5 flex items-center justify-between"><div className="flex items-center gap-2 font-display text-lg font-bold text-ink"><span className="grid h-9 w-9 place-items-center rounded-lg bg-brand text-white"><ShoppingBag size={18} /></span>Company monitor</div>{onBack && <button className="text-xs text-faint hover:text-ink" onClick={onBack}>Back</button>}</div>
        <p className="mb-6 text-sm leading-5 text-faint">Cloud administrator sign-in. This view is read-only and does not require restoring company data into this device.</p>
        <form className="space-y-4" onSubmit={signIn}><Field label="Administrator email"><Input autoFocus type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@example.com" /></Field><Field label="Password"><Input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>{error && <div role="alert" className="rounded border border-bad/30 bg-bad-soft p-3 text-xs text-bad-text">{error}</div>}<Button size="lg" className="w-full" loading={loginBusy} disabled={!email || !password} icon={<Cloud className="h-4 w-4" />}>Sign in securely</Button></form>
        <div className="mt-5 flex items-start gap-2 text-[11px] leading-5 text-faint"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" />Only the business administrator can view company-wide transactions.</div>
      </div>
    </div>
  </div>;

  return <div className="mx-auto max-w-7xl space-y-4 pb-8">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><div className="mb-1 flex items-center gap-2 text-[10px] font-bold tracking-[.15em] text-brand"><ShieldCheck size={13} /> PRIVATE BUSINESS VIEW</div><h1 className="font-display text-2xl font-bold text-ink sm:text-3xl">{account.name || 'Your company'}</h1><p className="mt-1 text-sm text-faint">Company transactions from StockFlow Cloud · {account.fullName}</p></div><div className="flex gap-2"><Button variant="secondary" size="sm" loading={busy} onClick={() => void fetchPage()} icon={<RefreshCw size={14} />}>Refresh</Button><Button variant="ghost" size="sm" onClick={() => void signOut()} icon={<LogOut size={14} />}>Sign out</Button></div></div>
    <div className="flex items-start gap-2 rounded-lg border border-brand/20 bg-brand-soft p-3 text-xs leading-5 text-brand"><Cloud className="mt-0.5 h-4 w-4 shrink-0" />This page shows sales that have reached StockFlow Cloud. The shop computer needs internet access and working cloud sync for new sales to appear.</div>
    {error && <div role="alert" className="rounded border border-bad/30 bg-bad-soft p-3 text-xs text-bad-text">{error}</div>}
    <div className="grid gap-3 sm:grid-cols-3"><Metric label="Sales recorded" value={summary.count.toLocaleString()} note={`${summary.cancelled} cancelled`} icon={<ShoppingBag />} /><Metric label="Completed sales" value={money(summary.completed)} note="Paid and credit sales" icon={<WalletCards />} /><Metric label="Estimated profit" value={money(summary.profit)} note="Completed sales less recorded cost" icon={<TrendingUp />} /></div>
    <Card title={<div><span className="text-sm">Sales transactions</span><span className="mt-1 block text-[11px] font-normal text-faint">Receipts, items, payment methods, cashiers and profit</span></div>} actions={<div className="flex flex-wrap items-center justify-end gap-2"><span className="hidden text-[10px] text-faint sm:inline-flex sm:items-center sm:gap-1"><Clock3 size={12} />{updatedAt ? `Updated ${dateTime(updatedAt)}` : 'Waiting for data'}</span><Button size="sm" variant="secondary" disabled={busy} onClick={() => void printReport()} icon={<ArrowDownToLine size={14} />}>Print / Save report</Button></div>} bodyClass="p-0">
      <div className="flex flex-wrap gap-2 border-b border-line p-3"><label className="flex h-9 items-center gap-2 rounded border border-line-strong px-2 text-[11px] text-faint"><CalendarDays size={14} />From<Input className="h-7 w-32 border-0 px-1" type="date" value={from} max={to || localDay(new Date())} onChange={(e) => setFrom(e.target.value)} /></label><label className="flex h-9 items-center gap-2 rounded border border-line-strong px-2 text-[11px] text-faint"><CalendarDays size={14} />To<Input className="h-7 w-32 border-0 px-1" type="date" value={to} min={from} max={localDay(new Date())} onChange={(e) => setTo(e.target.value)} /></label><select className="h-9 rounded border border-line-strong bg-surface px-2 text-xs text-body" value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}><option value="">All payment methods</option><option value="CASH">Cash</option><option value="MOBILE_MONEY">Mobile Money</option><option value="ORANGE_MONEY">Orange Money</option><option value="CARD">Card</option><option value="OTHER">Other</option></select><label className="flex h-9 min-w-[190px] flex-1 items-center gap-2 rounded border border-line-strong px-2 text-faint"><Search size={14} /><input className="w-full bg-transparent text-xs text-ink outline-none" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search receipts, cashiers or items" /></label><button className="px-2 text-[11px] font-semibold text-brand" onClick={() => { setFrom(''); setTo(''); }}>All dates</button></div>
      <div className="hidden overflow-x-auto md:block"><table className="tbl min-w-[850px]"><thead><tr><th>Receipt / date</th><th>Cashier / customer</th><th>Items</th><th>Payment</th><th>Status</th><th className="r">Total</th><th className="r">Profit</th></tr></thead><tbody>{transactions.map((sale) => <DesktopSale key={sale.id} sale={sale} onPrint={() => { setPrint({ kind: 'receipt', sale }); window.setTimeout(() => window.print(), 120); }} />)}{!busy && !transactions.length && <tr><td colSpan={7} className="p-8 text-center text-sm text-faint">No synced sales found for these filters.</td></tr>}</tbody></table></div>
      <div className="divide-y divide-line md:hidden">{transactions.map((sale) => <PhoneSale key={sale.id} sale={sale} onPrint={() => { setPrint({ kind: 'receipt', sale }); window.setTimeout(() => window.print(), 120); }} />)}{!busy && !transactions.length && <div className="p-8 text-center text-sm text-faint">No synced sales found for these filters.</div>}</div>
      <div className="flex items-center justify-between gap-2 p-3 text-[10px] text-faint"><span>{transactions.length} loaded · {updatedAt ? `Updated ${dateTime(updatedAt)}` : 'Not refreshed yet'}</span>{nextCursor && <Button size="sm" variant="secondary" disabled={busy} loading={busy} onClick={() => void fetchPage(nextCursor, true)}>Load more</Button>}</div>
    </Card>
    <Card title="Totals by payment method" bodyClass="p-3"><div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">{paymentBreakdown.map((item) => <div key={item.paymentMethod} className="rounded border border-line p-3"><div className="text-[11px] text-faint">{methodName(item.paymentMethod)} · {item.count} sale(s)</div><b className="mt-1 block text-base text-ink">{money(item.total)}</b></div>)}{!paymentBreakdown.length && <span className="text-xs text-faint">No completed sales for these filters.</span>}</div></Card>
    {print && <PrintPortal><PrintableMonitor print={print} accountName={account.name} summary={summary} paymentBreakdown={paymentBreakdown} from={from} to={to} onClose={() => setPrint(null)} /></PrintPortal>}
  </div>;
}

function Metric({ label, value, note, icon }: { label: string; value: string; note: string; icon: ReactNode }) {
  return <div className="rounded-lg border border-line bg-surface p-4 shadow-card"><div className="flex items-center gap-2 text-xs text-faint"><span className="grid h-8 w-8 place-items-center rounded bg-brand-soft text-brand">{icon}</span>{label}</div><b className="mt-3 block truncate font-display text-2xl font-bold text-ink">{value}</b><small className="text-[10px] text-faint">{note}</small></div>;
}

function DesktopSale({ sale, onPrint }: { sale: MonitorSale; onPrint: () => void }) {
  const [open, setOpen] = useState(false); const cancelled = sale.status === 'CANCELLED';
  return <><tr onClick={() => setOpen(!open)} className="cursor-pointer"><td><b className="text-brand">{sale.receiptNumber}</b><span className="block text-[10px] text-faint">{dateTime(sale.soldAt)}</span></td><td>{sale.cashier}<span className="block text-[10px] text-faint">{sale.customer || 'Walk-in customer'}</span></td><td>{sale.items.length} line(s)</td><td>{methodName(sale.paymentMethod)}</td><td><Status cancelled={cancelled} /></td><td className="r font-semibold">{money(sale.total)}</td><td className="r font-semibold text-ok-text">{cancelled ? '—' : money(sale.profit)}</td></tr>{open && <tr><td colSpan={7}><SaleItems sale={sale} onPrint={onPrint} /></td></tr>}</>;
}

function PhoneSale({ sale, onPrint }: { sale: MonitorSale; onPrint: () => void }) {
  const [open, setOpen] = useState(false); const cancelled = sale.status === 'CANCELLED';
  return <div><button className="block w-full p-3 text-left" onClick={() => setOpen(!open)}><span className="flex justify-between gap-2"><b className="text-sm text-brand">{sale.receiptNumber}</b><Status cancelled={cancelled} /></span><span className="mt-1 block text-[10px] text-faint">{dateTime(sale.soldAt)} · {sale.cashier}</span><span className="mt-2 flex justify-between gap-2 text-xs"><span>{methodName(sale.paymentMethod)} · {sale.items.length} line(s)</span><b className="text-ink">{money(sale.total)}</b></span></button>{open && <div className="bg-muted/40 px-3 pb-3"><div className="pb-2 text-[10px] text-faint">Customer: {sale.customer || 'Walk-in customer'}</div><SaleItems sale={sale} onPrint={onPrint} /></div>}</div>;
}

function SaleItems({ sale, onPrint }: { sale: MonitorSale; onPrint: () => void }) {
  return <div className="max-w-2xl rounded border border-line bg-surface p-3"><div className="mb-1 text-xs font-semibold text-ink">Receipt items</div>{sale.items.map((item, index) => <div key={`${sale.id}-${index}`} className="flex justify-between gap-3 border-t border-line py-2 text-xs"><span>{item.productName}<small className="block text-[10px] text-faint">{item.quantity} × {money(item.unitPrice)}</small></span><b className="text-ink">{money(item.lineTotal)}</b></div>)}<Button size="sm" variant="secondary" className="mt-2" onClick={onPrint}>Print / Save receipt</Button></div>;
}

function Status({ cancelled }: { cancelled: boolean }) { return <span className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-semibold ${cancelled ? 'bg-bad-soft text-bad-text' : 'bg-ok-soft text-ok-text'}`}>{cancelled ? 'Cancelled' : 'Completed'}</span>; }

function PrintableMonitor({ print, accountName, summary, paymentBreakdown, from, to, onClose }: { print: NonNullable<CompanyMonitorPrint>; accountName: string; summary: MonitorResponse['summary']; paymentBreakdown: MonitorResponse['paymentBreakdown']; from: string; to: string; onClose: () => void }) {
  const range = from || to ? `${from || 'Beginning'} to ${to || 'Today'}` : 'All dates';
  const reportSummary = print.kind === 'report' ? print.summary : summary;
  const reportPayment = print.kind === 'report' ? print.paymentBreakdown : paymentBreakdown;
  return <div className="sales-report-print"><div className="print-actions"><button onClick={() => window.print()}>Print / Save PDF</button><button onClick={onClose}>Close</button></div><h1>{accountName}</h1>{print.kind === 'receipt' ? <><p>Sales receipt</p><section><span>Receipt: <b>{print.sale.receiptNumber}</b></span><span>Date: <b>{dateTime(print.sale.soldAt)}</b></span><span>Cashier: <b>{print.sale.cashier}</b></span><span>Customer: <b>{print.sale.customer || 'Walk-in customer'}</b></span></section><table><thead><tr><th>Item</th><th>Qty</th><th>Unit price</th><th>Total</th></tr></thead><tbody>{print.sale.items.map((item, index) => <tr key={index}><td>{item.productName}</td><td>{item.quantity}</td><td>{money(item.unitPrice)}</td><td>{money(item.lineTotal)}</td></tr>)}</tbody></table><section><b>{methodName(print.sale.paymentMethod)} · {print.sale.status}</b><b>Total: {money(print.sale.total)}</b></section></> : <><p>Sales report · {range} · Generated {dateTime(new Date())}</p><section><span>Sales: <b>{reportSummary.count}</b></span><span>Completed total: <b>{money(reportSummary.completed)}</b></span><span>Estimated profit: <b>{money(reportSummary.profit)}</b></span><span>Cancelled: <b>{reportSummary.cancelled}</b></span></section><h2>Payment totals</h2><table><thead><tr><th>Method</th><th>Sales</th><th>Total</th></tr></thead><tbody>{reportPayment.map((item) => <tr key={item.paymentMethod}><td>{methodName(item.paymentMethod)}</td><td>{item.count}</td><td>{money(item.total)}</td></tr>)}</tbody></table><h2>Transactions ({print.rows.length})</h2><table><thead><tr><th>Receipt / date</th><th>Cashier</th><th>Payment</th><th>Status</th><th>Total</th><th>Profit</th></tr></thead><tbody>{print.rows.map((sale) => <tr key={sale.id}><td>{sale.receiptNumber}<small>{dateTime(sale.soldAt)}</small></td><td>{sale.cashier}</td><td>{methodName(sale.paymentMethod)}</td><td>{sale.status}</td><td>{money(sale.total)}</td><td>{sale.status === 'CANCELLED' ? '—' : money(sale.profit)}</td></tr>)}</tbody></table></>}</div>;
}

type CompanyMonitorPrint = { kind: 'receipt'; sale: MonitorSale } | { kind: 'report'; rows: MonitorSale[]; summary: MonitorResponse['summary']; paymentBreakdown: MonitorResponse['paymentBreakdown'] };
