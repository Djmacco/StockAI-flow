import type { TauriDb } from '../database/db';
import { fail } from '../lib/errors';
import { audit } from './audit';
import { type AppContext, requirePermission, runTx } from './context';
import { getSetting, setSetting } from './settings';

/** Local backup / restore. Only available in the desktop app (the file lives in Rust's SQLite connection). */
export interface DbInfo { path: string; size_bytes: number; backups_dir: string }
export interface BackupFile { name: string; path: string; size_bytes: number }

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, '-').slice(0, 19);
const tauriDb = (ctx: AppContext): TauriDb => {
  const db = ctx.db as any;
  if (typeof db.command !== 'function') return fail('errors.backupDesktopOnly');
  return db as TauriDb;
};

export async function backupStatus(ctx: AppContext) {
  requirePermission(ctx, 'backup.manage');
  const last = await getSetting(ctx.db, 'last_backup_at');
  let info: DbInfo | null = null; let files: BackupFile[] = [];
  try { const db = tauriDb(ctx); info = await db.command<DbInfo>('db_info'); files = await db.command<BackupFile[]>('db_list_backups'); } catch { /* browser preview */ }
  return { lastBackupAt: last || null, info, files };
}

/** Export a copy to a location chosen by the user. */
export async function exportBackup(ctx: AppContext): Promise<string | null> {
  requirePermission(ctx, 'backup.manage');
  const db = tauriDb(ctx);
  const { save } = await import('@tauri-apps/plugin-dialog');
  const dest = await save({ defaultPath: `stockflow-${stamp(ctx.now())}.db`, filters: [{ name: 'StockFlow backup', extensions: ['db'] }] });
  if (!dest) return null;
  await db.command('db_backup', { dest });
  await setSetting(ctx.db, 'last_backup_at', ctx.now().toISOString());
  await runTx(ctx, (tx) => audit(tx, ctx, 'backup.exported', 'backup', undefined, { dest }));
  return dest;
}

/** Automatic daily safety copy inside the app folder (keeps the newest 14). */
export async function autoBackupIfDue(ctx: AppContext): Promise<void> {
  const last = await getSetting(ctx.db, 'last_backup_at');
  if (last && ctx.now().getTime() - new Date(last).getTime() < 24 * 3600 * 1000) return;
  const db = tauriDb(ctx);
  await db.command('db_auto_backup', { stamp: stamp(ctx.now()), keep: 14 });
  await setSetting(ctx.db, 'last_backup_at', ctx.now().toISOString());
}

/** Choose a file to restore. The caller MUST show a confirmation first: restoring replaces current data. */
export async function pickRestoreFile(): Promise<string | null> {
  const { open } = await import('@tauri-apps/plugin-dialog');
  const f = await open({ multiple: false, filters: [{ name: 'StockFlow backup', extensions: ['db'] }] });
  return typeof f === 'string' ? f : null;
}

/** Validates the file, saves a safety copy of the current data, then restores. Returns the safety-copy path. */
export async function restoreBackup(ctx: AppContext, srcPath: string): Promise<string> {
  requirePermission(ctx, 'backup.manage');
  const db = tauriDb(ctx);
  try {
    return await db.command<string>('db_restore', { src: srcPath, stamp: stamp(ctx.now()) });
  } catch (e: any) {
    if (String(e).includes('invalid_backup')) fail('errors.invalidBackup');
    throw e;
  }
}
