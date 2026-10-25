import { Trash2 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, ConfirmDialog, Empty, PageHeader, PageLoader, Select, Tabs, useAction } from '../components/ui';
import { formatDate, formatQty } from '../lib/format';
import { expiryLevel } from '../services/expiry';
import { listBatches, listMovements, writeOffBatch, type BatchRow } from '../services/inventory';
import { useApp, useCan, useCtx } from '../state/app';
import { useLive } from '../state/hooks';

const TYPES = ['INITIAL', 'PURCHASE', 'SALE', 'SALE_CANCEL', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'DAMAGED', 'LOST', 'RETURN', 'EXPIRED'];

export function Movements() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const tab = params.get('tab') === 'lots' ? 'lots' : 'movements';
  return (
    <div>
      <PageHeader title={t('nav.movements')} subtitle={t('movements.subtitle')} />
      <Tabs tabs={[{ id: 'movements', label: t('movements.tabMovements') }, { id: 'lots', label: t('movements.tabLots') }]} value={tab} onChange={(x) => setParams({ tab: x })} />
      <div className="pt-4">{tab === 'movements' ? <MovementList /> : <Lots />}</div>
    </div>
  );
}

function MovementList() {
  const { t } = useTranslation(); const { lang } = useApp();
  const [type, setType] = useState('');
  const { data } = useLive((c) => listMovements(c, { type: type || undefined, limit: 300 }), [type]);
  return (
    <>
      <div className="mb-3 w-60"><Select value={type} onChange={(e) => setType(e.target.value)}><option value="">{t('movements.allTypes')}</option>{TYPES.map((x) => <option key={x} value={x}>{t(`movements.types.${x}`)}</option>)}</Select></div>
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        {!data ? <PageLoader /> : data.length === 0 ? <Empty title={t('movements.empty')} /> : (
          <div className="max-h-[calc(100vh-280px)] overflow-auto"><table className="tbl"><thead><tr><th>{t('common.date')}</th><th>{t('movements.product')}</th><th>{t('common.type')}</th><th className="r">{t('products.fields.quantity')}</th><th className="r">{t('movements.previous')}</th><th className="r">{t('movements.new')}</th><th>{t('movements.reason')}</th><th>{t('movements.user')}</th></tr></thead>
            <tbody>{data.map((m) => (<tr key={m.id}><td className="whitespace-nowrap text-faint">{formatDate(m.created_at, lang, true)}</td><td className="font-medium text-ink">{m.product_name}</td>
              <td><Badge tone={m.quantity > 0 ? 'ok' : 'neutral'}>{t(`movements.types.${m.type}`)}</Badge></td>
              <td className={`r font-bold ${m.quantity > 0 ? 'text-ok-text' : 'text-bad-text'}`}>{m.quantity > 0 ? '+' : ''}{formatQty(m.quantity, lang)}</td><td className="r text-faint">{formatQty(m.previous_stock, lang)}</td><td className="r">{formatQty(m.new_stock, lang)}</td>
              <td className="max-w-[220px] truncate text-faint">{m.reason ?? ''}</td><td className="text-faint">{m.user_name ?? '—'}</td></tr>))}</tbody></table></div>)}
      </div>
    </>
  );
}

function Lots() {
  const { t } = useTranslation(); const can = useCan(); const ctx = useCtx(); const { lang, toast } = useApp();
  const { data } = useLive((c) => listBatches(c));
  const [wo, setWo] = useState<BatchRow | null>(null);
  const act = useAction(async () => { await writeOffBatch(ctx, wo!.id); toast('success', t('movements.writtenOff')); setWo(null); });
  return (
    <>
      <p className="mb-3 text-[13px] text-faint">{t('movements.fefoHint')}</p>
      <div className="overflow-hidden rounded-lg border border-line bg-surface shadow-card">
        {!data ? <PageLoader /> : data.length === 0 ? <Empty title={t('movements.noLots')} /> : (
          <table className="tbl"><thead><tr><th>{t('movements.product')}</th><th>{t('purchases.lot')}</th><th>{t('products.fields.expiry')}</th><th>{t('common.status')}</th><th className="r">{t('movements.remaining')}</th><th className="r">{t('movements.received')}</th><th /></tr></thead>
            <tbody>{data.map((b) => { const e = expiryLevel(b.expiry_date, ctx.now()); return (
              <tr key={b.id}><td className="font-medium text-ink">{b.product_name}</td><td className="font-mono text-[12px]">{b.lot_code ?? '—'}</td><td>{b.expiry_date ?? '—'}</td>
                <td>{e.level === 'EXPIRED' ? <Badge tone="bad">{t('products.expired')}</Badge> : e.level === 'NONE' ? <span className="text-faint">—</span> : e.level === 'OK' ? <Badge tone="ok">OK</Badge> : <Badge tone={e.level === 'NOTICE' ? 'neutral' : 'warn'}>{t('products.inDays', { count: e.days ?? 0 })}</Badge>}</td>
                <td className="r font-bold">{formatQty(b.quantity_remaining, lang)} {b.unit}</td><td className="r text-faint">{formatDate(b.received_at, lang)}</td>
                <td className="text-right">{e.level === 'EXPIRED' && can('inventory.adjust') && <Button size="sm" variant="danger" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={() => setWo(b)}>{t('movements.writeOff')}</Button>}</td></tr>); })}</tbody></table>)}
      </div>
      <ConfirmDialog open={!!wo} danger title={t('movements.writeOff')} message={t('movements.writeOffMsg', { qty: wo ? formatQty(wo.quantity_remaining, lang) : '', unit: wo?.unit, name: wo?.product_name })} busy={act.busy} onConfirm={() => act.run()} onCancel={() => setWo(null)} confirmLabel={t('movements.writeOff')} />
    </>
  );
}
