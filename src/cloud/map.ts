import { settingId } from '../services/settings';
import type { ServerRecord } from '../sync/protocol';

/**
 * The cloud API and the desktop name shop settings differently:
 *   desktop  shop_settings   id = a generated id per key, data { key, value, ... }
 *   cloud    app_settings    id = the KEY itself,         data { key, value }   (only an allow-list of keys, see the backend)
 * Everything else has the same name on both sides.
 */
export const CLOUD_SETTING_KEYS: ReadonlySet<string> = new Set(['business_name', 'branch_name', 'expiry_alert_days', 'max_discount_percent', 'payment_methods']);

export interface CloudShape { entityType: string; entityId: string; data: Record<string, any> }

/** Desktop record -> what the cloud accepts, or null when the cloud does not store it (private to this PC, e.g. role permissions). */
export function toCloud(entityType: string, entityId: string, data: Record<string, any>): CloudShape | null {
  if (entityType !== 'shop_settings') return { entityType, entityId, data };
  const key = typeof data.key === 'string' ? data.key : '';
  if (!CLOUD_SETTING_KEYS.has(key)) return null;
  return { entityType: 'app_settings', entityId: key, data: { ...data, id: key, key } };
}

/** Cloud record -> desktop record (used when downloading: a restore, or any pull from the cloud). */
export async function fromCloud(rec: ServerRecord): Promise<ServerRecord> {
  if (rec.entityType !== 'app_settings') return rec;
  const key = rec.entityId;
  const id = await settingId(key);
  return { ...rec, entityType: 'shop_settings', entityId: id, data: { ...rec.data, id, key } };
}
