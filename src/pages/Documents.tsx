import { FilePlus2, FileText, Receipt as ReceiptIcon } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { DocumentView, docTone } from '../components/DocumentView';
import { InvoiceDetailsModal } from '../components/InvoiceDetailsModal';
import { Badge, Button, Empty, Modal, PageHeader, PageLoader, SearchInput, Select, Tabs } from '../components/ui';
import { formatDate, formatMoney } from '../lib/format';
import { listDocuments } from '../services/documents';
import { listSales } from '../services/sales';
import { useApp, useCan } from '../state/app';
import { useDebounced, useLive } from '../state/hooks';

const PAGE = 100;

export function Documents() {
  const { t } = useTranslation(); const { lang } = useApp(); const can = useCan(); const nav = useNavigate();
  const [tab, setTab] = useState<'INVOICE' | 'PROFORMA'>('INVOICE');
  const [q, setQ] = useState(''); const dq = useDebounced(q, 200);
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pick, setPick] = useState(false); const [invoiceSale, setInvoiceSale] = useState<string | null>(null);
  const { data } = useLive((c) => listDocuments(c, { type: tab, status: status || undefined, search: dq, limit: limit + 1 }), [tab, status, dq, limit]);
  const rows = (data ?? []).slice(0, limit);
  const m = (n: number) => formatMoney(n, lang);
  const statuses = tab === 'INVOICE' ? ['ISSUED', 'CANCELLED'] : ['OPEN', 'CONVERTED', 'CANCELLED'];
  const now = Date.now();
  return (
    <div>
      <PageHeader title={t('nav.documents')} subtitle={t('documents.subtitle')}
        actions={can('sales.create') ? <>
          <Button variant="secondary" icon={<ReceiptIcon className="h-4 w-4" />} onClick={() => setPick(true)}>{t('documents.invoiceFromSale')}</Button>
          <Button icon={<FilePlus2 className="h-4 w-4" />} onClick={() => nav('/pos?mode=proforma')}>{t('documents.newProforma')}</Button></> : undefined} />
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <Tabs tabs={[{ id: 'INVOICE', label: t('documents.tabInvoices') }, { id: 'PROFORMA', label: t('documents.tabProformas') }]} value={tab} onChange={(v) => { setTab(v); setStatus(''); setLimit(PAGE); }} />
        <div className="ml-auto flex items-center gap-3">
          <div className="w-72"><SearchInput value={q} onChange={setQ} placeholder={t('documents.search')} /></div>
          <Select className="w-44" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t('documents.allStatuses')}</option>{statuses.map((s) => <option key={s} value={s}>{t(`documents.status.${s}`)}</option>)}</Select>
        </div>
      </div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        {!data ? <PageLoader /> : rows.length === 0 ? <Empty icon={<FileText className="h-8 w-8" />} title={t('documents.empty')} hint={t(tab === 'INVOICE' ? 'documents.emptyInvoicesHint' : 'documents.emptyProformasHint')} /> : (
          <div className="max-h-[calc(100vh-290px)] overflow-auto">
            <table className="tbl"><thead><tr><th>{t('documents.number')}</th><th>{t('documents.issueDate')}</th><th>{t('documents.customer')}</th><th className="r">{t('documents.total')}</th>{tab === 'INVOICE' ? <th className="r">{t('documents.balanceDue')}</th> : <th>{t('documents.validUntil')}</th>}<th>{t('common.status')}</th></tr></thead>
              <tbody>{rows.map((d) => {
                const overdue = d.doc_type === 'INVOICE' && d.status === 'ISSUED' && d.balance_due > 0 && !!d.due_date && new Date(d.due_date).getTime() < now;
                const expired = d.doc_type === 'PROFORMA' && d.status === 'OPEN' && !!d.due_date && new Date(d.due_date).getTime() < now;
                return (
                  <tr key={d.id} className="cursor-pointer" onClick={() => setOpenId(d.id)}>
                    <td className="font-mono text-[12px] font-semibold text-ink">{d.number}</td>
                    <td className="text-faint">{formatDate(d.issue_date, lang)}</td>
                    <td>{d.customer_name || <span className="text-faint">{t('documents.walkIn')}</span>}</td>
                    <td className="r font-semibold">{m(d.total)}</td>
                    {tab === 'INVOICE' ? <td className="r">{d.balance_due > 0 ? <span className={overdue ? 'font-semibold text-bad-text' : 'text-warn-text'}>{m(d.balance_due)}</span> : <span className="text-faint">—</span>}</td>
                      : <td className={expired ? 'font-semibold text-bad-text' : 'text-faint'}>{d.due_date ? formatDate(d.due_date, lang) : '—'}</td>}
                    <td><Badge tone={docTone(d.status)}>{t(`documents.status.${d.status}`)}</Badge>{(overdue || expired) && <Badge tone="bad" className="ml-1">{t('documents.overdue')}</Badge>}</td>
                  </tr>);
              })}</tbody></table>
            {(data?.length ?? 0) > limit && <div className="border-t border-line p-3 text-center"><Button variant="secondary" size="sm" onClick={() => setLimit(limit + PAGE)}>{t('documents.showMore')}</Button></div>}
          </div>)}
      </div>
      {openId && <DocumentView id={openId} onClose={() => setOpenId(null)} onOpen={(id) => { setTab('INVOICE'); setOpenId(id); }} />}
      {pick && <SalePicker onClose={() => setPick(false)} onPick={(id) => { setPick(false); setInvoiceSale(id); }} />}
      {invoiceSale && <InvoiceDetailsModal saleId={invoiceSale} onClose={() => setInvoiceSale(null)} onCreated={(id) => { setInvoiceSale(null); setTab('INVOICE'); setOpenId(id); }} />}
    </div>
  );
}

/** Find a past sale (receipt number or customer) to build its invoice. */
function SalePicker({ onClose, onPick }: { onClose: () => void; onPick: (saleId: string) => void }) {
  const { t } = useTranslation(); const { lang } = useApp();
  const [q, setQ] = useState(''); const dq = useDebounced(q, 200);
  const { data } = useLive((c) => listSales(c, { status: 'COMPLETED', search: dq, limit: 30 }), [dq]);
  return (
    <Modal open wide title={t('documents.pickSale')} onClose={onClose}>
      <p className="mb-3 text-[13px] text-faint">{t('documents.pickSaleHint')}</p>
      <div className="mb-3"><SearchInput value={q} onChange={setQ} autoFocus placeholder={t('documents.pickSaleSearch')} /></div>
      {!data ? <PageLoader /> : data.length === 0 ? <Empty title={t('documents.noSales')} /> : (
        <table className="tbl"><thead><tr><th>{t('receipt.no')}</th><th>{t('common.date')}</th><th>{t('documents.customer')}</th><th className="r">{t('documents.total')}</th></tr></thead>
          <tbody>{data.map((s) => (
            <tr key={s.id} className="cursor-pointer" onClick={() => onPick(s.id)}>
              <td className="font-mono text-[12px] font-semibold text-ink">{s.receipt_no}</td><td className="text-faint">{formatDate(s.sold_at, lang, true)}</td>
              <td>{s.customer_name ?? <span className="text-faint">{t('documents.walkIn')}</span>}</td><td className="r font-semibold">{formatMoney(s.total, lang)}</td></tr>))}</tbody></table>)}
    </Modal>
  );
}
