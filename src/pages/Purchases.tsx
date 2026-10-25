import { Eye, Pencil, Plus, Trash2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { ProductPick } from '../components/ProductPick';
import { Badge, Button, ConfirmDialog, Empty, Field, Input, Modal, PageHeader, PageLoader, Select, Tabs, Textarea, useAction } from '../components/ui';
import { formatDate, formatMoney, formatQty } from '../lib/format';
import { createCustomer, createSupplier, deleteSupplier, listSuppliers, recordSupplierPayment, supplierHistory, updateCustomer, updateSupplier, type SupplierRow } from '../services/parties';
import { createPurchase, getPurchase, listPurchases } from '../services/purchases';
import { getPaymentMethods } from '../services/settings';
import { useApp, useCan, useCtx } from '../state/app';
import { useLive } from '../state/hooks';

type Tab = 'purchases' | 'suppliers';
export function Purchases() {
  const { t } = useTranslation();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const tab = (params.get('tab') as Tab) || (can('purchases.read') ? 'purchases' : 'suppliers');
  const tabs = [...(can('purchases.read') ? [{ id: 'purchases' as Tab, label: t('purchases.tabPurchases') }] : []), ...(can('suppliers.read') ? [{ id: 'suppliers' as Tab, label: t('purchases.tabSuppliers') }] : [])];
  return (
    <div>
      <PageHeader title={t('nav.purchases')} subtitle={t('purchases.subtitle')} />
      <Tabs tabs={tabs} value={tab} onChange={(x) => setParams({ tab: x })} />
      <div className="pt-4">{tab === 'purchases' ? <PurchaseList /> : <SupplierList />}</div>
    </div>
  );
}

function PurchaseList() {
  const { t } = useTranslation(); const can = useCan(); const { lang } = useApp();
  const { data } = useLive((c) => listPurchases(c));
  const [open, setOpen] = useState(false); const [view, setView] = useState<string | null>(null);
  const m = (n: number) => formatMoney(n, lang);
  return (
    <>
      <div className="mb-3 flex justify-end">{can('purchases.create') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>{t('purchases.new')}</Button>}</div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        {!data ? <PageLoader /> : data.length === 0 ? <Empty title={t('purchases.empty')} hint={t('purchases.emptyHint')} /> : (
          <table className="tbl"><thead><tr><th>{t('purchases.reference')}</th><th>{t('common.date')}</th><th>{t('purchases.supplier')}</th><th className="r">{t('purchases.lines')}</th><th className="r">{t('common.total')}</th><th className="r">{t('purchases.outstanding')}</th><th /></tr></thead>
            <tbody>{data.map((p) => (<tr key={p.id}><td className="font-mono text-[12px]">{p.reference}</td><td>{formatDate(p.purchased_at, lang)}</td><td>{p.supplier_name ?? '—'}</td><td className="r">{p.item_count}</td><td className="r font-semibold">{m(p.total)}</td>
              <td className="r">{p.total > p.amount_paid ? <Badge tone="warn">{m(p.total - p.amount_paid)}</Badge> : <Badge tone="ok">{t('purchases.paid')}</Badge>}</td>
              <td className="text-right"><button className="rounded p-1.5 text-faint hover:bg-muted hover:text-brand" onClick={() => setView(p.id)}><Eye className="h-3.5 w-3.5" /></button></td></tr>))}</tbody></table>)}
      </div>
      {open && <PurchaseForm onClose={() => setOpen(false)} />}
      {view && <PurchaseView id={view} onClose={() => setView(null)} />}
    </>
  );
}

interface Line { id: string; name: string; unit: string; qty: string; cost: string; expiry: string; lot: string }
function PurchaseForm({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation(); const ctx = useCtx(); const { lang, toast } = useApp();
  const { data: sups } = useLive((c) => listSuppliers(c));
  const [supplier, setSupplier] = useState(''); const [ref, setRef] = useState(''); const [notes, setNotes] = useState('');
  const [lines, setLines] = useState<Line[]>([]); const [paid, setPaid] = useState('');
  const total = lines.reduce((s, l) => s + Math.round((Number(l.qty) || 0) * (Number(l.cost) || 0)), 0);
  const upd = (i: number, k: keyof Line, v: string) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, [k]: v } : l)));
  const save = useAction(async () => {
    await createPurchase(ctx, { supplier_id: supplier || null, reference: ref, notes, amount_paid: paid === '' ? total : Number(paid),
      lines: lines.map((l) => ({ product_id: l.id, quantity: Number(l.qty), cost_price: Number(l.cost), expiry_date: l.expiry || null, lot_code: l.lot || null })) });
    toast('success', t('purchases.saved')); onClose();
  });
  return (
    <Modal open wide="xl" title={t('purchases.new')} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.busy} disabled={!lines.length || lines.some((l) => !(Number(l.qty) > 0))} onClick={() => save.run()}>{t('purchases.confirm')} · {formatMoney(total, lang)}</Button></>}>
      <div className="grid grid-cols-3 gap-3">
        <Field label={t('purchases.supplier')}><Select value={supplier} onChange={(e) => setSupplier(e.target.value)}><option value="">—</option>{(sups ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</Select></Field>
        <Field label={t('purchases.reference')} hint={t('purchases.refHint')}><Input value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
        <Field label={t('purchases.addProduct')}><ProductPick onPick={(p) => setLines((ls) => ls.some((l) => l.id === p.id) ? ls : [...ls, { id: p.id, name: p.name, unit: p.unit, qty: '1', cost: String(p.cost_price), expiry: '', lot: '' }])} /></Field>
      </div>
      <table className="tbl mt-4"><thead><tr><th>{t('products.fields.name')}</th><th className="w-24">{t('products.fields.quantity')}</th><th className="w-28">{t('purchases.unitCost')}</th><th className="w-36">{t('products.fields.expiry')}</th><th className="w-28">{t('purchases.lot')}</th><th className="r w-28">{t('common.total')}</th><th className="w-8" /></tr></thead>
        <tbody>{lines.map((l, i) => (<tr key={l.id}><td className="font-medium">{l.name} <span className="text-faint">({l.unit})</span></td>
          <td><Input type="number" min={0} step="any" value={l.qty} onChange={(e) => upd(i, 'qty', e.target.value)} /></td><td><Input type="number" min={0} value={l.cost} onChange={(e) => upd(i, 'cost', e.target.value)} /></td>
          <td><Input type="date" value={l.expiry} onChange={(e) => upd(i, 'expiry', e.target.value)} /></td><td><Input value={l.lot} onChange={(e) => upd(i, 'lot', e.target.value)} /></td>
          <td className="r font-semibold">{formatMoney(Math.round((Number(l.qty) || 0) * (Number(l.cost) || 0)), lang, false)}</td>
          <td><button className="text-faint hover:text-bad" onClick={() => setLines(lines.filter((_, j) => j !== i))}><Trash2 className="h-3.5 w-3.5" /></button></td></tr>))}
          {!lines.length && <tr><td colSpan={7} className="py-8 text-center text-faint">{t('purchases.noLines')}</td></tr>}</tbody></table>
      <div className="mt-4 grid grid-cols-2 gap-3">
        <Field label={t('common.notes')}><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        <Field label={t('purchases.amountPaid')} hint={t('purchases.amountPaidHint')}><Input type="number" min={0} value={paid} onChange={(e) => setPaid(e.target.value)} placeholder={String(total)} /></Field>
      </div>
    </Modal>
  );
}

function PurchaseView({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useTranslation(); const { lang } = useApp();
  const { data } = useLive((c) => getPurchase(c, id));
  return (
    <Modal open wide title={data?.purchase.reference ?? '…'} onClose={onClose}>
      {data && <><div className="mb-3 text-[13px] text-faint">{data.supplier?.name ?? '—'} · {formatDate(data.purchase.purchased_at, lang, true)} · {data.purchase.user_name}</div>
        <table className="tbl"><thead><tr><th>{t('products.fields.name')}</th><th className="r">{t('products.fields.quantity')}</th><th className="r">{t('purchases.unitCost')}</th><th>{t('products.fields.expiry')}</th><th className="r">{t('common.total')}</th></tr></thead>
          <tbody>{data.items.map((i) => <tr key={i.id}><td>{i.product_name}</td><td className="r">{formatQty(i.quantity, lang)}</td><td className="r">{formatMoney(i.cost_price, lang, false)}</td><td>{i.expiry_date ?? '—'}</td><td className="r font-semibold">{formatMoney(i.line_total, lang)}</td></tr>)}</tbody></table>
        {data.purchase.notes && <p className="mt-3 text-[12px] text-faint">{data.purchase.notes}</p>}</>}
    </Modal>
  );
}

function SupplierList() {
  const { t } = useTranslation(); const can = useCan(); const ctx = useCtx(); const { lang, toast } = useApp();
  const m = (n: number) => formatMoney(n, lang);
  const { data } = useLive((c) => listSuppliers(c));
  const [edit, setEdit] = useState<SupplierRow | 'new' | null>(null); const [hist, setHist] = useState<SupplierRow | null>(null);
  const [pay, setPay] = useState<SupplierRow | null>(null); const [del, setDel] = useState<SupplierRow | null>(null);
  const rm = useAction(async () => { await deleteSupplier(ctx, del!.id); toast('success', t('common.deleted')); setDel(null); });
  return (
    <>
      <div className="mb-3 flex justify-end">{can('suppliers.create') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit('new')}>{t('suppliers.new')}</Button>}</div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        {!data ? <PageLoader /> : data.length === 0 ? <Empty title={t('suppliers.empty')} /> : (
          <table className="tbl"><thead><tr><th>{t('common.name')}</th><th>{t('common.phone')}</th><th className="r">{t('purchases.tabPurchases')}</th><th className="r">{t('suppliers.totalPurchased')}</th><th className="r">{t('purchases.outstanding')}</th><th /></tr></thead>
            <tbody>{data.map((s) => (<tr key={s.id}><td className="font-semibold text-ink">{s.name}</td><td className="text-faint">{s.phone ?? '—'}</td><td className="r">{s.purchase_count}</td><td className="r">{m(s.total_purchased)}</td>
              <td className="r">{s.balance_due > 0 ? <Badge tone="warn">{m(s.balance_due)}</Badge> : <span className="text-faint">—</span>}</td>
              <td><div className="flex justify-end gap-1">
                {s.balance_due > 0 && can('suppliers.update') && <button title={t('suppliers.pay')} className="rounded p-1.5 text-faint hover:bg-muted hover:text-ok" onClick={() => setPay(s)}><Wallet className="h-3.5 w-3.5" /></button>}
                <button title={t('common.details')} className="rounded p-1.5 text-faint hover:bg-muted hover:text-brand" onClick={() => setHist(s)}><Eye className="h-3.5 w-3.5" /></button>
                {can('suppliers.update') && <><button className="rounded p-1.5 text-faint hover:bg-muted hover:text-brand" onClick={() => setEdit(s)}><Pencil className="h-3.5 w-3.5" /></button><button className="rounded p-1.5 text-faint hover:bg-muted hover:text-bad" onClick={() => setDel(s)}><Trash2 className="h-3.5 w-3.5" /></button></>}</div></td></tr>))}</tbody></table>)}
      </div>
      {edit && <PartyForm kind="supplier" initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {hist && <SupplierHistory s={hist} onClose={() => setHist(null)} />}
      {pay && <PayModal title={t('suppliers.pay')} due={pay.balance_due} onClose={() => setPay(null)} onPay={(a, mth) => recordSupplierPayment(ctx, pay.id, a, mth)} />}
      <ConfirmDialog open={!!del} danger title={t('common.delete')} message={t('suppliers.deleteMsg', { name: del?.name })} busy={rm.busy} onConfirm={() => rm.run()} onCancel={() => setDel(null)} confirmLabel={t('common.delete')} />
    </>
  );
}

export function PartyForm({ kind, initial, onClose }: { kind: 'supplier' | 'customer'; initial: any | null; onClose: () => void }) {
  const { t } = useTranslation(); const ctx = useCtx(); const toast = useApp((s) => s.toast);
  const [f, setF] = useState({ name: initial?.name ?? '', phone: initial?.phone ?? '', email: initial?.email ?? '', address: initial?.address ?? '', credit_limit: String(initial?.credit_limit ?? 0), notes: initial?.notes ?? '' });
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF({ ...f, [k]: e.target.value });
  const save = useAction(async () => {
    const input = { name: f.name, phone: f.phone, email: f.email, address: f.address, notes: f.notes, credit_limit: Number(f.credit_limit) || 0 };
    if (kind === 'supplier') initial ? await updateSupplier(ctx, initial.id, input) : await createSupplier(ctx, input);
    else { initial ? await updateCustomer(ctx, initial.id, input) : await createCustomer(ctx, input); }
    toast('success', t('common.saved')); onClose();
  });
  return (
    <Modal open title={initial ? t('common.edit') : t(kind === 'supplier' ? 'suppliers.new' : 'customers.new')} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.busy} disabled={!f.name.trim()} onClick={() => save.run()}>{t('common.save')}</Button></>}>
      <div className="space-y-3">
        <Field label={t('common.name')} required><Input autoFocus value={f.name} onChange={set('name')} /></Field>
        <div className="grid grid-cols-2 gap-3"><Field label={t('common.phone')}><Input value={f.phone} onChange={set('phone')} /></Field><Field label={t('common.email')}><Input value={f.email} onChange={set('email')} /></Field></div>
        <Field label={t('common.address')}><Input value={f.address} onChange={set('address')} /></Field>
        {kind === 'customer' && <Field label={t('customers.creditLimit')} hint={t('customers.creditLimitHint')}><Input type="number" min={0} value={f.credit_limit} onChange={set('credit_limit')} /></Field>}
        {kind === 'supplier' && <Field label={t('common.notes')}><Textarea rows={2} value={f.notes} onChange={set('notes')} /></Field>}
      </div>
    </Modal>
  );
}

export function PayModal({ title, due, onClose, onPay }: { title: string; due: number; onClose: () => void; onPay: (amount: number, method: string) => Promise<unknown> }) {
  const { t } = useTranslation(); const { lang, toast } = useApp();
  const { data: methods } = useLive((c) => getPaymentMethods(c.db));
  const [amount, setAmount] = useState(String(due)); const [method, setMethod] = useState('CASH');
  const save = useAction(async () => { await onPay(Number(amount), method); toast('success', t('common.saved')); onClose(); });
  return (
    <Modal open title={title} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={save.busy} disabled={!(Number(amount) > 0)} onClick={() => save.run()}>{t('common.confirm')}</Button></>}>
      <div className="space-y-3"><div className="rounded border border-warn/40 bg-warn-soft p-3 text-[13px] text-warn-text">{t('purchases.outstanding')}: <b>{formatMoney(due, lang)}</b></div>
        <Field label={t('common.amount')}><Input autoFocus type="number" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label={t('pos.paymentMethod')}><Select value={method} onChange={(e) => setMethod(e.target.value)}>{(methods ?? []).filter((x) => x.enabled).map((x) => <option key={x.code} value={x.code}>{lang === 'fr' ? x.label_fr : x.label_en}</option>)}</Select></Field></div>
    </Modal>
  );
}

function SupplierHistory({ s, onClose }: { s: SupplierRow; onClose: () => void }) {
  const { t } = useTranslation(); const { lang } = useApp();
  const { data } = useLive((c) => supplierHistory(c, s.id));
  return (
    <Modal open wide title={s.name} onClose={onClose}>
      {data && <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3 text-[13px]">{[[t('suppliers.totalPurchased'), formatMoney(s.total_purchased, lang)], [t('purchases.outstanding'), formatMoney(s.balance_due, lang)], [t('suppliers.productsSupplied'), String(data.products.length)]].map(([k, v]) => <div key={k} className="rounded border border-line bg-muted/40 p-3"><div className="text-[11px] uppercase text-faint">{k}</div><div className="num font-display text-[18px] font-bold">{v}</div></div>)}</div>
        <div><div className="mb-1 text-[12px] font-semibold uppercase text-faint">{t('suppliers.productsSupplied')}</div><div className="flex flex-wrap gap-1.5">{data.products.map((p) => <Badge key={p.id}>{p.name}</Badge>)}{data.products.length === 0 && <span className="text-faint">—</span>}</div></div>
        <table className="tbl"><thead><tr><th>{t('purchases.reference')}</th><th>{t('common.date')}</th><th className="r">{t('common.total')}</th><th className="r">{t('purchases.paid')}</th></tr></thead>
          <tbody>{data.purchases.map((p) => <tr key={p.id}><td className="font-mono text-[12px]">{p.reference}</td><td>{formatDate(p.purchased_at, lang)}</td><td className="r">{formatMoney(p.total, lang)}</td><td className="r">{formatMoney(p.amount_paid, lang)}</td></tr>)}</tbody></table></div>}
    </Modal>
  );
}
