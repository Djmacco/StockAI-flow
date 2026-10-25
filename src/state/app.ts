import { create } from 'zustand';
import { useMemo } from 'react';
import { type EntitlementStatus, FREE_STATUS, installToken, loadStatus } from '../entitlement/entitlement';
import { getRuntime, runtimeHooks, type Runtime } from '../app/runtime';
import { describeRemote } from '../lan/live';
import { initI18n, translate } from '../i18n';
import { AppError } from '../lib/errors';
import { dataBus } from '../lib/events';
import { formatMoney, type Lang } from '../lib/format';
import { createInitialAdmin, hasAnyUser, login as svcLogin, logout as svcLogout, permissionsForRole } from '../services/auth';
import { autoBackupIfDue } from '../services/backup';
import { issueRecoveryKey } from '../services/recovery';
import { getPending, verifyPayment } from '../cloud/payment';
import type { AppContext, SessionUser } from '../services/context';
import { getAllSettings, setSetting } from '../services/settings';
import type { SyncStatus } from '../sync/engine';
import { getNetConfig, lanActive, recoverShopSaleIntents, syncIntervalFor } from '../lan/network';
import { reserveHubSale, releaseHubSale, LanError } from '../lan/transport';

export interface Toast { id: number; kind: 'success' | 'error' | 'info'; text: string }
export type Theme = 'light' | 'dark';

interface AppState {
  ready: boolean;
  bootError: string | null;
  desktop: boolean;
  setupNeeded: boolean;
  user: SessionUser | null;
  permissions: ReadonlySet<string>;
  lang: Lang;
  theme: Theme;
  settings: Record<string, string>;
  entitlement: EntitlementStatus;
  sync: SyncStatus | null;
  assistantOpen: boolean;
  /** Shown once, right after first setup (blocking screen). */
  recoveryKey: string | null;
  ackRecoveryKey: () => void;
  toasts: Toast[];
  init: () => Promise<void>;
  login: (u: string, p: string) => Promise<void>;
  logout: () => Promise<void>;
  completeSetup: (i: { business_name: string; branch_name: string; full_name: string; username: string; password: string }) => Promise<void>;
  setLang: (l: Lang) => Promise<void>;
  setTheme: (t: Theme) => Promise<void>;
  refreshSettings: () => Promise<void>;
  /** After a restore from the cloud on the first-run screen: accounts now exist, go to the login screen. */
  finishRestore: () => Promise<void>;
  refreshEntitlement: () => Promise<void>;
  refreshSync: () => Promise<void>;
  renewOnline: () => Promise<void>;
  toast: (kind: Toast['kind'], text: string) => void;
  fail: (e: unknown) => void;
  setAssistantOpen: (b: boolean) => void;
}

let runtime: Runtime | null = null;
export const rt = () => runtime!;
let toastId = 0;

// The existing desktop-to-cloud path is a one-way backup from the LAN hub. Until it becomes a
// bidirectional relay, browser edits could never safely return to the shop's authoritative hub.
const WEB_BLOCKED_PERMISSIONS = new Set([
  'products.create', 'products.update', 'products.delete',
  'categories.create', 'categories.update', 'categories.delete',
  'inventory.adjust', 'sales.create', 'sales.cancel', 'purchases.create',
  'customers.create', 'customers.update', 'customers.delete',
  'suppliers.create', 'suppliers.update', 'suppliers.delete', 'expenses.create',
  'users.manage', 'settings.manage', 'backup.manage', 'ai.store_scan',
]);
const permissionsForRuntime = (permissions: ReadonlySet<string>, desktop: boolean) =>
  desktop ? permissions : new Set([...permissions].filter((permission) => !WEB_BLOCKED_PERMISSIONS.has(permission)));

export const useApp = create<AppState>((set, get) => ({
  ready: false, bootError: null, desktop: false, setupNeeded: false, user: null, permissions: new Set(),
  lang: 'fr', theme: 'light', settings: {}, entitlement: FREE_STATUS, sync: null, assistantOpen: false, recoveryKey: null, toasts: [],
  ackRecoveryKey() { set({ recoveryKey: null }); },

  async init() {
    try {
      runtime = await getRuntime();
      // Small notifications for what the other PCs of the shop just did ("Caisse 2 sold R...").
      runtimeHooks.onEntitlementChanged = () => { void get().refreshEntitlement(); };   // Premium arrived from / was withdrawn by the main PC
      runtimeHooks.onRemote = (events) => { const { lang, toast } = get(); for (const m of describeRemote(events, (k, o) => translate(lang, k, o), lang)) toast('info', m); };
      const settings = await getAllSettings(runtime.db);
      const lang: Lang = settings.language === 'en' ? 'en' : 'fr';
      const theme: Theme = settings.theme === 'dark' ? 'dark' : 'light';
      initI18n(lang);
      document.documentElement.lang = lang;
      document.documentElement.dataset.theme = theme;
      set({ ready: true, desktop: runtime.desktop, settings, lang, theme, setupNeeded: !(await hasAnyUser(runtime.db)) });
      await get().refreshEntitlement();
      runtime.sync.subscribe(() => get().refreshSync());
      dataBus.subscribe(() => { void get().refreshSettings(); });   // settings pulled from the cloud show up without a restart
      setInterval(() => get().refreshEntitlement(), 15 * 60_000);
    } catch (e: any) {
      initI18n('fr');
      set({ ready: true, bootError: String(e?.message ?? e) });
    }
  },

  async login(username, password) {
    const r = runtime!;
    const base = ctxBase(null, new Set());
    const user = await svcLogin(base, username, password);
    const permissions = permissionsForRuntime(await permissionsForRole(r.db, user.role_code), r.desktop);
    set({ user, permissions });
    await get().refreshEntitlement();
    r.sync.start(await syncIntervalFor(r.db));
    get().renewOnline();
    if (r.desktop && permissions.has('backup.manage')) autoBackupIfDue(ctxBase(user, permissions)).catch(() => undefined);
  },

  async logout() {
    const { user, permissions } = get();
    runtime!.sync.stop();
    if (user) await svcLogout(ctxBase(user, permissions)).catch(() => undefined);
    set({ user: null, permissions: new Set(), assistantOpen: false });
  },

  async completeSetup(input) {
    const r = runtime!;
    const admin = await createInitialAdmin(ctxBase(null, new Set()), input);
    const permissions = permissionsForRuntime(await permissionsForRole(r.db, admin.role_code), r.desktop);
    const recoveryKey = await issueRecoveryKey(ctxBase(admin, permissions));
    set({ user: admin, permissions, recoveryKey, setupNeeded: false, settings: await getAllSettings(r.db) });
    r.sync.start(await syncIntervalFor(r.db));
  },

  async setLang(lang) {
    await setSetting(runtime!.db, 'language', lang);
    initI18n(lang);
    document.documentElement.lang = lang;
    set({ lang, settings: { ...get().settings, language: lang } });
  },
  async setTheme(theme) {
    await setSetting(runtime!.db, 'theme', theme);
    document.documentElement.dataset.theme = theme;
    set({ theme });
  },
  async refreshSettings() { set({ settings: await getAllSettings(runtime!.db) }); },
  async finishRestore() {
    const r = runtime!;
    set({ setupNeeded: !(await hasAnyUser(r.db)), settings: await getAllSettings(r.db) });
  },

  async refreshEntitlement() {
    const r = runtime!;
    set({ entitlement: await loadStatus(r.db, r.deviceId, new Date()) });
    get().refreshSync();
  },
  async refreshSync() {
    if (runtime) set({ sync: await runtime.sync.getStatus() });
  },

  /** When online with a cloud account: ask the backend for a fresh signed entitlement (renews / revokes). */
  async renewOnline() {
    const r = runtime!;
    try {
      if (!(await r.cloud.isConfigured())) return;
      const pending = await getPending(r.db);
      if (pending) await verifyPayment(r, pending.ref);                       // a payment confirmed while the app was closed
      else if (await r.cloud.getDeviceToken() || await r.cloud.hasSession()) { // silent renewal / revocation check
        if (!r.desktop && await r.cloud.hasSession()) {
          const shared = await r.cloud.shareWebDevice();
          if (shared.deviceToken) await setSetting(r.db, 'cloud_device_token', shared.deviceToken);
          if (shared.entitlement) {
            await installToken(r.db, shared.entitlement, r.deviceId, new Date());
            await setSetting(r.db, 'premium_source', shared.status === 'SHARED' || shared.status === 'ALREADY_SHARED' ? 'shared' : '');
          }
        }
        const s = await r.cloud.subscriptionStatus();
        if (s.entitlement) await installToken(r.db, s.entitlement, r.deviceId, new Date());
      }
      await get().refreshEntitlement();
    } catch { /* offline: the stored signed entitlement keeps working until it expires */ }
  },

  toast(kind, text) {
    const id = ++toastId;
    set({ toasts: [...get().toasts, { id, kind, text }] });
    setTimeout(() => set({ toasts: get().toasts.filter((t) => t.id !== id) }), kind === 'error' ? 7000 : 3500);
  },
  fail(e) { get().toast('error', errorText(e, get().lang)); },
  setAssistantOpen(assistantOpen) { set({ assistantOpen }); },
}));

/** User-facing text for any error: understandable, translated, and reassuring about local data. */
/** Convert persisted transport/backend diagnostics into customer-facing text; raw details stay out of the UI. */
export function syncErrorText(message: string | null | undefined, lang: Lang, shopNetwork = false): string {
  const m = String(message ?? '').toLowerCase();
  const t = (key: string) => translate(lang, key);
  if (/\b401\b|unauthori[sz]ed|session expired|not paired/.test(m)) return t(shopNetwork ? 'network.err.UNAUTHORIZED' : 'subscription.err.AUTH');
  if (/\b(402|403)\b|premium_required|premium is not active/.test(m)) return t('subscription.err.PREMIUM_REQUIRED');
  if (/\b5\d\d\b|\bhttp\s+\d{3}\b|server|rejected/.test(m)) return t('subscription.err.SERVER');
  if (/network|offline|timed? ?out|connection|unreachable|10060|10061|dns|enotfound/.test(m)) return t(shopNetwork ? 'network.err.NETWORK' : 'subscription.err.NETWORK');
  return t('subscription.err.SERVER');
}

export function errorText(e: unknown, lang: Lang): string {
  if (e instanceof AppError) {
    const p: Record<string, any> = { ...e.params };
    if (typeof p.amount === 'number') p.amount = formatMoney(p.amount, lang);
    if (typeof p.due === 'number') p.due = formatMoney(p.due, lang);
    if (typeof p.limit === 'number') p.limit = formatMoney(p.limit, lang);
    return translate(lang, e.key, p);
  }
  const m = String((e as any)?.message ?? e);
  if (m.startsWith('errors.')) return translate(lang, m);
  return translate(lang, 'errors.unexpected');
}

function ctxBase(user: SessionUser | null, permissions: ReadonlySet<string>): AppContext {
  const r = runtime!;
  return {
    db: r.db, deviceId: r.deviceId, user, permissions, now: () => new Date(),
    authorizeShopSale: async (saleId, items) => {
      const net = await getNetConfig(r.db);
      if (net.mode === 'off') return; // standalone/cloud mode has no shared LAN stock.
      if (!lanActive(net)) throw new Error('errors.shopNetworkUnavailable');
      const report = await r.sync.syncNow();
      const status = await r.sync.getStatus();
      if (report.failed || status.pending || status.failed || status.state === 'OFFLINE' || status.state === 'FAILED') {
        throw new Error('errors.shopNetworkUnavailable');
      }
      await recoverShopSaleIntents(r.db, r.deviceId, saleId);
      try { await reserveHubSale(net.url, net.token, r.deviceId, saleId, items); }
      catch (e) {
        if (e instanceof LanError && e.code === 'INSUFFICIENT_STOCK') throw new Error('errors.shopStockChanged');
        throw new Error('errors.shopNetworkUnavailable');
      }
    },
    releaseShopSale: async (saleId) => {
      const net = await getNetConfig(r.db);
      if (lanActive(net)) await releaseHubSale(net.url, net.token, r.deviceId, saleId);
    },
  };
}

export const getCtx = (): AppContext => ctxBase(useApp.getState().user, useApp.getState().permissions);

export function useCtx(): AppContext {
  const user = useApp((s) => s.user);
  const permissions = useApp((s) => s.permissions);
  return useMemo(() => ctxBase(user, permissions), [user, permissions]);
}

export const useCan = () => {
  const p = useApp((s) => s.permissions);
  return (perm: string) => p.has(perm);
};
