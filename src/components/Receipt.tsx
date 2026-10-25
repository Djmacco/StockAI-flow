import { ImageIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { amountInWords, formatMoney, formatQty, type Lang } from '../lib/format';
import type { Customer, Sale, SaleItem } from '../services/types';
import { useApp } from '../state/app';
import { PrintPortal } from './PrintPortal';

type S = Record<string, string>;

/** The receipt content. Used for printing (hidden on screen) and for the live preview in Settings. */
export function ReceiptBody({ sale, items, customer, settings, lang, preview }: { sale: Sale; items: SaleItem[]; customer?: Customer | null; settings: S; lang: Lang; preview?: boolean }) {
  const { t } = useTranslation();
  const m = (n: number) => formatMoney(n, lang, false);
  const showTime = settings.receipt_show_time !== '0';
  const line = <div style={{ borderTop: '1px dashed #000', margin: '5px 0' }} />;
  const row = (a: React.ReactNode, b: React.ReactNode, bold = false) => <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: bold ? 700 : 400 }}><span>{a}</span><span>{b}</span></div>;
  const soldAt = new Date(sale.sold_at);
  const dateText = Number.isNaN(soldAt.getTime()) ? sale.sold_at : new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' }).format(soldAt);
  const timeText = Number.isNaN(soldAt.getTime()) ? '' : new Intl.DateTimeFormat(lang === 'fr' ? 'fr-FR' : 'en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(soldAt);
  let paymentLabel = sale.payment_method;
  try { const methods = JSON.parse(settings.payment_methods ?? '[]') as { code: string; label_fr: string; label_en: string }[]; paymentLabel = methods.find((method) => method.code === sale.payment_method)?.[lang === 'fr' ? 'label_fr' : 'label_en'] || paymentLabel; } catch { /* Keep the payment code if settings are unavailable. */ }
  const footer = settings.receipt_footer && !['Merci de votre visite !', 'Thank you for your visit!'].includes(settings.receipt_footer) ? settings.receipt_footer : '';
  return (
    <>
      {/* Optional logo. In the preview an empty dashed frame shows where it will go; nothing is printed when no logo is set. */}
      {settings.receipt_logo
        ? <div style={{ textAlign: 'center', marginBottom: 4 }}><img src={settings.receipt_logo} alt="" style={{ maxWidth: '100%', maxHeight: 64, display: 'inline-block' }} /></div>
        : preview && <div style={{ border: '1px dashed #9ca3af', color: '#9ca3af', height: 54, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, marginBottom: 6, fontSize: 10 }}><ImageIcon size={14} />LOGO</div>}
      {!settings.receipt_logo && <div style={{ textAlign: 'center', fontWeight: 700, fontSize: 24, lineHeight: 1.1, fontFamily: "'Brush Script MT', 'Segoe Script', cursive" }}>{settings.business_name}</div>}
      {settings.receipt_tagline && <div style={{ textAlign: 'center', margin: '3px 0 5px', fontFamily: 'Inter, sans-serif' }}>{settings.receipt_tagline}</div>}
      <div style={{ textAlign: 'center', fontWeight: 700, marginBottom: 4 }}>{t('receipt.greeting')}</div>
      <div>{t('receipt.ticket')}: {sale.receipt_no}</div>
      {settings.branch_name && <div style={{ textAlign: 'center', textTransform: 'uppercase' }}>{settings.branch_name}</div>}
      <div style={{ textAlign: 'center', fontWeight: 700 }}>{sale.user_name}</div>
      {settings.business_phone && <div style={{ textAlign: 'center' }}>{settings.business_phone}</div>}
      {settings.business_address && <div style={{ textAlign: 'center' }}>{settings.business_address}</div>}
      {line}
      <div style={{ textAlign: 'center' }}>{t('receipt.dateLead')} {dateText}{showTime ? ` ${lang === 'fr' ? 'à' : 'at'} ${timeText}` : ''}</div>
      {(customer?.name ?? sale.customer_name) && <div>{t('receipt.customer')}: {customer?.name ?? sale.customer_name}</div>}
      {sale.price_tier === 'WHOLESALE' && <div>{t('receipt.wholesale')}</div>}
      {sale.status === 'CANCELLED' && <div style={{ fontWeight: 700 }}>*** {t('receipt.cancelled')} ***</div>}
      {line}
      {items.map((i) => (
        <div key={i.id} style={{ display: 'flex', justifyContent: 'space-between', gap: 4, border: '1px solid #555', padding: '5px 3px', marginBottom: 3 }}>
          <span style={{ flex: 1 }}>{formatQty(i.quantity, lang)} {i.product_name}{i.discount > 0 ? ` (-${m(i.discount)})` : ''}</span><span>{m(i.line_total)}</span>
        </div>))}
      {line}
      {sale.discount_total > 0 && row(t('receipt.discount'), `-${m(sale.discount_total)}`)}
      {row(t('receipt.total'), <>{m(sale.total)}<br />F CFA</>, true)}
      <div style={{ margin: '2px 0 5px', textTransform: 'capitalize' }}>{amountInWords(sale.total, lang)}</div>
      {row(t('receipt.payment'), <b>{paymentLabel.toLocaleUpperCase(lang === 'fr' ? 'fr-FR' : 'en-US')}</b>)}
      {sale.change_due > 0 && row(t('receipt.change'), m(sale.change_due))}
      {sale.total > sale.amount_paid && row(t('receipt.onCredit'), m(sale.total - sale.amount_paid), true)}
      {line}
      <div style={{ textAlign: 'center', marginTop: 4 }}>{t('receipt.disclaimer')}</div>
      <div style={{ textAlign: 'center', fontWeight: 700, marginTop: 7 }}>{t('receipt.thankYou', { business: settings.business_name })}</div>
      {footer && <div style={{ textAlign: 'center', marginTop: 4 }}>{footer}</div>}
    </>
  );
}

/** 72 mm thermal-style receipt, rendered in #print-root (hidden on screen). `window.print()` prints ONLY this (see index.css). */
export function Receipt({ sale, items, customer }: { sale: Sale; items: SaleItem[]; customer?: Customer | null }) {
  const { settings, lang } = useApp();
  return <PrintPortal><div className="receipt-root"><ReceiptBody sale={sale} items={items} customer={customer} settings={settings} lang={lang} /></div></PrintPortal>;
}

/** On-screen sample receipt (Settings). */
export function ReceiptPreview({ settings, lang }: { settings: S; lang: Lang }) {
  const now = new Date().toISOString();
  const base = { id: 'x', created_at: now, updated_at: now, device_id: '', version: 1, sync_status: 'SYNCED' as const, deleted_at: null };
  const sale: Sale = { ...base, receipt_no: 'R20261010-A1B2-0042', customer_id: null, customer_name: 'Jean Mbarga', user_id: null, user_name: 'Awa Ngono', cash_session_id: null, subtotal: 3500, discount_total: 0, total: 3500, amount_paid: 3500,
    change_due: 1500, payment_method: 'CASH', cost_total: 0, status: 'COMPLETED', notes: null, sold_at: now, cancelled_at: null, cancel_reason: null, price_tier: 'RETAIL' };
  const items: SaleItem[] = [
    { ...base, id: 'a', sale_id: 'x', product_id: 'a', product_name: 'Coca-Cola 50cl', quantity: 5, unit_price: 500, unit_cost: 0, discount: 0, line_total: 2500 },
    { ...base, id: 'b', sale_id: 'x', product_id: 'b', product_name: 'Baguette', quantity: 3, unit_price: 150, unit_cost: 0, discount: 0, line_total: 450 }];
  return (
    <div className="mx-auto w-[270px] rounded border border-line-strong bg-white p-3 text-black shadow-card" style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 11 }}>
      <ReceiptBody sale={{ ...sale, total: 2950, subtotal: 2950, amount_paid: 2950, change_due: 50 }} items={items} settings={settings} lang={lang} preview />
    </div>
  );
}
