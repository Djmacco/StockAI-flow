import type { Db } from '../database/db';
import { uuid } from '../lib/ids';
import { insertRow, stripLocal } from '../services/repo';
import { SHOP_KEYS, settingId } from '../services/settings';

/**
 * Installs that existed before staff accounts / shop settings became syncable: put their current rows in the sync queue
 * (once; safe to run at every start). Rows already queued or already synced are left alone.
 */
export async function backfillSyncQueue(db: Db, deviceId: string, now: () => Date = () => new Date()): Promise<{ users: number; settings: number }> {
  const ctx = { db, deviceId, user: null, permissions: new Set<string>(), now };
  return db.transaction(async (tx) => {
    // A blank install (no accounts yet) has nothing of its own to upload. Backfilling DEFAULT values there would later
    // overwrite the real shop settings when the owner restores from the cloud.
    if (!(await tx.selectOne('SELECT 1 x FROM users WHERE deleted_at IS NULL LIMIT 1'))) return { users: 0, settings: 0 };
    let settings = 0;
    // 1. shop settings: one synced row per key that this shop has actually set
    const present = await tx.select<{ key: string; value: string | null }>('SELECT key, value FROM app_settings');
    for (const r of present) {
      if (!SHOP_KEYS.has(r.key) || r.value == null) continue;
      const exists = await tx.selectOne('SELECT 1 x FROM shop_settings WHERE key = ?', [r.key]);
      if (!exists) { await insertRow(tx, ctx, 'shop_settings', { key: r.key, value: r.value }, await settingId(r.key)); settings++; }
    }
    // role permissions snapshot (only if the administrator ever customised them, i.e. they differ from the defaults)
    // -> simplest correct rule: snapshot whenever it is missing and roles exist.
    if (!(await tx.selectOne("SELECT 1 x FROM shop_settings WHERE key = 'role_permissions'"))) {
      const rows = await tx.select<{ role_code: string; permission: string }>("SELECT role_code, permission FROM role_permissions WHERE role_code <> 'ADMIN' ORDER BY role_code, permission");
      if (rows.length) {
        const snap: Record<string, string[]> = { MANAGER: [], CASHIER: [] };
        rows.forEach((x) => (snap[x.role_code] ??= []).push(x.permission));
        await insertRow(tx, ctx, 'shop_settings', { key: 'role_permissions', value: JSON.stringify(snap) }, await settingId('role_permissions'));
        settings++;
      }
    }
    // 2. staff accounts that were never queued
    const users = await tx.select<Record<string, any>>(
      `SELECT * FROM users u WHERE u.sync_status = 'PENDING' AND NOT EXISTS
         (SELECT 1 FROM sync_queue q WHERE q.entity_type = 'users' AND q.entity_id = u.id AND q.status IN ('PENDING','SYNCING','FAILED'))`);
    for (const u of users) {
      await tx.execute(
        `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, base_version, created_at, status) VALUES (?,?,?,?,?,?,?, 'PENDING')`,
        [uuid(), 'users', u.id, u.deleted_at ? 'DELETE' : 'CREATE', JSON.stringify(stripLocal('users', u)), 0, now().toISOString()]);
    }
    return { users: users.length, settings };
  });
}
