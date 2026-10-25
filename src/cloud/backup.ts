import type { Db } from '../database/db';
import { getSetting, setSetting } from '../services/settings';
import { type PullResponse, type PushChange, type PushResult, type ServerRecord, type SyncTransport, SyncTransportError } from '../sync/protocol';
import { toCloud } from './map';

/**
 * CLOUD BACKUP OF THE SHOP, FROM THE MAIN PC.
 * The main PC reads the shop's own change log (the hub) and copies it to the cloud account. One direction only: the shop is the
 * authority, so nothing is merged back and a cloud problem can never change shop data. The cloud keeps its own version numbers
 * (they are not the shop's), remembered per record. Safe to stop at any time and to repeat: every change has a stable id.
 *   - cloud says CONFLICT (it holds another version, e.g. after a restore): adopt its version and send ours on top (the shop wins).
 *   - cloud says REJECTED: counted and shown, never retried forever, never blocks the rest.
 *   - no internet: nothing is lost, the position stays where it was.
 */
export type BackupWhy = 'NOT_HOST' | 'NO_PREMIUM' | 'NO_ACCOUNT' | 'NOT_CONFIGURED';
export type BackupResult =
  | { kind: 'DONE'; sent: number; skipped: number; rejected: number }
  | { kind: 'WAITING'; why: BackupWhy | 'OFFLINE' }
  | { kind: 'ERROR'; message: string };

export interface BackupDeps {
  db: Db;
  deviceId: string;
  /** A page of the main PC's own change log. */
  hub: { pull: (since: string, limit: number) => Promise<PullResponse> };
  cloud: SyncTransport;
  /** Is this PC allowed to back up right now (main PC, own Premium, cloud account)? */
  ready: () => Promise<{ ok: true } | { ok: false; reason: BackupWhy }>;
  now?: () => Date;
  batchSize?: number;
}

export interface BackupStatus { lastAt: string | null; waiting: number; rejected: number; skipped: number; error: string }
export async function getBackupStatus(db: Db): Promise<BackupStatus> {
  const cursor = Number((await getSetting(db, 'backup_cursor')) || 0), head = Number((await getSetting(db, 'backup_head')) || 0);
  return {
    lastAt: (await getSetting(db, 'backup_last_at')) || null, waiting: Math.max(0, head - cursor),
    rejected: Number((await getSetting(db, 'backup_rejected')) || 0), skipped: Number((await getSetting(db, 'backup_skipped')) || 0), error: await getSetting(db, 'backup_error'),
  };
}

async function sha1Hex(s: string): Promise<string> {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-1', new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export class CloudBackup {
  private running: Promise<BackupResult> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  constructor(private d: BackupDeps) {}

  start(everyMs = 60_000) { if (this.timer) return; void this.run(); this.timer = setInterval(() => void this.run(), everyMs); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  run(): Promise<BackupResult> {
    if (this.running) return this.running;
    this.running = this.once().catch((e): BackupResult => ({ kind: 'ERROR', message: String(e?.message ?? e) })).finally(() => { this.running = null; });
    return this.running;
  }

  private async ensureTable() {
    await this.d.db.execute('CREATE TABLE IF NOT EXISTS cloud_backup_versions (entity_type TEXT NOT NULL, entity_id TEXT NOT NULL, version INTEGER NOT NULL, PRIMARY KEY (entity_type, entity_id))');
  }

  private async once(): Promise<BackupResult> {
    const { db } = this.d;
    const ready = await this.d.ready();
    if (!ready.ok) return { kind: 'WAITING', why: ready.reason };
    await this.ensureTable();
    let cursor = (await getSetting(db, 'backup_cursor')) || '0';
    let hubId = await getSetting(db, 'backup_hub_id');
    let sent = 0, skipped = 0, rejected = 0, first = true; let lastRejection = '';
    try {
      for (;;) {
        const page = await this.d.hub.pull(cursor, 200);
        // The shop's log is not the one our position belongs to (another main PC, or restored from a backup): start from the beginning.
        // Cloud versions are kept, so this only re-sends what the cloud lacks (the rest is recognised and skipped).
        if (first) {
          first = false;
          if (cursor !== '0' && ((hubId && page.hubId && hubId !== page.hubId) || (page.head !== undefined && Number(page.head) < Number(cursor)))) {
            cursor = '0'; await setSetting(db, 'backup_cursor', '0'); continue;
          }
          if (page.hubId) { hubId = page.hubId; await setSetting(db, 'backup_hub_id', hubId); }
        }
        const r = await this.sendPage(page.records);
        sent += r.sent; skipped += r.skipped; rejected += r.rejected; if (r.lastRejection) lastRejection = r.lastRejection;
        cursor = page.nextCursor;
        await setSetting(db, 'backup_cursor', cursor); await setSetting(db, 'backup_head', page.head ?? cursor);
        if (!page.hasMore) break;
      }
    } catch (e) {
      if (e instanceof SyncTransportError && e.kind === 'NETWORK') return { kind: 'WAITING', why: 'OFFLINE' };   // nothing wrong: try again later
      await setSetting(db, 'backup_error', String((e as Error).message ?? e).slice(0, 300));
      return { kind: 'ERROR', message: String((e as Error).message ?? e) };
    }
    const prevRejected = Number((await getSetting(db, 'backup_rejected')) || 0), prevSkipped = Number((await getSetting(db, 'backup_skipped')) || 0);
    await setSetting(db, 'backup_rejected', String(prevRejected + rejected)); await setSetting(db, 'backup_skipped', String(prevSkipped + skipped));
    await setSetting(db, 'backup_error', rejected > 0 ? lastRejection : '');   // refused rows stay visible, with the cloud's reason
    await setSetting(db, 'backup_last_at', (this.d.now?.() ?? new Date()).toISOString());
    return { kind: 'DONE', sent, skipped, rejected };
  }

  /** Send one page of the shop's log. Changes of the same record go in separate requests so each one is based on the previous result. */
  private async sendPage(records: ServerRecord[]): Promise<{ sent: number; skipped: number; rejected: number; lastRejection: string }> {
    const { db } = this.d; let sent = 0, skipped = 0, rejected = 0; let lastRejection = '';
    const ids = [...new Set(records.map((r) => r.entityId))];
    const known = new Map<string, number>();
    for (let i = 0; i < ids.length; i += 200) {
      const chunk = ids.slice(i, i + 200);
      for (const row of await db.select<{ entity_type: string; entity_id: string; version: number }>(`SELECT entity_type, entity_id, version FROM cloud_backup_versions WHERE entity_id IN (${chunk.map(() => '?').join(',')})`, chunk)) known.set(`${row.entity_type}:${row.entity_id}`, row.version);
    }
    const dirty = new Map<string, { type: string; id: string; version: number }>();
    const remember = (type: string, id: string, version: number) => { known.set(`${type}:${id}`, version); dirty.set(`${type}:${id}`, { type, id, version }); };

    // group into requests of unique records, at most `batchSize` changes each
    const groups: { rec: ServerRecord; shape: NonNullable<ReturnType<typeof toCloud>> }[][] = [[]];
    let seen = new Set<string>();
    for (const rec of records) {
      const shape = toCloud(rec.entityType, rec.entityId, rec.data);
      if (!shape) { skipped++; continue; }
      const k = `${shape.entityType}:${shape.entityId}`; const cur = groups[groups.length - 1];
      if (seen.has(k) || cur.length >= (this.d.batchSize ?? 50)) { groups.push([]); seen = new Set(); }
      seen.add(k); groups[groups.length - 1].push({ rec, shape });
    }

    for (const g of groups) {
      if (!g.length) continue;
      const build = async (): Promise<PushChange[]> => Promise.all(g.map(async ({ rec, shape }) => ({
        opId: `bk-${(rec as ServerRecord & { cursor?: string }).cursor ?? ''}-${(await sha1Hex(`${shape.entityType}|${shape.entityId}|${rec.version}|${JSON.stringify(shape.data)}`)).slice(0, 20)}`,
        entityType: shape.entityType, entityId: shape.entityId,
        operation: rec.deleted ? 'DELETE' : rec.version <= 1 ? 'CREATE' : 'UPDATE',
        baseVersion: known.get(`${shape.entityType}:${shape.entityId}`) ?? 0, data: shape.data,
      })));
      let changes = await build();
      for (let attempt = 0; attempt < 2 && changes.length; attempt++) {
        const res = (await this.d.cloud.push({ deviceId: this.d.deviceId, changes })).results;
        const retry: PushChange[] = [];
        for (const r of res as PushResult[]) {
          const ch = changes.find((c) => c.opId === r.opId); if (!ch) continue;
          if ((r.status === 'ACCEPTED' || r.status === 'DUPLICATE') && r.version !== undefined) { remember(ch.entityType, ch.entityId, r.version); sent++; }
          else if (r.status === 'ACCEPTED' || r.status === 'DUPLICATE') sent++;
          else if (r.status === 'CONFLICT' && attempt === 0 && r.serverRecord) { remember(ch.entityType, ch.entityId, r.serverRecord.version); retry.push({ ...ch, baseVersion: r.serverRecord.version }); }
          else { rejected++; if (r.error) lastRejection = `${ch.entityType}: ${r.error}`.slice(0, 300); }
        }
        changes = retry;                                       // the shop wins: re-send on top of the cloud's version, once
      }
      rejected += changes.length;                              // still conflicting after the retry
    }
    await db.transaction(async (tx) => {
      for (const v of dirty.values()) await tx.execute('INSERT INTO cloud_backup_versions (entity_type, entity_id, version) VALUES (?,?,?) ON CONFLICT(entity_type, entity_id) DO UPDATE SET version = excluded.version', [v.type, v.id, v.version]);
    });
    return { sent, skipped, rejected, lastRejection };
  }
}
