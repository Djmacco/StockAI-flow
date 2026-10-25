import { TauriDb, type Db } from '../database/db';
import { WebDb } from '../database/web-db';
import { migrate } from '../database/migrations';
import { CloudClient } from '../cloud/client';
import { loadStatus, hasFeature } from '../entitlement/entitlement';
import { seedRoles } from '../services/auth';
import { ensureDeviceId, getSetting } from '../services/settings';
import { backfillSyncQueue } from '../sync/backfill';
import { SyncEngine } from '../sync/engine';
import { CloudBackup } from '../cloud/backup';
import { fromCloud } from '../cloud/map';
import { LanWatcher } from '../lan/live';
import { PremiumRunner } from '../lan/premium';
import { checkHubIdentity, cursorKeyFor, ensureDeviceCode, getNetConfig, hubPull, hubStatus, setHubEntitlements, lanActive, onHubReset, rememberAnchor, resumeHost, routingTransport } from '../lan/network';
import type { RemoteEvent } from '../sync/engine';
import { enable as enableAutostart } from '@tauri-apps/plugin-autostart';

export interface Runtime {
  db: Db;
  /** Cloud backup of the shop (main PC only). */
  backup?: CloudBackup;
  deviceId: string;
/** true inside the Tauri shell (real SQLite file); false in a browser (IndexedDB-persisted SQLite). */
  desktop: boolean;
  cloud: CloudClient;
  sync: SyncEngine;
}

let rt: Promise<Runtime> | null = null;
/** Set by the UI layer; keeps this module free of React / i18n. */
export const runtimeHooks: { onRemote?: (events: RemoteEvent[]) => void; onEntitlementChanged?: () => void } = {};

export const getRuntime = () => (rt ??= boot());
/** Test hook: inject a prepared runtime (in-memory DB) instead of booting Tauri/sql.js. */
export const __setRuntimeForTests = (r: Runtime) => { rt = Promise.resolve(r); };

async function boot(): Promise<Runtime> {
  const desktop = typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
  let db: Db;
  if (desktop) {
    const t = new TauriDb();
    await t.init();
    db = t;
  } else {
    const wasm = (await import('sql.js/dist/sql-wasm.wasm?url')).default as string;
    db = await WebDb.create(wasm);
  }
  await migrate(db);
  await seedRoles(db);
  const deviceId = await ensureDeviceId(db);
  await backfillSyncQueue(db, deviceId);     // older installs: queue staff accounts + shop settings once
  const cloud = new CloudClient(db, deviceId);
  // "Something happened on another PC": the UI subscribes (state/app.ts) and shows a small notification.
  const watcher = new LanWatcher({ db, deviceId, onChange: () => sync.syncNow() });
  // One subscription for the whole shop: the paying main PC shares it, the other PCs pick theirs up over the LAN.
  const premium = new PremiumRunner({ db, deviceId, cloud, hub: { status: hubStatus, setEntitlements: setHubEntitlements }, onChanged: () => runtimeHooks.onEntitlementChanged?.() });
  // Cloud backup of the shop, from the main PC (needs its own Premium and the cloud account).
  const backup = new CloudBackup({
    db, deviceId, hub: { pull: hubPull }, cloud: cloud.transport(),
    ready: async () => {
      if ((await getNetConfig(db)).mode !== 'host') return { ok: false, reason: 'NOT_HOST' };
      const trialExpiry = Date.parse((await getSetting(db, 'cloud_sync_trial_expires_at')) || '');
      const trialActive = Number.isFinite(trialExpiry) && trialExpiry > Date.now();
      if ((!hasFeature(await loadStatus(db, deviceId, new Date()), 'CLOUD_SYNC') || (await getSetting(db, 'premium_source')) === 'shared') && !trialActive) return { ok: false, reason: 'NO_PREMIUM' };
      if (!(await cloud.isConfigured())) return { ok: false, reason: 'NOT_CONFIGURED' };
      if (!(await cloud.hasSession())) return { ok: false, reason: 'NO_ACCOUNT' };
      return { ok: true };
    },
  });
  const live = { start: () => { watcher.start(); premium.start(); backup.start(); }, stop: () => { watcher.stop(); premium.stop(); backup.stop(); } };
  // eslint-disable-next-line prefer-const
  let sync: SyncEngine;
  sync = new SyncEngine({
    live, mapRemote: fromCloud, onRemote: (events) => runtimeHooks.onRemote?.(events),
    db, deviceId, transport: routingTransport(db, deviceId, cloud.transport()),
    cursorKey: () => cursorKeyFor(db),
    ignoreOnlineFlag: async () => lanActive(await getNetConfig(db)),
    checkHub: (i) => checkHubIdentity(db, i),
    afterPull: (tx, page) => rememberAnchor(tx, page),
    onHubReset: () => onHubReset(db),
    // On a shop network (main PC / client) the main PC is the sync partner and no subscription is needed.
    // Otherwise Cloud Sync runs only with a VALID signed entitlement + a cloud account. Local data never depends on it.
    isEnabled: async () => {
      if (lanActive(await getNetConfig(db))) return true;
      const trialExpiry = Date.parse((await getSetting(db, 'cloud_sync_trial_expires_at')) || '');
      const trialActive = Number.isFinite(trialExpiry) && trialExpiry > Date.now();
      return (hasFeature(await loadStatus(db, deviceId, new Date()), 'CLOUD_SYNC') || trialActive)
        && (await cloud.hasSession()) && (await cloud.isConfigured());
    },
    // Restoring from the cloud is FREE: a cloud account is enough (only uploading new changes is Premium).
    // "download everything" (new PC) works from the cloud account or from the shop's main PC
    canRestore: async () => lanActive(await getNetConfig(db)) || ((await cloud.hasSession()) && (await cloud.isConfigured())),
  });
  if (desktop) {
    await resumeHost(db, deviceId);
    if ((await getNetConfig(db)).mode === 'host') { try { await enableAutostart(); } catch (e) { console.warn('Could not register main PC for startup:', e); } }
    await ensureDeviceCode(db, deviceId);
  } // Resume the hub and startup registration for the main PC after sign-in/restart.
  return { db, deviceId, desktop, cloud, sync, backup };
}
