import { ArrowLeft, CheckCircle2, ClipboardCheck, EyeOff, Plus, Printer, Trash2, TrendingDown, XCircle } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { PrintPortal } from '../components/PrintPortal';
import { Badge, Button, ConfirmDialog, Empty, Field, Input, Modal, PageHeader, PageLoader, SearchInput, Select, Tabs, cn, useAction } from '../components/ui';
import { formatDate, formatMoney, formatQty } from '../lib/format';
import { listCategories } from '../services/categories';
import { findByBarcodeOrSku } from '../services/products';
import {
  SHORTAGE_REASONS, SURPLUS_REASONS, applyCount, cancelCount, clearCountLine, countReview, countSheet, getCount, listCounts, lossReport, saveCountLine, setLineReason, startCount,
  type CountListRow, type SheetRow,
} from '../services/stockcount';
import { useApp, useCtx } from '../state/app';
import { useDebounced, useLive } from '../state/hooks';

const PAGE = 100;
const statusTone = (s: string) => (s === 'APPLIED' ? 'ok' : s === 'CANCELLED' ? 'neutral' : 'warn');

export function StockCount() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<'counts' | 'losses'>('counts');
  const [openId, setOpenId] = useState<string | null>(null);
  if (openId) return <CountDetail id={openId} onBack={() => setOpenId(null)} />;
  return (
    <div>
      <PageHeader title={t('nav.counts')} subtitle={t('counts.subtitle')} actions={tab === 'counts' ? <NewCountButton onCreated={setOpenId} /> : undefined} />
      <Tabs tabs={[{ id: 'counts', label: t('counts.tabCounts') }, { id: 'losses', label: t('counts.tabLosses') }]} value={tab} onChange={setTab} />
      <div className="pt-4">{tab === 'counts' ? <CountList onOpen={setOpenId} /> : <Losses />}</div>
    </div>
  );
}

// ------------------------------------------------------------------ list + start
function NewCountButton({ onCreated }: { onCreated: (id: string) => void }) {
  const { t } = useTranslation(); const ctx = useCtx(); const { toast } = useApp();
  const [open, setOpen] = useState(false);
  const { data: cats } = useLive((c) => listCategories(c));
  const [name, setName] = useState(''); const [cat, setCat] = useState(''); const [blind, setBlind] = useState(true);
  const start = useAction(async () => {
    const c = await startCount(ctx, { name, category_id: cat || null, blind });
    toast('success', t('counts.started', { ref: c.reference })); setOpen(false); setName(''); setCat(''); onCreated(c.id);
  });
  return (
    <>
      <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>{t('counts.new')}</Button>
      <Modal open={open} title={t('counts.new')} onClose={() => setOpen(false)}
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>{t('common.cancel')}</Button><Button loading={start.busy} onClick={() => start.run()}>{t('counts.start')}</Button></>}>
        <div className="space-y-3">
          <Field label={t('counts.name')} hint={t('counts.nameHint')}><Input autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={60} /></Field>
          <Field label={t('counts.scope')} hint={t('counts.scopeHint')}>
            <Select value={cat} onChange={(e) => setCat(e.target.value)}><option value="">{t('counts.allProducts')}</option>{(cats ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</Select></Field>
          <label className="flex items-start gap-2 text-[13px]"><input type="checkbox" className="mt-0.5" checked={blind} onChange={(e) => setBlind(e.target.checked)} />
            <span><b>{t('counts.blind')}</b><span className="block text-[12px] text-faint">{t('counts.blindHint')}</span></span></label>
        </div>
      </Modal>
    </>
  );
}

function CountList({ onOpen }: { onOpen: (id: string) => void }) {
  const { t } = useTranslation(); const { lang } = useApp();
  const { data } = useLive((c) => listCounts(c));
  return (
    <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
      {!data ? <PageLoader /> : data.length === 0 ? <Empty icon={<ClipboardCheck className="h-8 w-8" />} title={t('counts.empty')} hint={t('counts.emptyHint')} /> : (
        <table className="tbl"><thead><tr><th>{t('counts.reference')}</th><th>{t('common.date')}</th><th>{t('counts.scope')}</th><th>{t('common.status')}</th><th className="r">{t('counts.counted')}</th><th className="r">{t('counts.differences')}</th><th className="r">{t('counts.shortage')}</th></tr></thead>
          <tbody>{data.map((c) => (
            <tr key={c.id} className="cursor-pointer" onClick={() => onOpen(c.id)}>
              <td className="font-mono text-[12px] font-semibold text-ink">{c.reference}{c.name && <span className="ml-2 font-sans font-normal text-faint">{c.name}</span>}</td>
              <td className="text-faint">{formatDate(c.applied_at ?? c.started_at, lang, true)}</td>
              <td>{c.category_name ?? t('counts.allProducts')}</td>
              <td><Badge tone={statusTone(c.status)}>{t(`counts.status.${c.status}`)}</Badge></td>
              <td className="r">{c.status === 'APPLIED' ? c.items_counted : c.lines}</td>
              <td className="r">{c.status === 'APPLIED' ? c.items_different : '—'}</td>
              <td className="r">{c.status === 'APPLIED' && c.shortage_value > 0 ? <span className="font-semibold text-bad-text">{formatMoney(c.shortage_value, lang)}</span> : <span className="text-faint">—</span>}</td>
            </tr>))}</tbody></table>)}
    </div>
  );
}

// ------------------------------------------------------------------ one count
function CountDetail({ id, onBack }: { id: string; onBack: () => void }) {
  const { t } = useTranslation(); const ctx = useCtx(); const { toast } = useApp();
  const { data: count } = useLive((c) => getCount(c, id), [id]);
  const [review, setReview] = useState(false); const [cancel, setCancel] = useState(false);
  const doCancel = useAction(async () => { await cancelCount(ctx, id); toast('success', t('counts.cancelled')); setCancel(false); });
  if (!count) return <PageLoader />;
  const open = count.status === 'OPEN';
  return (
    <div>
      <button onClick={onBack} className="mb-2 inline-flex items-center gap-1 text-[12px] text-faint hover:text-ink"><ArrowLeft className="h-3.5 w-3.5" />{t('counts.back')}</button>
      <PageHeader
        title={count.reference}
        subtitle={<span className="inline-flex items-center gap-2"><Badge tone={statusTone(count.status)}>{t(`counts.status.${count.status}`)}</Badge>{`${count.name ? `${count.name} · ` : ''}${count.category_name ?? t('counts.allProducts')} · ${count.user_name ?? ''}`}</span>}
        actions={open ? <>
          <Button variant="secondary" icon={<XCircle className="h-4 w-4" />} onClick={() => setCancel(true)}>{t('counts.cancelCount')}</Button>
          <Button icon={<CheckCircle2 className="h-4 w-4" />} disabled={count.lines === 0} onClick={() => setReview(true)}>{t('counts.reviewApply')}</Button></> : undefined} />
      {open ? <Sheet count={count} /> : <Report id={id} />}
      {review && <ReviewModal id={id} onClose={() => setReview(false)} />}
      <ConfirmDialog open={cancel} danger title={t('counts.cancelCount')} message={t('counts.cancelMsg')} busy={doCancel.busy} onConfirm={() => doCancel.run()} onCancel={() => setCancel(false)} confirmLabel={t('counts.cancelCount')} />
    </div>
  );
}

function Sheet({ count }: { count: CountListRow & { scope_total: number } }) {
  const { t } = useTranslation(); const ctx = useCtx(); const { lang, toast } = useApp();
  const [q, setQ] = useState(''); const dq = useDebounced(q, 150);
  const [filter, setFilter] = useState<'todo' | 'counted' | 'all'>('todo');
  const [limit, setLimit] = useState(PAGE);
  const searchRef = useRef<HTMLInputElement>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  /** Product just found by a barcode scan: its quantity box gets the focus as soon as it is on screen, and the search box is cleared after saving. */
  const scanTarget = useRef<string | null>(null);
  useEffect(() => setLimit(PAGE), [dq, filter]);
  const { data } = useLive((c) => countSheet(c, count.id, { search: dq, filter, limit }), [count.id, dq, filter, limit]);
  const blind = !!count.blind;
  const pct = count.scope_total ? Math.round(((data?.counted ?? count.lines) / count.scope_total) * 100) : 0;

  const focusRow = (productId: string) => { const el = inputs.current.get(productId); if (el) { el.focus(); el.select(); el.scrollIntoView({ block: 'center' }); } };
  /** Enter in the search box: an exact barcode / SKU jumps straight to that product's quantity box (USB scanners type the code + Enter). */
  const onEnter = async () => {
    const code = q.trim(); if (!code) return;
    const hit = await findByBarcodeOrSku(ctx, code);
    if (hit) {
      if (count.category_id && hit.category_id !== count.category_id) return toast('error', t('errors.countOutOfScope', { product: hit.name }));
      scanTarget.current = hit.id; setFilter('all');
      if (inputs.current.has(hit.id)) focusRow(hit.id);   // already visible (the effect above handles the case where the list has to reload first)
      return;
    }
    if (data?.rows.length === 1) focusRow(data.rows[0].product_id);
    else toast('error', t('pos.notFound', { code }));
  };
  const rows = data?.rows ?? [];
  useEffect(() => { if (scanTarget.current && inputs.current.has(scanTarget.current)) focusRow(scanTarget.current); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const nextAfter = (productId: string) => { const i = rows.findIndex((r) => r.product_id === productId); return rows[i + 1]?.product_id; };

  return (
    <>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <div className="w-80"><SearchInput inputRef={searchRef} value={q} onChange={setQ} onEnter={onEnter} placeholder={t('counts.searchPlaceholder')} autoFocus /></div>
        <Tabs tabs={[{ id: 'todo', label: t('counts.filterTodo') }, { id: 'counted', label: t('counts.filterCounted') }, { id: 'all', label: t('common.all') }]} value={filter} onChange={setFilter} />
        <div className="ml-auto flex items-center gap-3 text-[12px] text-faint">
          {blind && <span className="inline-flex items-center gap-1"><EyeOff className="h-3.5 w-3.5" />{t('counts.blindOn')}</span>}
          <div className="w-48"><div className="mb-0.5 flex justify-between"><span>{t('counts.progress', { done: data?.counted ?? count.lines, total: count.scope_total })}</span><span>{pct}%</span></div>
            <div className="h-1.5 overflow-hidden rounded bg-muted"><div className="h-full bg-brand transition-all" style={{ width: `${Math.min(100, pct)}%` }} /></div></div>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        {!data ? <PageLoader /> : rows.length === 0 ? <Empty title={filter === 'todo' && !dq ? t('counts.allCounted') : t('pos.noResults')} /> : (
          <div className="max-h-[calc(100vh-290px)] overflow-auto">
            <table className="tbl"><thead><tr><th>{t('products.fields.name')}</th><th>{t('products.fields.unit')}</th>{!blind && <th className="r">{t('counts.system')}</th>}<th className="w-40 r">{t('counts.countedQty')}</th><th className="r w-32">{t('counts.difference')}</th><th className="w-10" /></tr></thead>
              <tbody>{rows.map((r) => (
                <CountRow key={r.product_id} row={r} blind={blind} lang={lang} register={(el) => { if (el) inputs.current.set(r.product_id, el); else inputs.current.delete(r.product_id); }}
                  onSave={async (qty) => {
                    await saveCountLine(ctx, count.id, r.product_id, qty);
                    if (scanTarget.current === r.product_id) { scanTarget.current = null; setQ(''); searchRef.current?.focus(); return; }   // scanned: ready for the next scan
                    const nx = nextAfter(r.product_id); if (nx) setTimeout(() => focusRow(nx), 60); else searchRef.current?.focus();
                  }}
                  onClear={() => clearCountLine(ctx, count.id, r.product_id)} />))}</tbody></table>
            {data.total > rows.length && <div className="border-t border-line p-3 text-center"><Button variant="secondary" size="sm" onClick={() => setLimit(limit + PAGE)}>{t('counts.showMore', { count: data.total - rows.length })}</Button></div>}
          </div>)}
      </div>
    </>
  );
}

function CountRow({ row, blind, lang, register, onSave, onClear }: {
  row: SheetRow; blind: boolean; lang: 'fr' | 'en'; register: (el: HTMLInputElement | null) => void; onSave: (qty: number) => Promise<unknown>; onClear: () => Promise<unknown>;
}) {
  const { t } = useTranslation(); const fail = useApp((s) => s.fail);
  const saved = row.counted_qty;
  const [v, setV] = useState(saved == null ? '' : String(saved));
  /** What was last sent: Enter saves and moves on, and the blur that follows must not save the same number a second time. */
  const last = useRef<number | null>(saved);
  useEffect(() => { last.current = saved; setV(saved == null ? '' : String(saved)); }, [saved]);
  const commit = async () => {
    const txt = v.trim().replace(',', '.');
    const back = last.current;
    try {
      if (txt === '') { if (back != null) { last.current = null; await onClear(); } return; }
      const n = Number(txt);
      if (!Number.isFinite(n) || n < 0) { setV(back == null ? '' : String(back)); return; }
      if (n === back) return;
      last.current = n;
      await onSave(n);
    } catch (e) { last.current = back; fail(e); setV(back == null ? '' : String(back)); }
  };
  const diff = row.difference;
  return (
    <tr className={cn(saved != null && 'bg-brand-soft/30')}>
      <td className="font-medium text-ink">{row.name}{row.barcode && <span className="ml-2 font-mono text-[11px] text-faint">{row.barcode}</span>}</td>
      <td className="text-faint">{row.unit}</td>
      {!blind && <td className="r">{formatQty(row.system_qty, lang)}</td>}
      <td className="r"><input ref={register} inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void commit(); } }} aria-label={`${t('counts.countedQty')} ${row.name}`}
        className="num h-8 w-28 rounded border border-line-strong bg-surface px-2 text-right text-[14px] font-semibold focus-ring" /></td>
      <td className="r">{diff == null ? '' : blind ? <span className="text-faint">✓</span> : diff === 0 ? <span className="text-ok-text">✓</span> : <span className={cn('font-bold', diff < 0 ? 'text-bad-text' : 'text-warn-text')}>{diff > 0 ? '+' : ''}{formatQty(diff, lang)}</span>}</td>
      <td>{saved != null && <button title={t('counts.removeLine')} className="rounded p-1 text-faint hover:bg-muted hover:text-bad" onClick={() => { void onClear(); }}><Trash2 className="h-3.5 w-3.5" /></button>}</td>
    </tr>
  );
}

// ------------------------------------------------------------------ review & apply
function ReviewModal({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation(); const ctx = useCtx(); const { lang, toast } = useApp();
  const { data } = useLive((c) => countReview(c, id), [id]);
  const [confirm, setConfirm] = useState(false);
  const m = (n: number) => formatMoney(n, lang);
  const apply = useAction(async () => { const s = await applyCount(ctx, id); toast('success', t('counts.applied', { count: s.different })); setConfirm(false); onClose(); });
  const diffs = (data?.lines ?? []).filter((l) => l.difference !== 0);
  const moved = diffs.filter((l) => l.moved).length;
  return (
    <Modal open wide="xl" title={t('counts.reviewTitle')} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>{t('counts.keepCounting')}</Button>
        <Button icon={<CheckCircle2 className="h-4 w-4" />} disabled={!data || data.lines.length === 0} onClick={() => setConfirm(true)}>{diffs.length ? t('counts.applyN', { count: diffs.length }) : t('counts.finish')}</Button></>}>
      {!data ? <PageLoader /> : (
        <div className="space-y-4">
          <Summary s={data.summary} m={m} />
          {data.not_counted > 0 && <div className="rounded border border-warn/40 bg-warn-soft p-3 text-[13px] text-warn-text">{t('counts.notCountedWarn', { count: data.not_counted })}</div>}
          {moved > 0 && <div className="rounded border border-line bg-muted/40 p-3 text-[12px] text-faint">{t('counts.movedNote', { count: moved })}</div>}
          {diffs.length === 0 ? <Empty title={t('counts.noDifference')} hint={t('counts.noDifferenceHint')} /> : (
            <table className="tbl"><thead><tr><th>{t('products.fields.name')}</th><th className="r">{t('counts.expected')}</th><th className="r">{t('counts.countedQty')}</th><th className="r">{t('counts.difference')}</th><th className="r">{t('counts.value')}</th><th className="w-52">{t('counts.reason')}</th></tr></thead>
              <tbody>{diffs.map((l) => (
                <tr key={l.id}><td className="font-medium text-ink">{l.product_name}</td><td className="r text-faint">{formatQty(l.expected_qty, lang)}</td><td className="r">{formatQty(l.counted_qty, lang)}</td>
                  <td className={cn('r font-bold', l.difference < 0 ? 'text-bad-text' : 'text-warn-text')}>{l.difference > 0 ? '+' : ''}{formatQty(l.difference, lang)}</td>
                  <td className={cn('r', l.value < 0 ? 'text-bad-text' : 'text-warn-text')}>{m(l.value)}</td>
                  <td><ReasonSelect itemId={l.id} difference={l.difference} value={l.reason_code} /></td></tr>))}</tbody></table>)}
        </div>)}
      <ConfirmDialog open={confirm} title={t('counts.applyTitle')} message={t('counts.applyMsg', { count: diffs.length })} busy={apply.busy} onConfirm={() => apply.run()} onCancel={() => setConfirm(false)} confirmLabel={t('counts.applyConfirm')} />
    </Modal>
  );
}

function ReasonSelect({ itemId, difference, value }: { itemId: string; difference: number; value: string | null }) {
  const { t } = useTranslation(); const ctx = useCtx(); const fail = useApp((s) => s.fail);
  const list = difference < 0 ? SHORTAGE_REASONS : SURPLUS_REASONS;
  return <Select value={value ?? list[0]} onChange={(e) => setLineReason(ctx, itemId, e.target.value).catch(fail)}>{list.map((r) => <option key={r} value={r}>{t(`counts.reasons.${r}`)}</option>)}</Select>;
}

function Summary({ s, m }: { s: { counted: number; matching: number; different: number; shortage_value: number; surplus_value: number; net_value: number }; m: (n: number) => string }) {
  const { t } = useTranslation();
  const cards: [string, string, string?][] = [
    [t('counts.counted'), String(s.counted)], [t('counts.matching'), String(s.matching)], [t('counts.differences'), String(s.different)],
    [t('counts.shortage'), m(s.shortage_value), s.shortage_value > 0 ? 'text-bad-text' : undefined], [t('counts.surplus'), m(s.surplus_value), s.surplus_value > 0 ? 'text-warn-text' : undefined],
    [t('counts.net'), m(s.net_value), s.net_value < 0 ? 'text-bad-text' : undefined],
  ];
  return <div className="grid grid-cols-6 gap-2">{cards.map(([k, v, tone]) => <div key={k} className="rounded border border-line bg-muted/40 p-2.5"><div className="text-[10px] uppercase tracking-wide text-faint">{k}</div><div className={cn('num font-display text-[16px] font-bold text-ink', tone)}>{v}</div></div>)}</div>;
}

// ------------------------------------------------------------------ report of a finished count (+ print)
function Report({ id }: { id: string }) {
  const { t } = useTranslation(); const { lang, settings } = useApp();
  const { data } = useLive((c) => countReview(c, id), [id]);
  const m = (n: number) => formatMoney(n, lang);
  if (!data) return <PageLoader />;
  const { count, lines, summary } = data;
  const shown = lines.filter((l) => l.difference !== 0);
  const th = { textAlign: 'left' as const, borderBottom: '1px solid #000', padding: '3px 4px' }; const td = { padding: '3px 4px', borderBottom: '1px solid #ddd' };
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-[13px] text-faint">{count.status === 'APPLIED' ? t('counts.appliedOn', { date: formatDate(count.applied_at, lang, true) }) : t('counts.cancelledInfo')}</p>
        <Button variant="secondary" icon={<Printer className="h-4 w-4" />} onClick={() => window.print()}>{t('counts.printReport')}</Button>
      </div>
      <Summary s={summary} m={m} />
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        {shown.length === 0 ? <Empty title={t('counts.noDifference')} /> : (
          <table className="tbl"><thead><tr><th>{t('products.fields.name')}</th><th className="r">{t('counts.expected')}</th><th className="r">{t('counts.countedQty')}</th><th className="r">{t('counts.difference')}</th><th className="r">{t('counts.value')}</th><th>{t('counts.reason')}</th></tr></thead>
            <tbody>{shown.map((l) => (<tr key={l.id}><td className="font-medium text-ink">{l.product_name}</td><td className="r text-faint">{formatQty(l.expected_qty, lang)}</td><td className="r">{formatQty(l.counted_qty, lang)}</td>
              <td className={cn('r font-bold', l.difference < 0 ? 'text-bad-text' : 'text-warn-text')}>{l.difference > 0 ? '+' : ''}{formatQty(l.difference, lang)}</td><td className="r">{m(l.value)}</td><td>{l.reason_code ? t(`counts.reasons.${l.reason_code}`) : ''}</td></tr>))}</tbody></table>)}
      </div>
      <PrintPortal>
        <div className="doc-root" style={{ fontFamily: 'Inter, Arial, sans-serif', fontSize: 11, color: '#000' }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>{settings.business_name} — {settings.branch_name}</div>
          <div style={{ fontSize: 14, fontWeight: 700, margin: '6px 0' }}>{t('counts.reportTitle')} · {count.reference}</div>
          <div style={{ marginBottom: 8 }}>{formatDate(count.applied_at ?? count.started_at, lang, true)} · {count.user_name}</div>
          <div style={{ marginBottom: 8 }}>{t('counts.counted')}: <b>{summary.counted}</b> · {t('counts.differences')}: <b>{summary.different}</b> · {t('counts.shortage')}: <b>{m(summary.shortage_value)}</b> · {t('counts.surplus')}: <b>{m(summary.surplus_value)}</b> · {t('counts.net')}: <b>{m(summary.net_value)}</b></div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}><thead><tr><th style={th}>{t('products.fields.name')}</th><th style={th}>{t('counts.expected')}</th><th style={th}>{t('counts.countedQty')}</th><th style={th}>{t('counts.difference')}</th><th style={th}>{t('counts.value')}</th><th style={th}>{t('counts.reason')}</th></tr></thead>
            <tbody>{shown.map((l) => (<tr key={l.id}><td style={td}>{l.product_name}</td><td style={td}>{formatQty(l.expected_qty, lang)}</td><td style={td}>{formatQty(l.counted_qty, lang)}</td><td style={td}>{l.difference > 0 ? '+' : ''}{formatQty(l.difference, lang)}</td><td style={td}>{m(l.value)}</td><td style={td}>{l.reason_code ? t(`counts.reasons.${l.reason_code}`) : ''}</td></tr>))}</tbody></table>
        </div>
      </PrintPortal>
    </div>
  );
}

// ------------------------------------------------------------------ where is stock disappearing?
function Losses() {
  const { t } = useTranslation(); const { lang } = useApp();
  const [days, setDays] = useState('90');
  const range = useMemo(() => { const to = new Date(); to.setDate(to.getDate() + 1); const from = new Date(); from.setDate(from.getDate() - Number(days)); return { from: from.toISOString(), to: to.toISOString() }; }, [days]);
  const { data } = useLive((c) => lossReport(c, range), [range.from]);
  const m = (n: number) => formatMoney(n, lang);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between"><p className="max-w-xl text-[13px] text-faint">{t('counts.lossesHint')}</p>
        <div className="w-48"><Select value={days} onChange={(e) => setDays(e.target.value)}>{['30', '90', '180', '365'].map((d) => <option key={d} value={d}>{t('counts.lastDays', { count: Number(d) })}</option>)}</Select></div></div>
      {!data ? <PageLoader /> : data.totals.counts === 0 ? <div className="rounded-lg border border-line bg-surface shadow-card"><Empty icon={<TrendingDown className="h-8 w-8" />} title={t('counts.noLossData')} hint={t('counts.noLossDataHint')} /></div> : (
        <>
          <div className="grid grid-cols-4 gap-3">{([[t('counts.countsDone'), String(data.totals.counts), ''], [t('counts.shortage'), m(data.totals.shortage_value), 'text-bad-text'], [t('counts.surplus'), m(data.totals.surplus_value), 'text-warn-text'], [t('counts.net'), m(data.totals.net_value), data.totals.net_value < 0 ? 'text-bad-text' : '']] as const).map(([k, v, c]) =>
            <div key={k} className="rounded-lg border border-line bg-surface p-3 shadow-card"><div className="text-[11px] uppercase text-faint">{k}</div><div className={cn('num font-display text-[20px] font-bold text-ink', c)}>{v}</div></div>)}</div>
          <div className="grid grid-cols-[1fr_300px] gap-4">
            <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
              <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink">{t('counts.topLosses')}</div>
              <table className="tbl"><thead><tr><th>{t('products.fields.name')}</th><th className="r">{t('counts.timesShort')}</th><th className="r">{t('counts.missingQty')}</th><th className="r">{t('counts.valueLost')}</th><th>{t('counts.lastShort')}</th></tr></thead>
                <tbody>{data.rows.map((r) => (<tr key={r.product_id}><td className="font-medium text-ink">{r.product_name}</td><td className="r">{r.times_short} / {r.times_counted}</td><td className="r">{formatQty(r.missing_qty, lang)} {r.unit}</td><td className="r font-semibold text-bad-text">{m(r.value)}</td><td className="text-faint">{formatDate(r.last_at, lang)}</td></tr>))}</tbody></table>
            </div>
            <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card self-start">
              <div className="border-b border-line px-4 py-2.5 text-[13px] font-semibold text-ink">{t('counts.byReason')}</div>
              <ul className="divide-y divide-line/60">{data.by_reason.map((r) => <li key={r.reason} className="flex items-center justify-between px-4 py-2 text-[13px]"><span>{t(`counts.reasons.${r.reason}`)} <span className="text-faint">· {r.lines}</span></span><b className="num text-bad-text">{m(r.value)}</b></li>)}</ul>
            </div>
          </div>
        </>)}
    </div>
  );
}
