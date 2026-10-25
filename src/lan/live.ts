import type { Db } from '../database/db';
import { formatMoney, type Lang } from '../lib/format';
import { getSetting } from '../services/settings';
import type { RemoteEvent } from '../sync/engine';
import { getNetConfig, lanActive } from './network';
import { call, type LanFetch, tauriLanFetch } from './transport';

/**
 * Instant updates on a shop network. Instead of asking "anything new?" every few seconds, this PC keeps one request open on the
 * main PC ("tell me when something changes"). The moment another PC records a sale, the request returns and a normal sync round
 * runs, so the news arrives within a fraction of a second. The 5-second round in the engine stays as a safety net.
 */
export class LanWatcher {
  private running = false;
  private readonly sleep: (ms: number) => Promise<void>;
  constructor(private d: { db: Db; deviceId: string; onChange: () => Promise<unknown> | void; fetch?: LanFetch; waitSeconds?: number; sleep?: (ms: number) => Promise<void> }) {
    this.sleep = d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  start() { if (this.running) return; this.running = true; void this.loop(); }
  stop() { this.running = false; }

  private async loop() {
    const f = this.d.fetch ?? tauriLanFetch;
    const wait = this.d.waitSeconds ?? 20;
    let stalled = 0;                                                            // rounds in a row that could not move our position
    let failures = 0;                                                           // requests in a row that failed (main PC unreachable, dropped connection)
    while (this.running) {
      try {
        const cfg = await getNetConfig(this.d.db);
        if (!lanActive(cfg)) { await this.sleep(3000); continue; }          // not on a shop network (yet)
        const before = (await getSetting(this.d.db, 'sync_cursor_lan')) || '0';
        const r = await call(f, { method: 'GET', url: `${cfg.url}/sync/wait?since=${encodeURIComponent(before)}&timeout=${wait}`, token: cfg.token, deviceId: this.d.deviceId, timeoutMs: (wait + 15) * 1000 });
        if (!this.running) break;
        failures = 0;
        const retryAfter = Number(r?.retryAfterMs) || 0;     // the main PC already has enough PCs waiting: we poll gently instead
        if (r?.changed) {
          await this.d.onChange();
          // If rounds keep failing to move our position (error, rejected data) back off gradually: 0.2 s, 0.4 s ... 3 s.
          // A single miss must cost almost nothing (the news may simply have arrived during the round), so no flat long pause.
          const after = (await getSetting(this.d.db, 'sync_cursor_lan')) || '0';
          if (after === before) { stalled++; await this.sleep(Math.min(3000, 200 * 2 ** (stalled - 1))); } else { stalled = 0; await this.sleep(retryAfter || 50); }
        } else if (retryAfter) await this.sleep(retryAfter);
      } catch {
        // One dropped request (a blip) costs 0.3 s; a main PC that stays away is retried more and more slowly, up to 3 s.
        if (this.running) await this.sleep(Math.min(3000, 300 * 2 ** failures++));
      }
    }
  }
}

/** Texts for the small notifications ("Caisse 2 sold R20261015-B-0007 · 4 500 FCFA"). A burst becomes one summary. */
export function describeRemote(events: RemoteEvent[], t: (k: string, o?: any) => string, lang: Lang): string[] {
  if (events.length === 0) return [];
  if (events.length > 3) {
    const sales = events.filter((e) => e.kind === 'SALE').length;
    return [t('network.live.many', { count: events.length, sales })];
  }
  return events.map((e) => {
    if (e.kind === 'SALE') return t('network.live.sale', { who: e.who, receipt: e.receipt, total: formatMoney(e.total ?? 0, lang) });
    if (e.kind === 'CANCEL') return t('network.live.cancel', { who: e.who, receipt: e.receipt });
    return t('network.live.stock', { who: e.who, product: e.product || '?', qty: `${(e.qty ?? 0) > 0 ? '+' : ''}${e.qty ?? 0}` });
  });
}
