import type { Db, SqlValue } from '../database/db';
import { uuid } from '../lib/ids';
import type { AppContext } from './context';

/**
 * Generic row helpers. They guarantee that EVERY write
 *  1. sets id / timestamps / device / version / sync_status,
 *  2. lands in the sync queue (coalesced per entity),
 * so no service can forget either.
 */
export const SYNC_TABLES = [
  'users', 'shop_settings',
  'categories', 'suppliers', 'customers', 'products', 'product_batches', 'stock_movements',
  'cash_sessions', 'sales', 'sale_items', 'customer_payments', 'purchases', 'purchase_items',
  'supplier_payments', 'expenses', 'audit_log',
  'stock_counts', 'stock_count_items', 'documents', 'document_items',
] as const;
export type SyncTable = (typeof SYNC_TABLES)[number];
const SYNCED = new Set<string>(SYNC_TABLES);

type Row = Record<string, any>;

/** Per-device state that must never travel to the cloud (or be overwritten by it). */
export const LOCAL_ONLY_COLUMNS: Record<string, string[]> = { users: ['failed_attempts', 'locked_until', 'last_login_at'] };
export const stripLocal = (table: string, row: Row): Row => {
  const cols = LOCAL_ONLY_COLUMNS[table];
  if (!cols) return row;
  const out = { ...row }; for (const c of cols) delete out[c];
  return out;
};
const nowIso = (ctx: AppContext) => ctx.now().toISOString();

export async function insertRow<T = Row>(tx: Db, ctx: AppContext, table: string, data: Row, id = uuid()): Promise<T> {
  const ts = nowIso(ctx);
  const row: Row = {
    id, created_at: ts, updated_at: ts, device_id: ctx.deviceId, version: 1, sync_status: 'PENDING', deleted_at: null,
    ...data,
  };
  const cols = Object.keys(row);
  await tx.execute(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    cols.map((c) => row[c] as SqlValue),
  );
  await enqueue(tx, ctx, table, 'CREATE', row, 0);
  return row as T;
}

export async function updateRow<T = Row>(tx: Db, ctx: AppContext, table: string, id: string, patch: Row): Promise<T> {
  const current = await tx.selectOne<Row>(`SELECT * FROM ${table} WHERE id = ?`, [id]);
  if (!current) throw new Error(`${table}/${id} not found`);
  const next: Row = {
    ...current, ...patch, updated_at: nowIso(ctx), device_id: ctx.deviceId, version: current.version + 1, sync_status: 'PENDING',
  };
  const keys = Object.keys(patch).concat(['updated_at', 'device_id', 'version', 'sync_status']);
  await tx.execute(
    `UPDATE ${table} SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`,
    [...keys.map((k) => next[k] as SqlValue), id],
  );
  const base = current.sync_status === 'SYNCED' ? current.version : undefined;
  await enqueue(tx, ctx, table, next.deleted_at ? 'DELETE' : 'UPDATE', next, base);
  return next as T;
}

export const softDelete = (tx: Db, ctx: AppContext, table: string, id: string) =>
  updateRow(tx, ctx, table, id, { deleted_at: nowIso(ctx) });

/**
 * Add / coalesce a sync-queue entry. Entries already being sent (SYNCING) are never
 * touched; a new entry is added so the later edit is pushed on the next round.
 */
async function enqueue(tx: Db, ctx: AppContext, table: string, op: 'CREATE' | 'UPDATE' | 'DELETE', row: Row, baseVersion: number | undefined) {
  if (!SYNCED.has(table)) return;
  const payload = JSON.stringify(stripLocal(table, row));
  const existing = await tx.selectOne<Row>(
    `SELECT * FROM sync_queue WHERE entity_type = ? AND entity_id = ? AND status IN ('PENDING','FAILED')
     ORDER BY created_at DESC LIMIT 1`,
    [table, row.id],
  );
  if (existing) {
    // A record that was never sent stays a CREATE (even if later edited or deleted).
    const operation = existing.operation === 'CREATE' ? 'CREATE' : op;
    await tx.execute(
      `UPDATE sync_queue SET operation = ?, payload = ?, status = 'PENDING', error_message = NULL,
         next_attempt_at = NULL, retry_count = 0 WHERE id = ?`,
      [operation, payload, existing.id],
    );
    return;
  }
  await tx.execute(
    `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, base_version, created_at, status)
     VALUES (?,?,?,?,?,?,?, 'PENDING')`,
    [uuid(), table, row.id, op, payload, baseVersion ?? Math.max(0, (row.version as number) - 1), nowIso(ctx)],
  );
}

export const getById = <T = Row>(db: Db, table: string, id: string) =>
  db.selectOne<T>(`SELECT * FROM ${table} WHERE id = ? AND deleted_at IS NULL`, [id]);
