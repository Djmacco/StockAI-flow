import type { Lang } from '../lib/format';
import type { Insight } from './insights';

export type Translate = (lng: Lang, key: string, params?: Record<string, any>) => string;

export const dayName = (dow: number, lng: Lang) =>
  new Date(2024, 0, 7 + dow).toLocaleDateString(lng === 'fr' ? 'fr-FR' : 'en-GB', { weekday: 'long' });

export interface InsightText { title: string; detail?: string; reco?: string; confidence: 'high' | 'medium' }

/** Turns an Insight (numbers only) into short localised text. Estimates are always worded as estimates. */
export function insightText(t: Translate, lng: Lang, i: Insight): InsightText {
  const p: Record<string, any> = { ...i.params, day: i.params.dow !== undefined ? dayName(Number(i.params.dow), lng) : '' };
  if (i.type === 'HOUR_PEAK') { p.from = `${i.params.from}h`; p.to = `${i.params.to}h`; }
  const k = (s: string) => `insight.${i.type}.${s}`;
  const has = (s: string) => t(lng, k(s)) !== k(s);
  return {
    title: t(lng, k('title'), p),
    detail: has('detail') ? t(lng, k('detail'), p) : undefined,
    reco: has('reco') ? t(lng, k('reco'), p) : undefined,
    confidence: i.confidence >= 0.7 ? 'high' : 'medium',
  };
}
