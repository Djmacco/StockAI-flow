import type { CloudClient } from '../cloud/client';
import { CloudError } from '../cloud/client';
import type { Db } from '../database/db';
import { clearToken, hasFeature, installToken, loadStatus } from '../entitlement/entitlement';
import { getSetting, setSetting } from '../services/settings';
import { type HubStatus, getNetConfig, lanActive } from './network';
import { call, type LanFetch, LanError, tauriLanFetch } from './transport';

/**
 * ONE SUBSCRIPTION FOR THE WHOLE SHOP.
 * Premium is bound to a device, so the PC that PAID (the main PC) asks the cloud to share it with the other PCs of the shop
 * (POST /subscriptions/share). The cloud returns, for each PC, a signed entitlement bound to THAT PC and valid until the owner's
 * expiry. The main PC keeps them in its hub; every other PC fetches its own over the local network (so it works without internet)
 * and verifies it with the same public key as any entitlement. When the owner stops paying, the entitlements simply expire.
 */
export interface ShareResult { deviceId: string; status: 'SHARED' | 'ALREADY_SHARED' | 'OWN_SUBSCRIPTION' | 'INVALID'; entitlement: string | null; deviceToken: string | null; expiresAt: string | null }
export interface HubPort {
  status: () => Promise<Pick<HubStatus, 'devices'>>;
  setEntitlements: (items: { deviceId: string; entitlement: string; deviceToken: string | null; expiresAt: string | null }[]) => Promise<void>;
}
export type ShareOutcome = { kind: 'DONE'; shared: number; skipped: number } | { kind: 'NOT_HOST' | 'NO_PREMIUM' | 'OFFLINE' };

const SHARE_REFRESH_MS = 15 * 60_000;

/** Main PC: give every paired PC its Premium (and withdraw it from PCs that were removed). */
export async function shareShopPremium(d: { db: Db; deviceId: string; cloud: Pick<CloudClient, 'request'>; hub: HubPort; now?: () => Date }): Promise<ShareOutcome> {
  const now = d.now?.() ?? new Date();
  if ((await getNetConfig(d.db)).mode !== 'host') return { kind: 'NOT_HOST' };
  // Only a PC that holds its OWN valid Premium can share it (the cloud enforces the same rule).
  if (!hasFeature(await loadStatus(d.db, d.deviceId, now), 'CLOUD_SYNC') || (await getSetting(d.db, 'premium_source')) === 'shared') return { kind: 'NO_PREMIUM' };

  const members = (await d.hub.status()).devices.filter((x) => !x.revoked && x.deviceId !== d.deviceId).map((x) => x.deviceId).sort();
  const previous: string[] = safeList(await getSetting(d.db, 'premium_shared_ids'));
  let items: { deviceId: string; entitlement: string; deviceToken: string | null; expiresAt: string | null }[] = [];
  let skipped = 0;
  try {
    if (members.length) {
      const results = await d.cloud.request<ShareResult[]>('/subscriptions/share', { method: 'POST', body: JSON.stringify({ deviceIds: members }) }, 'either');
      for (const r of results) {
        if (r.status === 'SHARED' && r.entitlement) items.push({ deviceId: r.deviceId, entitlement: r.entitlement, deviceToken: r.deviceToken, expiresAt: r.expiresAt });
        else skipped++;
      }
    }
    // PCs that were removed from the shop no longer share it (best effort: the entitlement expires by itself anyway).
    for (const gone of previous.filter((p) => !members.includes(p))) {
      await d.cloud.request(`/subscriptions/share/${encodeURIComponent(gone)}`, { method: 'DELETE' }, 'either').catch(() => undefined);
    }
  } catch (e) {
    if (e instanceof CloudError && e.kind === 'NETWORK') return { kind: 'OFFLINE' };
    if (e instanceof CloudError && e.kind === 'PREMIUM_REQUIRED') { await d.hub.setEntitlements([]); return { kind: 'NO_PREMIUM' }; }
    throw e;
  }
  await d.hub.setEntitlements(items);
  await setSetting(d.db, 'premium_shared_ids', JSON.stringify(items.map((i) => i.deviceId)));
  await setSetting(d.db, 'premium_shared_sig', members.join(','));
  await setSetting(d.db, 'premium_shared_at', now.toISOString());
  return { kind: 'DONE', shared: items.length, skipped };
}

const safeList = (s: string): string[] => { try { const v = JSON.parse(s || '[]'); return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []; } catch { return []; } };

/** Other PCs: fetch this PC's Premium from the main PC. Returns what happened (for tests and the UI). Never throws. */
export async function fetchSharedPremium(d: { db: Db; deviceId: string; fetch?: LanFetch; now?: () => Date }): Promise<'INSTALLED' | 'REMOVED' | 'NONE' | 'SKIPPED' | 'UNREACHABLE'> {
  const now = d.now?.() ?? new Date();
  try {
    const cfg = await getNetConfig(d.db);
    if (cfg.mode !== 'client' || !lanActive(cfg)) return 'SKIPPED';
    const shared = (await getSetting(d.db, 'premium_source')) === 'shared';
    // A PC that pays for Premium itself keeps its own; this only fills the gap for PCs without one.
    if (!shared && hasFeature(await loadStatus(d.db, d.deviceId, now), 'CLOUD_SYNC')) return 'SKIPPED';
    let r: { entitlement: string; deviceToken: string | null } | null = null;
    try {
      r = await call(d.fetch ?? tauriLanFetch, { method: 'GET', url: `${cfg.url}/entitlement`, token: cfg.token, deviceId: d.deviceId, timeoutMs: 5000 });
    } catch (e) {
      if (e instanceof LanError && e.code === 'NO_ENTITLEMENT') r = null; else throw e;
    }
    if (!r) {
      if (!shared) return 'NONE';
      await clearToken(d.db); await setSetting(d.db, 'premium_source', '');         // the owner stopped sharing / stopped paying
      return 'REMOVED';
    }
    let status;
    try { status = await installToken(d.db, r.entitlement, d.deviceId, now); }       // verified: signature, this device, not expired
    catch { return 'NONE'; }                                                          // the main PC answered, but with something unusable
    if (status.state !== 'ACTIVE') return 'NONE';
    await setSetting(d.db, 'premium_source', 'shared');
    if (r.deviceToken && !(await getSetting(d.db, 'cloud_device_token'))) await setSetting(d.db, 'cloud_device_token', r.deviceToken);
    return 'INSTALLED';
  } catch { return 'UNREACHABLE'; }
}

/** Runs the right job for this PC every minute (the main PC: share; the others: fetch). Cheap: everything but the cloud call is local. */
export class PremiumRunner {
  private timer: ReturnType<typeof setInterval> | null = null;
  private nextTryAt = 0;                                   // after "no internet", do not retry for 5 minutes
  constructor(private d: { db: Db; deviceId: string; cloud: Pick<CloudClient, 'request'>; hub: HubPort; fetch?: LanFetch; now?: () => Date; onChanged?: () => void }) {}
  start() { if (this.timer) return; void this.tick(); this.timer = setInterval(() => void this.tick(), 60_000); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  async tick(): Promise<void> {
    try {
      const mode = (await getNetConfig(this.d.db)).mode;
      if (mode === 'client') { const r = await fetchSharedPremium(this.d); if (r === 'INSTALLED' || r === 'REMOVED') this.d.onChanged?.(); return; }
      if (mode !== 'host') return;
      const members = (await this.d.hub.status()).devices.filter((x) => !x.revoked && x.deviceId !== this.d.deviceId).map((x) => x.deviceId).sort().join(',');
      const lastSig = await getSetting(this.d.db, 'premium_shared_sig');
      const lastAt = Date.parse((await getSetting(this.d.db, 'premium_shared_at')) || '') || 0;
      const stale = (this.d.now?.() ?? new Date()).getTime() - lastAt >= SHARE_REFRESH_MS;
      const nowMs = (this.d.now?.() ?? new Date()).getTime();
      if ((members !== lastSig || stale) && nowMs >= this.nextTryAt) {      // a new PC gets Premium within a minute; the rest is refreshed every 15 min
        const r = await shareShopPremium(this.d);
        if (r.kind === 'OFFLINE') this.nextTryAt = nowMs + 5 * 60_000;
      }
    } catch { /* never disturbs the app; retried next minute */ }
  }
}
