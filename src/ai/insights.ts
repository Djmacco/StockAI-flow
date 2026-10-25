import { addDays, iso, startOfDay, ymd } from '../lib/time';
import type { AppContext } from '../services/context';

/**
 * AI STOCK & SALES INSIGHTS — plain statistics on the local SQLite history.
 * No model, no network. Patterns are only reported when there is enough
 * comparable history (never from a single transaction).
 */
export type InsightType =
  | 'STOCK_RISK' | 'STOCK_COVER' | 'TREND_UP' | 'TREND_DOWN' | 'WEEKDAY_PEAK' | 'WEEKEND_PEAK' | 'HOUR_PEAK' | 'SLOW_MOVER';

export interface Insight {
  id: string;
  type: InsightType;
  productId?: string;
  categoryId?: string;
  /** Raw numbers for the i18n templates. `dow`: 0=Sunday. */
  params: Record<string, string | number>;
  /** 0..1 — how clear the pattern is (shown as High / Medium). */
  confidence: number;
  priority: number;
}

export interface InsightResult { insights: Insight[]; enoughData: boolean; historyDays: number }

// ---- thresholds (kept together so they are easy to tune / test)
export const INSIGHT_RULES = {
  maxWindowDays: 56,
  minHistoryDays: 14,          // below this: "not enough history"
  minOccurrencesPerWeekday: 3, // a weekday must have been observed at least 3 times
  minTotalUnits: 12,           // ignore products that barely sell
  peakRatio: 1.5,              // weekday mean vs other days
  peakMinDiff: 2,              // and at least 2 units more
  weekendRatio: 1.2,           // +20 %
  trendMinPrev: 6,             // previous week units needed to talk about a trend
  trendPct: 15,
  slowDropPct: 50,
  slowMinPrior: 8,
  hourShare: 0.5, hourMinUnits: 10, hourMinDays: 5,
  coverDays: 2,                // stock lasts less than 2 days at current pace
  coverMinUnits: 5,
};

interface Line { product_id: string; name: string; category_id: string | null; qty: number; sold_at: string; stock: number; unit: string }

const mean = (a: number[]) => (a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0);

export async function computeInsights(ctx: AppContext): Promise<InsightResult> {
  const R = INSIGHT_RULES;
  const today = startOfDay(ctx.now());
  const yesterday = addDays(today, -1); // only COMPLETE days are analysed
  const windowStart = addDays(yesterday, -(R.maxWindowDays - 1));

  const rows = await ctx.db.select<Line>(
    `SELECT i.product_id, p.name, p.category_id, i.quantity AS qty, s.sold_at, p.quantity AS stock, p.unit
     FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id
     WHERE s.status = 'COMPLETED' AND s.deleted_at IS NULL AND i.deleted_at IS NULL AND p.deleted_at IS NULL
       AND s.sold_at >= ? AND s.sold_at < ?`, [iso(windowStart), iso(today)]);

  if (!rows.length) return { insights: [], enoughData: false, historyDays: 0 };

  // History = from the first sale in the window up to yesterday.
  const firstDay = startOfDay(new Date(rows.reduce((m, r) => (r.sold_at < m ? r.sold_at : m), rows[0].sold_at)));
  const historyDays = Math.round((yesterday.getTime() - firstDay.getTime()) / 86400000) + 1;
  if (historyDays < R.minHistoryDays) return { insights: [], enoughData: false, historyDays };

  const days: Date[] = [];
  for (let d = firstDay; d <= yesterday; d = addDays(d, 1)) days.push(d);
  const idx = new Map(days.map((d, i) => [ymd(d), i]));

  // per-product daily units + hourly units
  const byProduct = new Map<string, { name: string; category: string | null; stock: number; unit: string; daily: number[]; hours: number[]; saleDays: Set<number> }>();
  for (const r of rows) {
    let p = byProduct.get(r.product_id);
    if (!p) byProduct.set(r.product_id, (p = { name: r.name, category: r.category_id, stock: r.stock, unit: r.unit, daily: new Array(days.length).fill(0), hours: new Array(24).fill(0), saleDays: new Set() }));
    const d = new Date(r.sold_at);
    const i = idx.get(ymd(d));
    if (i === undefined) continue;
    p.daily[i] += r.qty;
    p.hours[d.getHours()] += r.qty;
    p.saleDays.add(i);
  }

  const out: Insight[] = [];
  const tomorrowDow = addDays(today, 1).getDay();
  const dows = days.map((d) => d.getDay());
  const isWeekend = (dow: number) => dow === 0 || dow === 6;
  const peakProducts = new Set<string>();

  for (const [pid, p] of byProduct) {
    const total = p.daily.reduce((s, x) => s + x, 0);
    if (total < R.minTotalUnits) continue;

    // ---- 1. weekday peak
    let best: { dow: number; avg: number; other: number; ratio: number } | null = null;
    for (let dow = 0; dow < 7; dow++) {
      const on = p.daily.filter((_, i) => dows[i] === dow);
      const off = p.daily.filter((_, i) => dows[i] !== dow);
      if (on.length < R.minOccurrencesPerWeekday || !off.length) continue;
      const avg = mean(on), other = mean(off);
      const ratio = other > 0 ? avg / other : avg > 0 ? Infinity : 0;
      if (ratio >= R.peakRatio && avg - other >= R.peakMinDiff && on.filter((x) => x > 0).length >= 2 && (!best || avg - other > best.avg - best.other)) best = { dow, avg, other, ratio };
    }
    if (best) {
      peakProducts.add(pid);
      out.push({
        id: `peak:${pid}`, type: 'WEEKDAY_PEAK', productId: pid, priority: 4,
        confidence: Math.min(1, 0.5 + 0.1 * p.daily.filter((_, i) => dows[i] === best!.dow).length),
        params: { product: p.name, dow: best.dow, avgPeak: Math.round(best.avg), avgOther: Math.round(best.other), pct: Math.round((best.ratio === Infinity ? 1 : best.ratio - 1) * 100) },
      });
      // ---- stock recommendation for tomorrow
      if (best.dow === tomorrowDow && p.stock < best.avg) {
        const need = best.avg - p.stock;
        out.push({
          id: `risk:${pid}`, type: 'STOCK_RISK', productId: pid, priority: 1, confidence: 0.7,
          params: { product: p.name, dow: best.dow, avgPeak: Math.round(best.avg), stock: p.stock, unit: p.unit, addMin: Math.max(1, Math.ceil(need)), addMax: Math.max(2, Math.ceil(best.avg * 1.25 - p.stock)) },
        });
      }
    }

    // ---- 2. trend (last 7 complete days vs the 7 before)
    if (days.length >= 14) {
      const n = days.length;
      const last = p.daily.slice(n - 7).reduce((s, x) => s + x, 0);
      const prev = p.daily.slice(n - 14, n - 7).reduce((s, x) => s + x, 0);
      if (prev >= R.trendMinPrev) {
        const pct = Math.round(((last - prev) / prev) * 100);
        if (pct >= R.trendPct) out.push({ id: `up:${pid}`, type: 'TREND_UP', productId: pid, priority: 3, confidence: 0.7, params: { product: p.name, pct, last, prev } });
        else if (pct <= -R.trendPct) out.push({ id: `down:${pid}`, type: 'TREND_DOWN', productId: pid, priority: 8, confidence: 0.7, params: { product: p.name, pct: Math.abs(pct), last, prev } });
      }
      // ---- 3. stock cover at current pace
      if (last >= R.coverMinUnits && p.stock > 0) {
        const perDay = last / 7;
        const cover = p.stock / perDay;
        if (cover < R.coverDays) out.push({ id: `cover:${pid}`, type: 'STOCK_COVER', productId: pid, priority: 2, confidence: 0.75, params: { product: p.name, stock: p.stock, unit: p.unit, daysLeft: Math.round(cover * 10) / 10, perDay: Math.round(perDay * 10) / 10 } });
      }
    }

    // ---- 4. slow mover (last 14 days vs the prior 28-day daily rate)
    if (days.length >= 28 && p.stock > 0) {
      const n = days.length;
      const recent = p.daily.slice(n - 14);
      const prior = p.daily.slice(Math.max(0, n - 42), n - 14);
      const priorUnits = prior.reduce((s, x) => s + x, 0);
      if (prior.length >= 14 && priorUnits >= R.slowMinPrior) {
        const exp = (priorUnits / prior.length) * 14;
        const got = recent.reduce((s, x) => s + x, 0);
        const drop = Math.round((1 - got / exp) * 100);
        if (drop >= R.slowDropPct) out.push({ id: `slow:${pid}`, type: 'SLOW_MOVER', productId: pid, priority: 7, confidence: 0.6, params: { product: p.name, drop, stock: p.stock, unit: p.unit } });
      }
    }

    // ---- 5. time of day (3-hour window)
    if (total >= R.hourMinUnits && p.saleDays.size >= R.hourMinDays) {
      let bestH = 0, bestSum = 0;
      for (let h = 0; h <= 21; h++) {
        const s = p.hours[h] + p.hours[h + 1] + p.hours[h + 2];
        if (s > bestSum) { bestSum = s; bestH = h; }
      }
      if (bestSum / total >= R.hourShare) out.push({ id: `hour:${pid}`, type: 'HOUR_PEAK', productId: pid, priority: 6, confidence: Math.min(1, bestSum / total), params: { product: p.name, from: bestH, to: bestH + 3, share: Math.round((bestSum / total) * 100) } });
    }
  }

  // ---- 6. weekend vs weekday by category (aggregate) — skipped for products that already have a weekday-peak insight
  const catNames = new Map((await ctx.db.select<{ id: string; name: string }>('SELECT id, name FROM categories WHERE deleted_at IS NULL')).map((c) => [c.id, c.name]));
  const byCat = new Map<string, number[]>();
  for (const [pid, p] of byProduct) {
    if (!p.category || peakProducts.has(pid)) continue;
    const arr = byCat.get(p.category) ?? new Array(days.length).fill(0);
    p.daily.forEach((v, i) => (arr[i] += v));
    byCat.set(p.category, arr);
  }
  for (const [cid, daily] of byCat) {
    const wk = daily.filter((_, i) => isWeekend(dows[i]));
    const wd = daily.filter((_, i) => !isWeekend(dows[i]));
    const total = daily.reduce((s, x) => s + x, 0);
    if (wk.length < 4 || wd.length < 8 || total < R.minTotalUnits) continue;
    const a = mean(wk), b = mean(wd);
    if (b > 0 && a / b >= R.weekendRatio)
      out.push({ id: `weekend:${cid}`, type: 'WEEKEND_PEAK', categoryId: cid, priority: 5, confidence: 0.65, params: { category: catNames.get(cid) ?? '', pct: Math.round((a / b - 1) * 100), avgWeekend: Math.round(a), avgWeekday: Math.round(b) } });
  }

  out.sort((x, y) => x.priority - y.priority || y.confidence - x.confidence);
  return { insights: out, enoughData: true, historyDays };
}
