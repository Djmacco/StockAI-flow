import { Eye, Pencil, Plus, Trash2, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Badge, Button, ConfirmDialog, Empty, Modal, PageHeader, PageLoader, SearchInput, useAction } from '../components/ui';
import { formatDate, formatMoney } from '../lib/format';
import { customerHistory, deleteCustomer, listCustomers, recordCustomerPayment, type CustomerRow } from '../services/parties';
import { useApp, useCan, useCtx } from '../state/app';
import { useDebounced, useLive } from '../state/hooks';
import { PartyForm, PayModal } from './Purchases';

export function Customers() {
  const { t } = useTranslation(); const can = useCan(); const ctx = useCtx(); const { lang, toast } = useApp();
  const m = (n: number) => formatMoney(n, lang);
  const [q, setQ] = useState(''); const dq = useDebounced(q);
  const { data } = useLive((c) => listCustomers(c, dq), [dq]);
  const [edit, setEdit] = useState<CustomerRow | 'new' | null>(null); const [view, setView] = useState<CustomerRow | null>(null);
  const [pay, setPay] = useState<CustomerRow | null>(null); const [del, setDel] = useState<CustomerRow | null>(null);
  const rm = useAction(async () => { await deleteCustomer(ctx, del!.id); toast('success', t('common.deleted')); setDel(null); });
  const totalDue = (data ?? []).reduce((s, c) => s + c.balance_due, 0);
  return (
    <div>
      <PageHeader title={t('nav.customers')} subtitle={totalDue > 0 ? t('customers.totalDue', { amount: m(totalDue) }) : t('customers.subtitle')}
        actions={can('customers.create') && <Button icon={<Plus className="h-4 w-4" />} onClick={() => setEdit('new')}>{t('customers.new')}</Button>} />
      <div className="mb-3 w-80"><SearchInput value={q} onChange={setQ} placeholder={t('common.search')} /></div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        {!data ? <PageLoader /> : data.length === 0 ? <Empty title={t('customers.empty')} hint={t('customers.emptyHint')} /> : (
          <table className="tbl"><thead><tr><th>{t('common.name')}</th><th>{t('common.phone')}</th><th className="r">{t('customers.purchases')}</th><th className="r">{t('customers.totalSpent')}</th><th className="r">{t('customers.balance')}</th><th /></tr></thead>
            <tbody>{data.map((c) => (<tr key={c.id}><td className="font-semibold text-ink">{c.name}{c.price_tier === 'WHOLESALE' && <Badge tone="info" className="ml-2">{t('customers.tierWholesale')}</Badge>}</td><td className="text-faint">{c.phone ?? '—'}</td><td className="r">{c.purchase_count}</td><td className="r">{m(c.total_spent)}</td>
              <td className="r">{c.balance_due > 0 ? <Badge tone="warn">{m(c.balance_due)}</Badge> : <span className="text-faint">—</span>}</td>
              <td><div className="flex justify-end gap-1">
                {c.balance_due > 0 && can('customers.update') && <button title={t('customers.recordPayment')} className="rounded p-1.5 text-faint hover:bg-muted hover:text-ok" onClick={() => setPay(c)}><Wallet className="h-3.5 w-3.5" /></button>}
                <button title={t('common.details')} className="rounded p-1.5 text-faint hover:bg-muted hover:text-brand" onClick={() => setView(c)}><Eye className="h-3.5 w-3.5" /></button>
                {can('customers.update') && <><button className="rounded p-1.5 text-faint hover:bg-muted hover:text-brand" onClick={() => setEdit(c)}><Pencil className="h-3.5 w-3.5" /></button><button className="rounded p-1.5 text-faint hover:bg-muted hover:text-bad" onClick={() => setDel(c)}><Trash2 className="h-3.5 w-3.5" /></button></>}</div></td></tr>))}</tbody></table>)}
      </div>
      {edit && <PartyForm kind="customer" initial={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
      {view && <History c={view} onClose={() => setView(null)} />}
      {pay && <PayModal title={t('customers.recordPayment')} due={pay.balance_due} onClose={() => setPay(null)} onPay={(a, mth) => recordCustomerPayment(ctx, pay.id, a, mth)} />}
      <ConfirmDialog open={!!del} danger title={t('common.delete')} message={t('customers.deleteMsg', { name: del?.name })} busy={rm.busy} onConfirm={() => rm.run()} onCancel={() => setDel(null)} confirmLabel={t('common.delete')} />
    </div>
  );
}

function History({ c, onClose }: { c: CustomerRow; onClose: () => void }) {
  const { t } = useTranslation(); const { lang } = useApp();
  const { data } = useLive((ctx) => customerHistory(ctx, c.id));
  return (
    <Modal open wide title={c.name} onClose={onClose}>
      {data && <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">{[[t('customers.totalSpent'), formatMoney(c.total_spent, lang)], [t('customers.purchases'), String(c.purchase_count)], [t('customers.balance'), formatMoney(c.balance_due, lang)]].map(([k, v]) => <div key={k} className="rounded border border-line bg-muted/40 p-3"><div className="text-[11px] uppercase text-faint">{k}</div><div className="num font-display text-[18px] font-bold">{v}</div></div>)}</div>
        <table className="tbl"><thead><tr><th>{t('receipt.no')}</th><th>{t('common.date')}</th><th className="r">{t('common.total')}</th><th className="r">{t('receipt.paid')}</th><th>{t('common.status')}</th></tr></thead>
          <tbody>{data.sales.map((s) => <tr key={s.id}><td className="font-mono text-[12px]">{s.receipt_no}</td><td>{formatDate(s.sold_at, lang, true)}</td><td className="r">{formatMoney(s.total, lang)}</td><td className="r">{formatMoney(s.amount_paid, lang)}</td><td>{s.status === 'CANCELLED' ? <Badge tone="bad">{t('sales.cancelled')}</Badge> : <Badge tone="ok">{t('sales.completed')}</Badge>}</td></tr>)}</tbody></table>
        {data.payments.length > 0 && <div><div className="mb-1 text-[12px] font-semibold uppercase text-faint">{t('customers.payments')}</div>
          <ul className="divide-y divide-line/60 rounded border border-line">{data.payments.map((p: any) => <li key={p.id} className="flex justify-between px-3 py-1.5 text-[13px]"><span>{formatDate(p.paid_at, lang)} · {p.method}</span><b className="num text-ok-text">{formatMoney(p.amount, lang)}</b></li>)}</ul></div>}
      </div>}
    </Modal>
  );
}
