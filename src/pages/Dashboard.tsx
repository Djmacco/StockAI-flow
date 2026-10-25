import { AlertTriangle, ArrowDownRight, ArrowUpRight, Boxes, Clock, Crown, Lightbulb, Plus, ShoppingCart, TrendingUp, Wallet } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { computeInsights } from '../ai/insights';
import { InsightList } from '../components/Insights';
import { Badge, Button, Card, Modal, PageHeader, PageLoader } from '../components/ui';
import { formatDate, formatMoney, formatQty } from '../lib/format';
import { dashboard } from '../services/reports';
import { recoveryStatus } from '../services/recovery';
import { useApp } from '../state/app';
import { useLive } from '../state/hooks';

function Kpi({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: string; sub?: React.ReactNode; tone?: string }) {
  return (
    <div className="rounded-lg border border-line bg-surface p-4 shadow-card">
      <div className="mb-2 flex items-center justify-between text-faint"><span className="text-[11px] font-semibold uppercase tracking-wide">{label}</span><span className={tone}>{icon}</span></div>
      <div className="num font-display text-[24px] font-bold leading-8 text-ink">{value}</div>
      {sub && <div className="mt-1 text-[12px] text-faint">{sub}</div>}
    </div>
  );
}

function Spark({ data }: { data: number[] }) {
  const max = Math.max(1, ...data);
  return (
    <svg viewBox={`0 0 ${data.length * 14} 40`} className="h-10 w-full" preserveAspectRatio="none">
      {data.map((v, i) => <rect key={i} x={i * 14 + 2} y={40 - (v / max) * 38} width="10" height={Math.max(1, (v / max) * 38)} rx="1.5" className={i === data.length - 1 ? 'fill-brand' : 'fill-brand/30'} />)}
    </svg>
  );
}

export function Dashboard() {
  const { t } = useTranslation();
  const nav = useNavigate();
  const { lang, permissions, entitlement, user } = useApp();
  const m = (n: number) => formatMoney(n, lang);
  const { data: d } = useLive((ctx) => dashboard(ctx));
  const { data: rec } = useLive((c) => (c.permissions.has('users.manage') ? recoveryStatus(c.db) : Promise.resolve(undefined)));
  const { data: ins } = useLive((ctx) => (ctx.permissions.has('reports.read') ? computeInsights(ctx) : Promise.resolve(undefined)));
  const [allInsights, setAll] = useState(false);
  if (!d) return <PageLoader />;
  const canReports = permissions.has('reports.read');
  const delta = d.yesterday.revenue ? Math.round(((d.today.revenue - d.yesterday.revenue) / d.yesterday.revenue) * 100) : null;
  const expiredN = d.expiry.expired.length, soonN = d.expiry.soon.length;

  return (
    <div>
      <PageHeader title={t('dashboard.greeting', { name: user?.full_name.split(' ')[0] })} subtitle={t('dashboard.subtitle')}
        actions={<>
          {permissions.has('inventory.adjust') && <Button variant="secondary" icon={<Plus className="h-4 w-4" />} onClick={() => nav('/products?adjust=1')}>{t('dashboard.addStock')}</Button>}
          {permissions.has('sales.create') && <Button icon={<ShoppingCart className="h-4 w-4" />} onClick={() => nav('/pos')}>{t('dashboard.newSale')} <span className="kbd ml-1 !bg-white/20 !text-white !border-white/30">F2</span></Button>}
        </>} />

      {rec && !rec.exists && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-lg border border-warn/40 bg-warn-soft px-4 py-3 text-[13px] text-warn-text">
          <span><b>{t('recovery.bannerTitle')}</b> {t('recovery.bannerText')}</span>
          <Button size="sm" onClick={() => nav('/settings?tab=users')}>{t('recovery.create')}</Button>
        </div>)}
      <div className="grid grid-cols-4 gap-4">
        <Kpi icon={<TrendingUp className="h-4 w-4" />} label={t('dashboard.todaySales')} value={m(d.today.revenue)} tone="text-brand"
          sub={<span className="flex items-center gap-1.5">{d.today.count} {t('dashboard.tickets')}{delta !== null && <span className={delta >= 0 ? 'flex items-center text-ok-text' : 'flex items-center text-bad-text'}>{delta >= 0 ? <ArrowUpRight className="h-3 w-3" /> : <ArrowDownRight className="h-3 w-3" />}{Math.abs(delta)}% {t('dashboard.vsYesterday')}</span>}</span>} />
        {canReports
          ? <Kpi icon={<Wallet className="h-4 w-4" />} label={t('dashboard.todayProfit')} value={m(d.today.profit)} tone="text-ok" sub={`${t('dashboard.margin')} ${Math.round(d.today.margin)}%`} />
          : <Kpi icon={<Wallet className="h-4 w-4" />} label={t('dashboard.avgTicket')} value={m(d.today.avg_ticket)} />}
        {canReports && <Kpi icon={<Boxes className="h-4 w-4" />} label={t('dashboard.stockValue')} value={m(d.stock.value_cost)} sub={`${t('dashboard.retail')}: ${m(d.stock.value_retail)}`} />}
        <Kpi icon={<Boxes className="h-4 w-4" />} label={t('dashboard.products')} value={String(d.stock.products)} sub={`${formatQty(d.stock.units, lang)} ${t('dashboard.units')}`} />
      </div>

      <div className="mt-4 grid grid-cols-3 gap-4">
        <div className="col-span-2 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <Card title={<span className="flex items-center gap-2"><AlertTriangle className="h-4 w-4 text-warn" />{t('dashboard.lowStock')}</span>} actions={<Link className="text-[12px] text-brand" to="/products?status=low">{t('common.viewAll')}</Link>} bodyClass="!p-0">
              {d.low.length === 0 ? <p className="p-4 text-[13px] text-faint">{t('dashboard.noLow')}</p> : (
                <ul className="divide-y divide-line/60">{d.low.slice(0, 6).map((p) => (
                  <li key={p.id} className="flex items-center justify-between px-4 py-2 text-[13px]"><span className="truncate">{p.name}</span>
                    <Badge tone={p.quantity <= 0 ? 'bad' : 'warn'}>{p.quantity <= 0 ? t('products.out') : `${formatQty(p.quantity, lang)} / ${formatQty(p.minimum_stock, lang)}`}</Badge></li>))}</ul>)}
            </Card>
            <Card title={<span className="flex items-center gap-2"><Clock className="h-4 w-4 text-bad" />{t('dashboard.expiry')}</span>} actions={<Link className="text-[12px] text-brand" to="/movements?tab=lots">{t('common.viewAll')}</Link>} bodyClass="!p-0">
              {expiredN + soonN === 0 ? <p className="p-4 text-[13px] text-faint">{t('dashboard.noExpiry')}</p> : (
                <ul className="divide-y divide-line/60">
                  {d.expiry.expired.slice(0, 3).map((b) => <li key={b.id} className="flex items-center justify-between px-4 py-2 text-[13px]"><span className="truncate">{b.product_name}</span><Badge tone="bad">{t('products.expired')}</Badge></li>)}
                  {d.expiry.soon.slice(0, 4).map((b) => <li key={b.id} className="flex items-center justify-between px-4 py-2 text-[13px]"><span className="truncate">{b.product_name}</span><Badge tone={b.days <= 7 ? 'warn' : 'neutral'}>{t('products.inDays', { count: b.days })}</Badge></li>)}
                </ul>)}
            </Card>
          </div>

          {permissions.has('sales.read') && (
            <Card title={t('dashboard.recentSales')} actions={<Spark data={d.sparkline.map((p) => p.revenue)} />} bodyClass="!p-0">
              {d.recentSales.length === 0 ? <p className="p-4 text-[13px] text-faint">{t('dashboard.noSales')}</p> : (
                <table className="tbl"><tbody>{d.recentSales.map((s) => (
                  <tr key={s.id}><td className="font-mono text-[12px]">{s.receipt_no}</td><td>{s.customer_name ?? t('pos.walkIn')}</td><td className="text-faint">{formatDate(s.sold_at, lang, true)}</td>
                    <td className="r font-semibold">{m(s.total)}</td><td>{s.status === 'CANCELLED' ? <Badge tone="bad">{t('sales.cancelled')}</Badge> : <Badge tone="ok">{t('sales.completed')}</Badge>}</td></tr>))}</tbody></table>)}
            </Card>)}

          <div className="grid grid-cols-2 gap-4">
            <Card title={t('dashboard.recentMovements')} bodyClass="!p-0">
              <ul className="divide-y divide-line/60">{d.recentMovements.map((mv) => (
                <li key={mv.id} className="flex items-center justify-between px-4 py-2 text-[13px]"><span className="truncate">{mv.product_name}</span>
                  <span className="flex items-center gap-2"><span className="text-[11px] text-faint">{t(`movements.types.${mv.type}`)}</span><span className={`num font-semibold ${mv.quantity < 0 ? 'text-bad-text' : 'text-ok-text'}`}>{mv.quantity > 0 ? '+' : ''}{formatQty(mv.quantity, lang)}</span></span></li>))}
                {d.recentMovements.length === 0 && <li className="p-4 text-[13px] text-faint">—</li>}</ul>
            </Card>
            {permissions.has('purchases.read') && (
              <Card title={t('dashboard.recentPurchases')} bodyClass="!p-0">
                <ul className="divide-y divide-line/60">{d.recentPurchases.map((p) => (
                  <li key={p.id} className="flex items-center justify-between px-4 py-2 text-[13px]"><span className="truncate">{p.supplier_name ?? p.reference}</span><span className="num font-semibold">{m(p.total)}</span></li>))}
                  {d.recentPurchases.length === 0 && <li className="p-4 text-[13px] text-faint">—</li>}</ul>
              </Card>)}
          </div>
        </div>

        <div className="space-y-4">
          {canReports && (
            <Card title={<span className="flex items-center gap-2 text-ai-text"><Lightbulb className="h-4 w-4" />{t('insight.title')}</span>}
              actions={<Button size="sm" variant="ghost" onClick={() => setAll(true)}>{t('insight.viewAll')}</Button>}>
              <InsightList result={ins} limit={3} />
            </Card>)}
          {entitlement.state !== 'ACTIVE' && permissions.has('settings.manage') && (
            <Card className="border-ai/40 bg-ai-soft">
              <div className="mb-1 flex items-center gap-2 font-display font-semibold text-ai-text"><Crown className="h-4 w-4" />{t('dashboard.premiumTitle')}</div>
              <p className="mb-3 text-[12px] text-body">{t('dashboard.premiumText')}</p>
              <Button variant="ai" size="sm" onClick={() => nav('/settings?tab=subscription')}>{t('dashboard.premiumCta')}</Button>
            </Card>)}
        </div>
      </div>

      <Modal open={allInsights} wide title={t('insight.title')} onClose={() => setAll(false)}><InsightList result={ins} /></Modal>
    </div>
  );
}
