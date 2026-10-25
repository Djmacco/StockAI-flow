import { useTranslation } from 'react-i18next';
import { formatDate, formatMoney, formatQty, type Lang } from '../lib/format';
import type { DocumentDetail } from '../services/documents';
import { useApp } from '../state/app';
import { PrintPortal } from './PrintPortal';

type S = Record<string, string>;

/**
 * The invoice / proforma on A4. Inline styles only (like the receipt) so the on-screen preview and the printed page are the same markup.
 * Prices are tax-inclusive: when a VAT rate is set, the tax CONTAINED in the total is shown (HT / TVA / TTC), nothing is added.
 */
export function DocumentBody({ detail, settings, lang }: { detail: DocumentDetail; settings: S; lang: Lang }) {
  const { t } = useTranslation();
  const { doc, items, sale } = detail;
  const m = (n: number) => formatMoney(n, lang);
  const invoice = doc.doc_type === 'INVOICE';
  const cancelled = doc.status === 'CANCELLED';
  const lineDiscounts = items.reduce((s, i) => s + i.discount, 0);
  const hasDiscount = doc.discount_total > 0 || lineDiscounts > 0;
  const balance = invoice && !cancelled ? Math.max(0, doc.total - doc.amount_paid) : 0;
  const grey = '#555';
  const th: React.CSSProperties = { textAlign: 'left', padding: '6px 8px', background: '#f1f1f1', borderBottom: '1.5px solid #000', fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 };
  const td: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #ddd', verticalAlign: 'top' };
  const r: React.CSSProperties = { textAlign: 'right', whiteSpace: 'nowrap' };
  const row = (label: string, value: string, bold = false, big = false) => (
    <tr><td style={{ padding: '3px 8px', textAlign: 'right', fontWeight: bold ? 700 : 400, color: bold ? '#000' : grey }}>{label}</td>
      <td style={{ padding: '3px 8px', textAlign: 'right', whiteSpace: 'nowrap', fontWeight: bold ? 700 : 400, fontSize: big ? 15 : 12 }}>{value}</td></tr>);

  return (
    <div style={{ position: 'relative', fontFamily: "Inter, 'Segoe UI', Arial, sans-serif", fontSize: 12, color: '#000', lineHeight: 1.35 }}>
      {cancelled && <div style={{ position: 'absolute', top: '38%', left: 0, right: 0, textAlign: 'center', fontSize: 72, fontWeight: 800, color: 'rgba(200,0,0,.14)', transform: 'rotate(-18deg)', pointerEvents: 'none' }}>{t('documents.cancelledStamp')}</div>}

      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24, marginBottom: 22 }}>
        <div style={{ maxWidth: '55%' }}>
          {settings.receipt_logo && <img src={settings.receipt_logo} alt="" style={{ maxHeight: 60, maxWidth: 200, marginBottom: 6, display: 'block' }} />}
          <div style={{ fontSize: 17, fontWeight: 800 }}>{settings.business_name}</div>
          {settings.branch_name && <div>{settings.branch_name}</div>}
          {settings.business_address && <div style={{ color: grey }}>{settings.business_address}</div>}
          {settings.business_phone && <div style={{ color: grey }}>{settings.business_phone}</div>}
          {settings.business_tax_id && <div style={{ color: grey }}>{t('documents.shopTaxId')}: {settings.business_tax_id}</div>}
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: 1 }}>{t(invoice ? 'documents.invoiceTitle' : 'documents.proformaTitle').toUpperCase()}</div>
          <div style={{ fontSize: 14, fontWeight: 700, marginTop: 2 }}>{doc.number}</div>
          <div style={{ color: grey, marginTop: 6 }}>{t('documents.issueDate')}: {formatDate(doc.issue_date, lang)}</div>
          {doc.due_date && <div style={{ color: grey }}>{t(invoice ? 'documents.dueDate' : 'documents.validUntil')}: {formatDate(doc.due_date, lang)}</div>}
          {invoice && sale && <div style={{ color: grey }}>{t('documents.saleRef')}: {sale.receipt_no}</div>}
          {!invoice && detail.converted_number && <div style={{ color: grey }}>{t('documents.convertedTo', { number: detail.converted_number })}</div>}
          {invoice && detail.source_number && <div style={{ color: grey }}>{t('documents.fromProforma', { number: detail.source_number })}</div>}
        </div>
      </div>

      <div style={{ border: '1px solid #ccc', borderRadius: 4, padding: '10px 12px', marginBottom: 18, maxWidth: '55%' }}>
        <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4, color: grey, marginBottom: 3 }}>{t('documents.billTo')}</div>
        <div style={{ fontWeight: 700, fontSize: 13 }}>{doc.customer_name || t('documents.walkIn')}</div>
        {doc.customer_address && <div>{doc.customer_address}</div>}
        {doc.customer_phone && <div>{doc.customer_phone}</div>}
        {doc.customer_tax_id && <div>{t('documents.customerTaxId')}: {doc.customer_tax_id}</div>}
      </div>

      <table style={{ width: '100%', borderCollapse: 'collapse', marginBottom: 12 }}>
        <thead><tr><th style={th}>{t('documents.description')}</th><th style={{ ...th, ...r }}>{t('documents.qty')}</th><th style={{ ...th, ...r }}>{t('documents.unitPrice')}</th>{lineDiscounts > 0 && <th style={{ ...th, ...r }}>{t('documents.discount')}</th>}<th style={{ ...th, ...r }}>{t('documents.amount')}</th></tr></thead>
        <tbody>{items.map((i) => (
          <tr key={i.id}><td style={td}>{i.description}</td><td style={{ ...td, ...r }}>{formatQty(i.quantity, lang)}{i.unit ? ` ${i.unit}` : ''}</td><td style={{ ...td, ...r }}>{m(i.unit_price)}</td>
            {lineDiscounts > 0 && <td style={{ ...td, ...r }}>{i.discount > 0 ? `-${m(i.discount)}` : ''}</td>}<td style={{ ...td, ...r, fontWeight: 600 }}>{m(i.line_total)}</td></tr>))}</tbody>
      </table>

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 24 }}>
        <div style={{ flex: 1, color: grey, fontSize: 11 }}>
          {doc.tax_rate > 0 && <div>{t('documents.pricesIncludeTax')}</div>}
          {!invoice && <div style={{ marginTop: 4, fontWeight: 600, color: '#000' }}>{t('documents.notAnInvoice')}</div>}
        </div>
        <table style={{ borderCollapse: 'collapse', minWidth: 260 }}><tbody>
          {hasDiscount && row(t('documents.subtotal'), m(doc.subtotal))}
          {hasDiscount && row(t('documents.discountTotal'), `-${m(doc.discount_total)}`)}
          {doc.tax_rate > 0 && row(t('documents.totalExcl'), m(doc.total - doc.tax_total))}
          {doc.tax_rate > 0 && row(t('documents.tax', { rate: String(doc.tax_rate).replace('.', lang === 'fr' ? ',' : '.') }), m(doc.tax_total))}
          <tr><td colSpan={2}><div style={{ borderTop: '1.5px solid #000', margin: '4px 0' }} /></td></tr>
          {row(t(doc.tax_rate > 0 ? 'documents.totalIncl' : 'documents.total'), m(doc.total), true, true)}
          {invoice && doc.amount_paid > 0 && row(t('documents.paid'), m(doc.amount_paid))}
          {invoice && balance > 0 && row(t('documents.balanceDue'), m(balance), true)}
        </tbody></table>
      </div>

      {(doc.notes || settings.invoice_notes) && (
        <div style={{ marginTop: 22, fontSize: 11 }}>
          {doc.notes && <div style={{ marginBottom: 8 }}><b>{t('documents.notes')}</b><div style={{ whiteSpace: 'pre-wrap' }}>{doc.notes}</div></div>}
          {settings.invoice_notes && <div style={{ whiteSpace: 'pre-wrap', color: grey }}>{settings.invoice_notes}</div>}
        </div>)}
      <div style={{ marginTop: 28, textAlign: 'center', fontSize: 11, color: grey }}>{settings.receipt_footer}</div>
    </div>
  );
}

/** The print copy: hidden on screen, the only thing `window.print()` prints (see index.css). */
export function DocumentPrint({ detail }: { detail: DocumentDetail }) {
  const { settings, lang } = useApp();
  return <PrintPortal><div className="doc-root"><DocumentBody detail={detail} settings={settings} lang={lang} /></div></PrintPortal>;
}
