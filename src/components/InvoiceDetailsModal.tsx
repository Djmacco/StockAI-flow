import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { createInvoiceFromSale, documentForSale } from '../services/documents';
import { getSale } from '../services/sales';
import { useApp, useCtx } from '../state/app';
import { Button, Field, Input, Modal, Textarea, useAction } from './ui';

/**
 * Asks for the customer details printed on the invoice (pre-filled from the customer or the receipt) and creates it.
 * If the sale already has an invoice, no form: the existing invoice is opened (one sale, one invoice number).
 */
export function InvoiceDetailsModal({ saleId, onClose, onCreated }: { saleId: string; onClose: () => void; onCreated: (docId: string) => void }) {
  const { t } = useTranslation(); const ctx = useCtx(); const { toast, fail } = useApp();
  const [ready, setReady] = useState(false);
  const [f, setF] = useState({ name: '', address: '', phone: '', tax_id: '', due_date: '', notes: '' });
  useEffect(() => {
    let live = true;
    (async () => {
      const existing = await documentForSale(ctx, saleId);
      if (existing) { if (live) onCreated(existing.id); return; }
      const s = await getSale(ctx, saleId);
      if (live && s) setF((x) => ({ ...x, name: s.customer?.name ?? s.sale.customer_name ?? '', address: s.customer?.address ?? '', phone: s.customer?.phone ?? '', tax_id: s.customer?.tax_id ?? '' }));
      if (live) setReady(true);
    })().catch((e) => { fail(e); onClose(); });
    return () => { live = false; };
  }, [saleId]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const create = useAction(async () => {
    const d = await createInvoiceFromSale(ctx, saleId, { party: { name: f.name, address: f.address, phone: f.phone, tax_id: f.tax_id }, due_date: f.due_date || null, notes: f.notes });
    toast('success', t('documents.created', { number: d.number })); onCreated(d.id);
  });
  if (!ready) return null;
  return (
    <Modal open wide title={t('documents.invoiceDetails')} onClose={onClose}
      footer={<><Button variant="secondary" onClick={onClose}>{t('common.cancel')}</Button><Button loading={create.busy} onClick={() => create.run()}>{t('documents.invoiceCreate')}</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={t('documents.customerName')}><Input autoFocus value={f.name} maxLength={80} onChange={set('name')} /></Field>
        <Field label={t('documents.customerTaxId')}><Input value={f.tax_id} onChange={set('tax_id')} /></Field>
        <Field label={t('documents.customerAddress')}><Input value={f.address} onChange={set('address')} /></Field>
        <Field label={t('documents.customerPhone')}><Input value={f.phone} onChange={set('phone')} /></Field>
        <Field label={t('documents.dueDate')} hint={t('documents.dueDateHint')}><Input type="date" value={f.due_date} onChange={set('due_date')} /></Field>
        <div />
        <Field label={t('documents.notes')} className="col-span-2"><Textarea rows={2} value={f.notes} onChange={set('notes')} placeholder={t('documents.notesPlaceholder')} /></Field>
      </div>
    </Modal>
  );
}
