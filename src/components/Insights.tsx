import { Lightbulb } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { insightText } from '../ai/insightText';
import type { InsightResult } from '../ai/insights';
import { translate } from '../i18n';
import { useApp } from '../state/app';
import { Badge, cn } from './ui';

export function InsightList({ result, limit }: { result: InsightResult | undefined; limit?: number }) {
  const { t } = useTranslation();
  const lang = useApp((s) => s.lang);
  if (!result) return null;
  if (!result.enoughData) return <p className="text-[13px] text-faint">{t('insight.notEnough')}</p>;
  if (!result.insights.length) return <p className="text-[13px] text-faint">{t('insight.nothing')}</p>;
  const list = limit ? result.insights.slice(0, limit) : result.insights;
  return (
    <ul className="space-y-2.5">
      {list.map((i) => {
        const x = insightText(translate, lang, i);
        const urgent = i.type === 'STOCK_RISK' || i.type === 'STOCK_COVER';
        return (
          <li key={i.id} className={cn('flex gap-2.5 rounded-lg border p-3', urgent ? 'border-warn/40 bg-warn-soft' : 'border-line bg-muted/40')}>
            <Lightbulb className={cn('mt-0.5 h-4 w-4 shrink-0', urgent ? 'text-warn-text' : 'text-ai')} />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] font-semibold text-ink">{x.title}</div>
              {x.detail && <div className="text-[12px] text-body">{x.detail}</div>}
              {x.reco && <div className="mt-1 text-[12px] font-medium text-ink">→ {x.reco}</div>}
            </div>
            <Badge tone={x.confidence === 'high' ? 'ok' : 'neutral'}>{t(`insight.confidence.${x.confidence}`)}</Badge>
          </li>
        );
      })}
    </ul>
  );
}
