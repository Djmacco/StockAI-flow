import { Lightbulb, MessageCircle, TrendingDown, TrendingUp, Clock, AlertTriangle, CalendarDays, Gauge } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { insightText } from '../ai/insightText';
import { computeInsights, INSIGHT_RULES, type Insight, type InsightType } from '../ai/insights';
import { Badge, Button, Card, Empty, PageHeader, PageLoader, cn } from '../components/ui';
import { translate } from '../i18n';
import { useApp } from '../state/app';
import { useAssistant } from '../state/assistant';
import { useLive } from '../state/hooks';

type Group = 'all' | 'stock' | 'trends' | 'patterns';
const GROUP_OF: Record<InsightType, Exclude<Group, 'all'>> = { STOCK_RISK: 'stock', STOCK_COVER: 'stock', SLOW_MOVER: 'stock', TREND_UP: 'trends', TREND_DOWN: 'trends', WEEKDAY_PEAK: 'patterns', WEEKEND_PEAK: 'patterns', HOUR_PEAK: 'patterns' };
const ICON: Record<InsightType, React.ReactNode> = {
  STOCK_RISK: <AlertTriangle className="h-4 w-4" />, STOCK_COVER: <Gauge className="h-4 w-4" />, SLOW_MOVER: <TrendingDown className="h-4 w-4" />, TREND_UP: <TrendingUp className="h-4 w-4" />,
  TREND_DOWN: <TrendingDown className="h-4 w-4" />, WEEKDAY_PEAK: <CalendarDays className="h-4 w-4" />, WEEKEND_PEAK: <CalendarDays className="h-4 w-4" />, HOUR_PEAK: <Clock className="h-4 w-4" />,
};

export function Insights() {
  const { t } = useTranslation();
  const lang = useApp((s) => s.lang);
  const { data } = useLive((c) => computeInsights(c));
  const [group, setGroup] = useState<Group>('all');
  const ask = (i: Insight) => {
    const name = String(i.params.product ?? i.params.category ?? '');
    useApp.getState().setAssistantOpen(true);
    void useAssistant.getState().send(lang === 'fr' ? `Pourquoi recommandes-tu plus de ${name} ?` : `Why are you recommending more ${name}?`);
  };
  if (!data) return <PageLoader />;
  const list = data.insights.filter((i) => group === 'all' || GROUP_OF[i.type] === group);
  const count = (g: Group) => data.insights.filter((i) => g === 'all' || GROUP_OF[i.type] === g).length;

  return (
    <div>
      <PageHeader title={t('insights.title')} subtitle={t('insights.subtitle')}
        actions={<Badge tone="neutral">{t('insights.analysed', { days: data.historyDays })}</Badge>} />
      {!data.enoughData ? (
        <Card><Empty icon={<Lightbulb className="h-10 w-10" />} title={t('insight.notEnough')} hint={t('insights.needData', { days: INSIGHT_RULES.minHistoryDays })} /></Card>
      ) : (<>
        <div className="mb-4 flex gap-2">
          {(['all', 'stock', 'trends', 'patterns'] as Group[]).map((g) => (
            <button key={g} onClick={() => setGroup(g)} className={cn('rounded-full border px-3.5 py-1.5 text-[13px] font-medium', group === g ? 'border-ai bg-ai-soft text-ai-text' : 'border-line bg-surface hover:bg-muted')}>
              {t(`insights.group.${g}`)} <span className="ml-1 text-faint">{count(g)}</span></button>))}
        </div>
        {list.length === 0 ? <Card><Empty title={t('insight.nothing')} /></Card> : (
          <div className="grid grid-cols-2 gap-4">{list.map((i) => {
            const x = insightText(translate, lang, i);
            const urgent = i.type === 'STOCK_RISK' || i.type === 'STOCK_COVER';
            return (
              <div key={i.id} className={cn('flex flex-col rounded-lg border p-4 shadow-card', urgent ? 'border-warn/40 bg-warn-soft' : 'border-line bg-surface')}>
                <div className="mb-2 flex items-center justify-between">
                  <span className={cn('flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide', urgent ? 'text-warn-text' : 'text-ai-text')}>{ICON[i.type]}{t(`insights.type.${i.type}`)}</span>
                  <Badge tone={x.confidence === 'high' ? 'ok' : 'neutral'}>{t(`insight.confidence.${x.confidence}`)}</Badge></div>
                <div className="font-display text-[15px] font-semibold leading-5 text-ink">{x.title}</div>
                {x.detail && <div className="mt-1 text-[13px] text-body">{x.detail}</div>}
                {x.reco && <div className="mt-2 rounded border border-line bg-surface/80 px-2.5 py-1.5 text-[13px] font-medium text-ink">→ {x.reco}</div>}
                {i.type !== 'STOCK_COVER' && <div className="mt-3 flex justify-end"><Button size="sm" variant="ai" icon={<MessageCircle className="h-3.5 w-3.5" />} onClick={() => ask(i)}>{t('insights.explain')}</Button></div>}
              </div>); })}</div>)}
        <p className="mt-4 text-[12px] text-faint">{t('insights.disclaimer')}</p>
      </>)}
    </div>
  );
}
