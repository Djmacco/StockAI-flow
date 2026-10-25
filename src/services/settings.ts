import type { Db } from '../database/db';
import { uuid } from '../lib/ids';
import { audit } from './audit';
import { type AppContext, requirePermission, runTx } from './context';
import { PERMISSIONS } from './permissions';
import { insertRow, updateRow } from './repo';

export interface PaymentMethodCfg { code: string; label_fr: string; label_en: string; enabled: boolean }

export const DEFAULT_PAYMENT_METHODS: PaymentMethodCfg[] = [
  { code: 'CASH', label_fr: 'Espèces', label_en: 'Cash', enabled: true },
  { code: 'MOBILE_MONEY', label_fr: 'Mobile Money', label_en: 'Mobile Money', enabled: true },
  { code: 'CARD', label_fr: 'Carte', label_en: 'Card', enabled: true },
  { code: 'OTHER', label_fr: 'Autre', label_en: 'Other', enabled: true },
];

export const SETTING_DEFAULTS = {
  language: 'fr',
  theme: 'light',
  business_name: 'Mon commerce',
  branch_name: 'Agence principale',
  receipt_tagline: 'Vente en gros et en détail',
  business_phone: '',
  business_address: '',
  receipt_footer: 'Merci de votre visite !',
  receipt_logo: '',          // optional data-URL (monochrome PNG)
  receipt_show_time: '1',
  payment_methods: JSON.stringify(DEFAULT_PAYMENT_METHODS),
  expiry_alert_days: JSON.stringify([30, 7, 1]),
  default_minimum_stock: '5',
  max_discount_percent: '100',
  setup_completed: '0',
  cloud_api_url: '',
  last_backup_at: '',
  business_tax_id: '',
  tax_rate: '0',
  invoice_prefix: 'FAC',
  proforma_prefix: 'PRO',
  proforma_valid_days: '30',
  invoice_notes: '',
} as const;
export type SettingKey = keyof typeof SETTING_DEFAULTS | 'device_id' | 'entitlement' | 'cloud_session'
  | 'cloud_device_token' | 'pending_payment' | 'last_restore_at' | 'recovery_hash' | 'recovery_salt' | 'recovery_iter' | 'recovery_created_at' | 'recovery_failed' | 'recovery_locked_until'
  | 'net_mode' | 'net_hub_url' | 'net_token' | 'net_port' | 'net_error' | 'net_hub_id' | 'net_anchor' | 'net_notice' | 'net_device_code' | 'premium_source' | 'premium_shared_at' | 'premium_shared_ids' | 'premium_shared_sig'
  | 'backup_cursor' | 'backup_head' | 'backup_hub_id' | 'backup_last_at' | 'backup_error' | 'backup_rejected' | 'backup_skipped' | 'sync_cursor_lan' | 'cloud_sync_trial_expires_at'
  | 'sync_cursor' | 'last_sync_at' | 'last_seen_time' | 'sync_last_error' | 'receipt_counter' | 'purchase_counter' | 'tax_rate' | 'invoice_prefix' | 'proforma_prefix' | 'proforma_valid_days' | 'business_tax_id' | 'invoice_notes';

export async function getSetting(db: Db, key: SettingKey): Promise<string> {
  const r = await db.selectOne<{ value: string | null }>('SELECT value FROM app_settings WHERE key = ?', [key]);
  if (r && r.value !== null) return r.value;
  return (SETTING_DEFAULTS as Record<string, string>)[key] ?? '';
}

export async function setSetting(db: Db, key: SettingKey, value: string): Promise<void> {
  await db.execute(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [key, value, new Date().toISOString()],
  );
}

export async function getAllSettings(db: Db): Promise<Record<string, string>> {
  const rows = await db.select<{ key: string; value: string }>('SELECT key, value FROM app_settings');
  const out: Record<string, string> = { ...SETTING_DEFAULTS };
  rows.forEach((r) => (out[r.key] = r.value));
  return out;
}

/** Stable per-installation identifier, created on first launch. */
export async function ensureDeviceId(db: Db): Promise<string> {
  const existing = await db.selectOne<{ value: string }>("SELECT value FROM app_settings WHERE key = 'device_id'");
  if (existing?.value) return existing.value;
  const id = uuid();
  await setSetting(db, 'device_id', id);
  return id;
}

export async function getPaymentMethods(db: Db): Promise<PaymentMethodCfg[]> {
  try {
    const list = JSON.parse(await getSetting(db, 'payment_methods')) as PaymentMethodCfg[];
    return list.length ? list : DEFAULT_PAYMENT_METHODS;
  } catch {
    return DEFAULT_PAYMENT_METHODS;
  }
}

/** Atomic sequential number, e.g. next('receipt_counter') -> 42. */
export async function nextCounter(db: Db, key: 'receipt_counter' | 'purchase_counter'): Promise<number> {
  const cur = parseInt((await db.selectOne<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [key]))?.value ?? '0', 10);
  const next = cur + 1;
  await setSetting(db, key, String(next));
  return next;
}

/** Atomic per-device sequence for count, invoice and proforma numbering. */
export async function nextSequence(db: Db, key: string): Promise<number> {
  const cur = parseInt((await db.selectOne<{ value: string }>('SELECT value FROM app_settings WHERE key = ?', [key]))?.value ?? '0', 10);
  const next = (Number.isFinite(cur) ? cur : 0) + 1;
  await db.execute('INSERT INTO app_settings (key,value,updated_at) VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=excluded.updated_at', [key, String(next), new Date().toISOString()]);
  return next;
}
// =================================================================== shop settings that travel with the business
/**
 * Keys describing THE SHOP (shared by every PC of the business, restored on a new PC).
 * Everything else (language, theme, counters, cloud session, entitlement, backup stamps, recovery key...)
 * stays on the device on purpose.
 */
export const SHOP_KEYS: ReadonlySet<string> = new Set([
  'business_name', 'branch_name', 'receipt_tagline', 'business_phone', 'business_address', 'receipt_footer', 'receipt_logo', 'receipt_show_time',
  'payment_methods', 'expiry_alert_days', 'default_minimum_stock', 'max_discount_percent',
  'role_permissions', 'business_tax_id', 'tax_rate', 'invoice_prefix', 'proforma_prefix', 'proforma_valid_days', 'invoice_notes',
]);

/** Deterministic UUID (v5-style, SHA-1) per key: two PCs that set the same key create the SAME row id, so they merge instead of duplicating. */
export async function settingId(key: string): Promise<string> {
  const data = new TextEncoder().encode(`stockflow.shop_settings:${key}`);
  const h = new Uint8Array(await crypto.subtle.digest('SHA-1', data)).slice(0, 16);
  h[6] = (h[6] & 0x0f) | 0x50; h[8] = (h[8] & 0x3f) | 0x80;
  const x = [...h].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

async function putLocal(db: Db, key: string, value: string, now: string) {
  await db.execute(
    `INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`, [key, value, now]);
}

/** Write a shop-level setting: the local value (what the app reads) AND the synced row. Returns true when something changed. */
export async function setShopSetting(tx: Db, ctx: AppContext, key: string, value: string): Promise<boolean> {
  if (!SHOP_KEYS.has(key)) throw new Error(`not a shop setting: ${key}`);
  const row = await tx.selectOne<{ id: string; value: string | null; deleted_at: string | null }>('SELECT id, value, deleted_at FROM shop_settings WHERE key = ?', [key]);
  const local = await tx.selectOne<{ value: string | null }>('SELECT value FROM app_settings WHERE key = ?', [key]);
  if (row && !row.deleted_at && row.value === value && local?.value === value) return false;
  await putLocal(tx, key, value, ctx.now().toISOString());
  if (row) await updateRow(tx, ctx, 'shop_settings', row.id, { value, deleted_at: null });
  else await insertRow(tx, ctx, 'shop_settings', { key, value }, await settingId(key));
  return true;
}

/** Settings > General "Save": one transaction, one audit entry, only changed keys travel. */
export async function saveShopSettings(ctx: AppContext, entries: Record<string, string>): Promise<string[]> {
  requirePermission(ctx, 'settings.manage');
  return runTx(ctx, async (tx) => {
    const changed: string[] = [];
    for (const [k, v] of Object.entries(entries)) if (SHOP_KEYS.has(k) && (await setShopSetting(tx, ctx, k, v))) changed.push(k);
    if (changed.length) await audit(tx, ctx, 'settings.updated', 'settings', undefined, { keys: changed });
    return changed;
  });
}

/** Role permissions as one synced setting (MANAGER / CASHIER; the administrator always has everything). */
export async function snapshotRolePermissions(tx: Db, ctx: AppContext): Promise<void> {
  const rows = await tx.select<{ role_code: string; permission: string }>("SELECT role_code, permission FROM role_permissions WHERE role_code <> 'ADMIN' ORDER BY role_code, permission");
  const snap: Record<string, string[]> = { MANAGER: [], CASHIER: [] };
  rows.forEach((r) => (snap[r.role_code] ??= []).push(r.permission));
  await setShopSetting(tx, ctx, 'role_permissions', JSON.stringify(snap));
}

/** A synced settings row arrived from the cloud: make it effective locally (called by the sync engine). */
export async function applyRemoteSetting(tx: Db, row: { key?: string; value?: string | null; deleted_at?: string | null }): Promise<void> {
  if (!row.key || !SHOP_KEYS.has(row.key) || row.deleted_at || row.value == null) return; // unknown keys from newer versions are ignored
  await putLocal(tx, row.key, row.value, new Date().toISOString());
  if (row.key === 'role_permissions') {
    let snap: Record<string, string[]>;
    try { snap = JSON.parse(row.value); } catch { return; }
    const valid = new Set<string>(PERMISSIONS);
    for (const role of ['MANAGER', 'CASHIER']) {
      if (!Array.isArray(snap[role])) continue;
      await tx.execute('DELETE FROM role_permissions WHERE role_code = ?', [role]);
      for (const p of snap[role]) if (valid.has(p)) await tx.execute('INSERT OR IGNORE INTO role_permissions (role_code, permission) VALUES (?,?)', [role, p]);
    }
  }
}
