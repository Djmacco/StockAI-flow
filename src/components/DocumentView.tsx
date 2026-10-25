import { Ban, FileCheck2, Printer } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cancelDocument, convertProforma, getDocument } from '../services/documents';
import { getPaymentMethods } from '../services/settings';
import { useApp, useCan, useCtx } from '../state/app';
import { useLive } from '../state/hooks';
import { formatMoney } from '../lib/format';
import { DocumentBody, DocumentPrint } from './DocumentSheet';
import { Badge, Button, Field, Input, Modal, PageLoader, Select, useAction } from './ui';

export const docTone = (s: string) => (s === 'ISSUED' ? 'ok' : s === 'OPEN' ? 'warn' : s === 'CONVERTED' ? 'info' : 'neutral') as 'ok' | 'warn' | 'info' | 'neutral';

/**
 * The invoice / proforma as it will print, with its actions: print, turn a proforma into a sale + invoice, cancel.
 * `onOpen` lets the parent jump to another document (a converted proforma opens the invoice it became).
 */
export function DocumentView({ id, onClose, onOpen }: { id: string; onClose: () => void; onOpen?: (id: string) => void }) {
  const { t } = useTranslation(); const { settings, lang } = useApp(); const can = useCan();
  const { data } = useLive((c) => getDocument(c, id), [id]);
  const [convert, setConvert] = useState(false); const [cancel, setCancel] = useState(false);
  const doc = data?.doc;
  const invoice = doc?.doc_type === 'INVOICE';
  const canConvert = !!doc && !invoice && doc.status === 'OPEN' && can('sales.create');
  const canCancel = !!doc && (invoice ? doc.status === 'ISSUED' && can('sales.cancel') : doc.status === 'OPEN' && can('sales.create'));
  return (
    <>
      <Modal open wide="xl" onClose={onClose}
        title={<span className="flex items-center gap-3">{doc ? `${t(invoice ? 'documents.invoiceTitle' : 'documents.proformaTitle')} ${doc.number}` : '…'}{doc && <Badge tone={docTone(doc.status)}>{t(`documents.status.${doc.status}`)}</Badge>}</span>}
        footer={<>
          {canCancel && <Button variant="danger" icon={<Ban className="h-4 w-4" />} onClick={() => setCancel(true)}>{t('documents.cancelDoc')}</Button>}
          <span className="flex-1" />
          <Button variant="secondary" onClick={onClose}>{t('common.close')}</Button>
          {canConvert && <Button variant="secondary" icon={<FileCheck2 className="h-4 w-4" />} onClick={() => setConvert(true)}>{t('documents.convert')}</Button>}
          <Button icon={<Printer className="h-4 w-4" />} disabled={!data} onClick={() => window.print()}>{t('documents.print')}</Button>
        </>}>
        {!data ? <PageLoader /> : (
          <div className="overflow-auto rounded border border-line bg-muted/40 p-4">
            <div style={{ width: 794, margin: '0 auto', background: '#fff', color: '#000', padding: 40, boxShadow: '0 1px 8px rgba(0,0,0,.18)' }}>
              <DocumentBody detail={data} settings={settings} lang={lang} />
            </div>
          </div>)}
      </Modal>
      {data && <DocumentPrint detail={data} />}
      {data && convert && <ConvertModal id={id} total={data.doc.total} onClose={() => setConvert(false)} onDone={(invoiceId) => { setConvert(false); onOpen?.(invoiceId); }} />}
      {data && cancel && <CancelModal id={id} invoice={!!invoice} onClose={() => setCancel(false)} onDone={() => setCancel(false)} />}
    </>
  );
}

function ConvertModal({ id, total, onClose, onDone }: { id: string; total: number; onClose: () => void; onDone: (invoiceId: string) => void }) {
  const { t } = useTranslation(); const ctx = useCtx(); const { lang, toast } = useApp();
  const { data: methods } = useLive((c) => getPaymentMethods(c.db));
  const enabled = (methods ?? []).filter((x) => x.enabled);
  const [method, setMethod] = useState(''); const [received, setReceived] = useState('');
  const chosen = method || enabled[0]?.code || 'CASH';
  const paid = received === '' ? total : Math.max(0, Math.round(Number(received) || 0));
  const run = useAction(async () => {
    const r = await convertProforma(ctx, id, { payment_method: chosen, amount_tendered: paid });
    toast('success', t('documents.converted', { receipt: r.sale.receipt_no, invoice: r.invoice.number })); onDone(r.invoice.id);
  });
  return (
    <Modal open title={t('documents.convertTitle')} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={run.busy} onClick={() => run.run()}>{t('documents.convertConfirm')}</Button></>}>
      <p className="mb-3 text-[13px] text-body">{t('documents.convertMsg')}</p>
      <div className="space-y-3">
        <Field label={t('pos.paymentMethod')}><Select value={chosen} onChange={(e) => setMethod(e.target.value)}>{enabled.map((x) => <option key={x.code} value={x.code}>{lang === 'fr' ? x.label_fr : x.label_en}</option>)}</Select></Field>
        <Field label={t('documents.amountReceived')} hint={paid < total ? `${t('pos.onCredit')}: ${formatMoney(total - paid, lang)}` : undefined}>
          <Input type="number" min={0} value={received} onChange={(e) => setReceived(e.target.value)} placeholder={String(total)} /></Field>
      </div>
    </Modal>
  );
}

function CancelModal({ id, invoice, onClose, onDone }: { id: string; invoice: boolean; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation(); const ctx = useCtx(); const { toast } = useApp();
  const [reason, setReason] = useState('');
  const run = useAction(async () => { await cancelDocument(ctx, id, reason); toast('success', t('documents.cancelled')); onDone(); });
  return (
    <Modal open title={t('documents.cancelDoc')} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>{t('common.back')}</Button><Button variant="danger" loading={run.busy} disabled={!reason.trim()} onClick={() => run.run()}>{t('documents.cancelDoc')}</Button></>}>
      <p className="mb-3 text-[13px] text-body">{t(invoice ? 'documents.cancelInvoiceMsg' : 'documents.cancelProformaMsg')}</p>
      <Field label={t('documents.reason')}><Input autoFocus value={reason} maxLength={120} onChange={(e) => setReason(e.target.value)} placeholder={t('documents.reasonPlaceholder')} /></Field>
    </Modal>
  );
}
