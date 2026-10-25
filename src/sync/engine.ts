import type { Db } from '../database/db';
import { dataBus } from '../lib/events';
import { uuid } from '../lib/ids';
import { SYNC_TABLES, stripLocal, updateRow } from '../services/repo';
import { applyRemoteSetting, getSetting, setSetting } from '../services/settings';
import { resolveConflict } from './conflict';
import { type PullResponse, type PushChange, type PushResult, type ServerRecord, type SyncTransport, SyncTransportError } from './protocol';

export type SyncState = 'DISABLED' | 'OFFLINE' | 'IDLE' | 'SYNCING' | 'FAILED';
export interface SyncStatus {
  state: SyncState;
  reason: string | null;
  pending: number;
  failed: number;
  conflicts: number;
  lastSyncAt: string | null;
  lastError: string | null;
}
/** Something another PC of the shop just did (shop network only), for the small notifications. */
export interface RemoteEvent { kind: 'SALE' | 'CANCEL' | 'STOCK'; who: string; receipt?: string; total?: number; product?: string; qty?: number }
export interface SyncReport { pushed: number; pulled: number; conflicts: number; failed: number }

export interface EngineDeps {
  db: Db;
  deviceId: string;
  transport: SyncTransport;
  /** Automatic two-way sync: Premium entitlement + cloud account present? */
  isEnabled: () => Promise<boolean>;
  /** Free "restore from cloud" (download only): a cloud account is enough, no subscription. */
  canRestore?: () => Promise<boolean>;
  /** Which setting holds this partner's change cursor (cloud vs. shop hub). Default: the cloud's. */
  cursorKey?: () => Promise<'sync_cursor' | 'sync_cursor_lan'>;
  isOnline?: () => boolean;
  /** Translates a record from the partner's naming to ours (the cloud names shop settings differently). */
  mapRemote?: (rec: ServerRecord) => Promise<ServerRecord>;
  /** Receives what other PCs did since the last pull (never during a first download or a full restore). */
  onRemote?: (events: RemoteEvent[]) => void;
  /** Keeps a request open on the main PC so news arrives at once (started and stopped together with the engine). */
  live?: { start(): void; stop(): void };
  /** Called with the first page of every pull: 'reset' = the partner is not the store this cursor belongs to (replaced, or restored from an older backup). */
  checkHub?: (i: { hubId?: string; head?: string; cursor: string; anchor?: PullResponse['anchor'] }) => Promise<'ok' | 'reset'>;
  /** Runs inside the same transaction that saves the new cursor (so both always agree). */
  afterPull?: (tx: Db, page: PullResponse) => Promise<void>;
  /** After a 'reset': queue everything this PC holds so the partner gets back what it lost. */
  onHubReset?: () => Promise<void>;
  /** On a shop network the partner is on the LAN: the browser's "has internet" flag must not stop syncing. */
  ignoreOnlineFlag?: () => Promise<boolean>;
  now?: () => Date;
  batchSize?: number;
}

const PERMANENT = '9999-12-31T00:00:00.000Z';
type Row = Record<string, any>;
const tables = new Set<string>(SYNC_TABLES);

export class SyncEngine {
  private running: Promise<SyncReport> | null = null;
  private again = false;          // a round was requested while one was running
  private lastRoundOk = false;
  private state: SyncState = 'IDLE';
  private reason: string | null = null;
  private listeners = new Set<() => void>();
  private colCache = new Map<string, string[]>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  /** Notable remote changes of the pull in progress (null while downloading history). */
  private events: RemoteEvent[] | null = null;
  private unsub: (() => void) | null = null;

  constructor(private d: EngineDeps) {}

  private now = () => (this.d.now ? this.d.now() : new Date());
  private online = async () => (await this.d.ignoreOnlineFlag?.()) || (this.d.isOnline ? this.d.isOnline() : typeof navigator === 'undefined' || navigator.onLine !== false);

  subscribe(fn: () => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  private setState(s: SyncState, reason: string | null = null) {
    this.state = s; this.reason = reason; this.listeners.forEach((l) => l());
  }

  async getStatus(): Promise<SyncStatus> {
    const c = await this.d.db.selectOne<{ p: number; f: number }>(
      "SELECT SUM(status IN ('PENDING','SYNCING')) p, SUM(status = 'FAILED') f FROM sync_queue");
    const conflicts = (await this.d.db.selectOne<{ n: number }>("SELECT COUNT(*) n FROM sync_conflicts WHERE status = 'OPEN'"))?.n ?? 0;
    return {
      state: this.state, reason: this.reason, pending: c?.p ?? 0, failed: c?.f ?? 0, conflicts,
      lastSyncAt: (await getSetting(this.d.db, 'last_sync_at')) || null, lastError: (await getSetting(this.d.db, 'sync_last_error')) || null,
    };
  }

  /** After a crash an entry can be stuck in SYNCING: put it back in the queue. Nothing is lost. */
  async resetStuck() {
    await this.d.db.execute("UPDATE sync_queue SET status = 'PENDING' WHERE status = 'SYNCING'");
  }

  /** Manual "retry now": clears back-off and permanent-failure marks. */
  async retryFailed() {
    await this.d.db.execute("UPDATE sync_queue SET status = 'PENDING', next_attempt_at = NULL, retry_count = 0, error_message = NULL WHERE status = 'FAILED'");
    return this.syncNow();
  }

  /**
   * Never two rounds at once. A request that arrives while a round is running is NOT dropped: that round may already be past the
   * point where the new change would be seen (it pulled before the other PC pushed, or read the queue before this PC wrote), so
   * one more round runs right after it. The returned promise covers those follow-up rounds too.
   */
  syncNow(): Promise<SyncReport> {
    if (this.running) { this.again = true; return this.running; }
    this.running = this.roundsUntilQuiet().finally(() => { this.running = null; this.again = false; });
    return this.running;
  }
  private async roundsUntilQuiet(): Promise<SyncReport> {
    const total = await this.run();
    // Follow-ups only after a healthy round (a failing partner must not be retried in a tight loop) and at most 3 in a row.
    for (let i = 0; i < 3 && this.again && this.lastRoundOk; i++) {
      this.again = false;
      const r = await this.run();
      total.pushed += r.pushed; total.pulled += r.pulled; total.conflicts += r.conflicts; total.failed = r.failed;
    }
    return total;
  }

  // ------------------------------------------------------------------ scheduler
  start(intervalMs = 30_000) {
    this.stop();
    this.resetStuck().then(() => this.syncNow());
    this.timer = setInterval(() => this.syncNow(), intervalMs);
    // On a shop network (short interval) our own changes go out almost at once; with the cloud they are batched for 3 s.
    const delay = intervalMs <= 10_000 ? 400 : 3000;
    this.unsub = dataBus.subscribe(() => {
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.syncNow(), delay);
    });
    this.d.live?.start();
    if (typeof window !== 'undefined') window.addEventListener('online', this.onOnline);
  }
  stop() {
    this.d.live?.stop();
    if (this.timer) clearInterval(this.timer);
    if (this.debounce) clearTimeout(this.debounce);
    this.unsub?.();
    if (typeof window !== 'undefined') window.removeEventListener('online', this.onOnline);
    this.timer = this.debounce = this.unsub = null;
  }
  private onOnline = () => { this.syncNow(); };

  // ------------------------------------------------------------------ one round
  private async run(): Promise<SyncReport> {
    const report: SyncReport = { pushed: 0, pulled: 0, conflicts: 0, failed: 0 };
    this.lastRoundOk = false;
    if (!(await this.d.isEnabled())) { this.setState('DISABLED', 'NO_PREMIUM'); return report; }
    if (!(await this.online())) { this.setState('OFFLINE'); return report; }
    this.setState('SYNCING');
    try {
      await this.pushAll(report);
      await this.pullAll(report);
      await setSetting(this.d.db, 'last_sync_at', this.now().toISOString());
      await setSetting(this.d.db, 'sync_last_error', '');
      this.lastRoundOk = true;
      const st = await this.getStatus();
      this.setState(st.failed > 0 ? 'FAILED' : 'IDLE', st.failed > 0 ? 'REJECTED' : null);
    } catch (e: any) {
      const kind = e instanceof SyncTransportError ? e.kind : 'SERVER';
      await setSetting(this.d.db, 'sync_last_error', String(e?.message ?? e));
      if (kind === 'NETWORK') this.setState('OFFLINE');
      else if (kind === 'PREMIUM_REQUIRED') this.setState('DISABLED', 'NO_PREMIUM');
      else if (kind === 'AUTH') this.setState('FAILED', 'AUTH');
      else this.setState('FAILED', 'SERVER');
    }
    return report;
  }

  // ------------------------------------------------------------------ PUSH (SQLite -> sync queue -> API)
  private async pushAll(report: SyncReport) {
    const size = this.d.batchSize ?? 50;
    for (;;) {
      const due = await this.d.db.select<Row>(
        `SELECT * FROM sync_queue WHERE status IN ('PENDING','FAILED') AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
         ORDER BY rowid LIMIT ?`, [this.now().toISOString(), size]);
      if (!due.length) return;
      const ids = due.map((e) => e.id);
      await this.d.db.execute(
        `UPDATE sync_queue SET status = 'SYNCING', last_attempt_at = ? WHERE id IN (${ids.map(() => '?').join(',')})`,
        [this.now().toISOString(), ...ids]);

      const changes: PushChange[] = due.map((e) => ({
        opId: e.id, entityType: e.entity_type, entityId: e.entity_id, operation: e.operation, baseVersion: e.base_version, data: JSON.parse(e.payload),
      }));
      let results: PushResult[];
      try {
        results = (await this.d.transport.push({ deviceId: this.d.deviceId, changes })).results;
      } catch (e: any) {
        await this.failBatch(due, e);
        throw e;
      }
      const byOp = new Map(results.map((r) => [r.opId, r]));
      for (const entry of due) {
        const res = byOp.get(entry.id);
        if (!res) { await this.failEntry(entry, 'No result returned by server', false); report.failed++; continue; }
        await this.d.db.transaction((tx) => this.processResult(tx, entry, res, report));
      }
      dataBus.emit();
    }
  }

  private async failBatch(entries: Row[], e: any) {
    if (e instanceof SyncTransportError && e.kind === 'NETWORK') {
      // The partner cannot be reached: nothing is wrong with the records. They stay WAITING (pending), are retried on the
      // next round with no growing delay, and are never shown as "failed". (A long outage must not delay the catch-up.)
      const ids = entries.map((x) => x.id);
      await this.d.db.execute(`UPDATE sync_queue SET status = 'PENDING' WHERE id IN (${ids.map(() => '?').join(',')})`, ids);
      return;
    }
    const retryable = !(e instanceof SyncTransportError) || e.kind === 'NETWORK' || e.kind === 'SERVER' || e.kind === 'AUTH';
    for (const entry of entries) await this.failEntry(entry, String(e?.message ?? e), retryable);
  }

  private async failEntry(entry: Row, message: string, retryable: boolean, db: Db = this.d.db) {
    const retries = (entry.retry_count ?? 0) + 1;
    const delayMs = Math.min(5000 * 2 ** (retries - 1), 15 * 60_000);
    const next = retryable ? new Date(this.now().getTime() + delayMs).toISOString() : PERMANENT;
    await db.execute(
      "UPDATE sync_queue SET status = 'FAILED', retry_count = ?, error_message = ?, next_attempt_at = ? WHERE id = ?",
      [retries, message.slice(0, 500), next, entry.id]);
  }

  private async processResult(tx: Db, entry: Row, res: PushResult, report: SyncReport) {
    if (res.status === 'ACCEPTED' || res.status === 'DUPLICATE') {
      await tx.execute("UPDATE sync_queue SET status = 'SYNCED', error_message = NULL WHERE id = ?", [entry.id]);
      await this.markEntitySynced(tx, entry.entity_type, entry.entity_id, res.version ?? entry.base_version + 1);
      report.pushed++;
    } else if (res.status === 'CONFLICT' && res.serverRecord) {
      report.conflicts++;
      await this.handleConflict(tx, entry, res.serverRecord);
    } else {
      // REJECTED: the server refused the record (validation). Keep it, flag it, never delete it.
      await this.failEntry(entry, res.error ?? 'Rejected by server', false, tx);
      report.failed++;
    }
  }

  private async markEntitySynced(tx: Db, table: string, id: string, version: number) {
    const others = await tx.select<Row>(
      "SELECT id FROM sync_queue WHERE entity_type = ? AND entity_id = ? AND status IN ('PENDING','FAILED','SYNCING')", [table, id]);
    if (others.length === 0) {
      await tx.execute(`UPDATE ${table} SET version = ?, sync_status = 'SYNCED' WHERE id = ?`, [version, id]);
    } else {
      await tx.execute(`UPDATE ${table} SET version = ? WHERE id = ?`, [version + others.length, id]);
      await tx.execute("UPDATE sync_queue SET base_version = ? WHERE entity_type = ? AND entity_id = ? AND status IN ('PENDING','FAILED','SYNCING')", [version, table, id]);
    }
  }

  // ------------------------------------------------------------------ conflicts
  private async handleConflict(tx: Db, entry: Row, remote: ServerRecord) {
    const table = entry.entity_type as string;
    const local = await tx.selectOne<Row>(`SELECT * FROM ${table} WHERE id = ?`, [entry.entity_id]);
    if (!local) { await tx.execute("UPDATE sync_queue SET status = 'SYNCED' WHERE id = ?", [entry.id]); return; }
    const remoteRow = { ...remote.data, version: remote.version };
    const out = resolveConflict(table, local, remoteRow);

    if (out.record) {
      await tx.execute(
        `INSERT INTO sync_conflicts (id, entity_type, entity_id, local_payload, remote_payload, detected_at, auto_resolution, status)
         VALUES (?,?,?,?,?,?,?, 'OPEN')`,
        [uuid(), table, entry.entity_id, JSON.stringify(local), JSON.stringify(remote.data), this.now().toISOString(), out.resolution]);
    }

    if (out.resolution === 'DUPLICATE') {
      await tx.execute("UPDATE sync_queue SET status = 'SYNCED' WHERE id = ?", [entry.id]);
      await this.markEntitySynced(tx, table, entry.entity_id, remote.version);
      return;
    }
    if (out.keepLocalPending) {
      // Local version stays; it is re-sent on top of the server version we now know about.
      await tx.execute(
        "UPDATE sync_queue SET status = 'PENDING', base_version = ?, payload = ?, retry_count = 0, error_message = NULL, next_attempt_at = NULL WHERE entity_type = ? AND entity_id = ? AND status IN ('SYNCING','PENDING','FAILED')",
        [remote.version, JSON.stringify(stripLocal(table, out.winner)), table, entry.entity_id]);
      await tx.execute(`UPDATE ${table} SET version = ?, sync_status = 'PENDING' WHERE id = ?`, [remote.version + 1, entry.entity_id]);
    } else {
      // Remote version wins locally. The local copy is preserved in sync_conflicts (review / restore in Settings).
      await this.writeRow(tx, table, { ...out.winner, version: remote.version, sync_status: 'SYNCED' });
      await tx.execute("UPDATE sync_queue SET status = 'SYNCED', error_message = 'superseded by server version' WHERE entity_type = ? AND entity_id = ? AND status IN ('SYNCING','PENDING','FAILED')", [table, entry.entity_id]);
      await this.reconcileDerived(tx, new Set(table === 'products' ? [entry.entity_id] : []), new Set());
    }
  }

  // ------------------------------------------------------------------ PULL (API -> SQLite)
  private async pullAll(report: SyncReport, onProgress?: (pulledSoFar: number) => void) {
    const cursorKey = (await this.d.cursorKey?.()) ?? 'sync_cursor';
    let cursor = (await getSetting(this.d.db, cursorKey)) || '0';
    let checked = false;
    this.events = cursor !== '0' && this.d.onRemote ? [] : null;      // a first download / full restore is not "news"
    for (;;) {
      const page = await this.d.transport.pull(cursor, this.d.deviceId, 200);
      if (!checked && this.d.checkHub) {
        checked = true;
        if ((await this.d.checkHub({ hubId: page.hubId, head: page.head, cursor, anchor: page.anchor })) === 'reset') {
          // Different or rolled-back partner: start reading its log from the beginning and send it everything we hold.
          cursor = '0'; await setSetting(this.d.db, cursorKey, '0'); await this.d.onHubReset?.();
          continue;
        }
      }
      await this.d.db.transaction(async (tx) => {
        await tx.execute('PRAGMA defer_foreign_keys = ON'); // parents/children may arrive in any order inside a page
        const products = new Set<string>(); const batches = new Set<string>();
        for (const incoming of page.records) {
          const rec = this.d.mapRemote ? await this.d.mapRemote(incoming) : incoming;      // e.g. the cloud's app_settings -> our shop_settings
          if (await this.applyRemote(tx, rec, products, batches, report)) report.pulled++;
        }
        await this.reconcileDerived(tx, products, batches);
        await this.d.afterPull?.(tx, page);
        await tx.execute(
          `INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
          [cursorKey, page.nextCursor, this.now().toISOString()]);
      });
      cursor = page.nextCursor;
      onProgress?.(report.pulled);
      dataBus.emit();
      if (!page.hasMore) break;
    }
    const news = this.events; this.events = null;
    if (news?.length) { try { this.d.onRemote?.(news); } catch { /* a notification must never break a sync */ } }
  }

  private async applyRemote(tx: Db, rec: ServerRecord, products: Set<string>, batches: Set<string>, report: SyncReport): Promise<boolean> {
    if (!tables.has(rec.entityType)) return false; // newer server may know entities this app doesn't
    const table = rec.entityType;
    const row: Row = { ...rec.data, id: rec.entityId, version: rec.version, sync_status: 'SYNCED' };
    if (rec.deleted && !row.deleted_at) row.deleted_at = row.updated_at ?? this.now().toISOString();
    if (table === 'users') await this.resolveUsernameCollision(tx, row);
    const local = await tx.selectOne<Row>(`SELECT * FROM ${table} WHERE id = ?`, [rec.entityId]);
    const touch = () => {
      if (table === 'products') products.add(rec.entityId);
      if (table === 'stock_movements') { products.add(row.product_id); if (row.batch_id) batches.add(row.batch_id); }
      if (table === 'product_batches') batches.add(rec.entityId);
    };
    if (!local) { await this.writeRow(tx, table, row); touch(); await this.noteRemote(tx, rec, row, null); return true; }

    const pending = await tx.selectOne<Row>(
      "SELECT * FROM sync_queue WHERE entity_type = ? AND entity_id = ? AND status IN ('PENDING','SYNCING','FAILED') ORDER BY rowid DESC LIMIT 1", [table, rec.entityId]);
    if (!pending) {
      if (rec.version > local.version) { await this.writeRow(tx, table, row); touch(); await this.noteRemote(tx, rec, row, local); return true; }
      return false;
    }
    if (rec.version <= pending.base_version) return false; // nothing new from the server
    report.conflicts++;
    await this.handleConflict(tx, pending, { ...rec, data: rec.data });
    touch();
    return true;
  }

  /** Remember a sale / cancellation / stock change made by ANOTHER PC just now, for the small notifications. */
  private async noteRemote(tx: Db, rec: ServerRecord, row: Row, before: Row | null) {
    if (!this.events || !rec.deviceId || rec.deviceId === this.d.deviceId) return;
    const who = rec.deviceName || 'PC';
    const recent = (iso: unknown) => typeof iso === 'string' && this.now().getTime() - new Date(iso).getTime() < 30 * 60_000;
    if (rec.entityType === 'sales') {
      if (!before && row.status !== 'CANCELLED' && recent(row.sold_at ?? row.created_at)) this.events.push({ kind: 'SALE', who, receipt: row.receipt_no, total: Number(row.total) || 0 });
      else if (before && before.status !== 'CANCELLED' && row.status === 'CANCELLED') this.events.push({ kind: 'CANCEL', who, receipt: row.receipt_no });
    } else if (rec.entityType === 'stock_movements' && !before && row.type !== 'SALE' && row.type !== 'SALE_CANCEL' && recent(row.created_at)) {
      const p = await tx.selectOne<{ name: string }>('SELECT name FROM products WHERE id = ?', [row.product_id]);
      this.events.push({ kind: 'STOCK', who, product: p?.name ?? '', qty: Number(row.quantity) || 0 });
    }
  }

  private async columns(tx: Db, table: string): Promise<string[]> {
    let c = this.colCache.get(table);
    if (!c) {
      c = (await tx.select<{ name: string }>(`PRAGMA table_info(${table})`)).map((r) => r.name);
      this.colCache.set(table, c);
    }
    return c;
  }

  private async writeRow(tx: Db, table: string, row: Row) {
    const cols = (await this.columns(tx, table)).filter((c) => row[c] !== undefined);
    await tx.execute(
      `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})
       ON CONFLICT(id) DO UPDATE SET ${cols.filter((c) => c !== 'id').map((c) => `${c} = excluded.${c}`).join(', ')}`,
      cols.map((c) => row[c]));
    if (table === 'shop_settings') await applyRemoteSetting(tx, row); // settings are read from app_settings: make the pulled value effective
  }

  /**
   * Two different accounts must never share a username. If a pulled staff account clashes with a DIFFERENT local one
   * (e.g. the owner re-created "admin" by hand on the new PC before restoring), the local one is renamed, never deleted.
   */
  private async resolveUsernameCollision(tx: Db, row: Row) {
    if (row.deleted_at || !row.username) return;
    const clash = await tx.selectOne<{ id: string; username: string }>(
      'SELECT id, username FROM users WHERE lower(username) = lower(?) AND id <> ? AND deleted_at IS NULL', [row.username, row.id]);
    if (!clash) return;
    const sys = { db: tx, deviceId: this.d.deviceId, user: null, permissions: new Set<string>(), now: () => this.now() };
    await updateRow(tx, sys, 'users', clash.id, { username: `${clash.username}-local-${clash.id.slice(-4)}` });
  }

  /**
   * products.quantity, product_batches.quantity_remaining and products.expiry_date are CACHES of the
   * immutable stock ledger. After any merge they are recomputed, so two devices selling the same product
   * offline can never overwrite each other's sales.
   */
  private async reconcileDerived(tx: Db, productIds: Set<string>, batchIds: Set<string>) {
    for (const bid of batchIds) {
      const b = await tx.selectOne<Row>('SELECT product_id FROM product_batches WHERE id = ?', [bid]);
      if (!b) continue;
      productIds.add(b.product_id);
      const s = await tx.selectOne<{ q: number | null }>('SELECT SUM(quantity) q FROM stock_movements WHERE batch_id = ? AND deleted_at IS NULL', [bid]);
      await tx.execute('UPDATE product_batches SET quantity_remaining = ? WHERE id = ?', [Math.round((s?.q ?? 0) * 1000) / 1000, bid]);
    }
    for (const pid of productIds) {
      const n = (await tx.selectOne<{ n: number }>('SELECT COUNT(*) n FROM stock_movements WHERE product_id = ? AND deleted_at IS NULL', [pid]))?.n ?? 0;
      if (!n) continue; // no ledger yet: keep the quantity the server gave us
      const s = await tx.selectOne<{ q: number | null }>('SELECT SUM(quantity) q FROM stock_movements WHERE product_id = ? AND deleted_at IS NULL', [pid]);
      const e = await tx.selectOne<{ e: string | null }>(
        'SELECT MIN(expiry_date) e FROM product_batches WHERE product_id = ? AND deleted_at IS NULL AND quantity_remaining > 0 AND expiry_date IS NOT NULL', [pid]);
      await tx.execute('UPDATE products SET quantity = ?, expiry_date = ? WHERE id = ?', [Math.round((s?.q ?? 0) * 1000) / 1000, e?.e ?? null, pid]);
    }
  }

  // ------------------------------------------------------------------ FREE restore from the cloud (download only)
  /**
   * Download everything the cloud account holds and merge it into this PC. Needs a cloud account but NO subscription,
   * and it never uploads anything (uploading new changes is the Premium part). `full` re-downloads from the beginning.
   */
  async restoreFromCloud(opts: { full?: boolean; onProgress?: (pulledSoFar: number) => void } = {}): Promise<SyncReport> {
    if (this.running) await this.running.catch(() => undefined);
    if (!(await this.d.canRestore?.())) throw new SyncTransportError('AUTH', 'Sign in to the cloud account first');
    if (!(await this.online())) throw new SyncTransportError('NETWORK', 'offline');
    const report: SyncReport = { pushed: 0, pulled: 0, conflicts: 0, failed: 0 };
    this.setState('SYNCING');
    this.running = (async () => {
      if (opts.full) await setSetting(this.d.db, (await this.d.cursorKey?.()) ?? 'sync_cursor', '0');
      await this.pullAll(report, opts.onProgress);
      await setSetting(this.d.db, 'last_restore_at', this.now().toISOString());
      return report;
    })();
    try { return await this.running; }
    finally {
      this.running = null;
      const enabled = await this.d.isEnabled().catch(() => false);
      this.setState(enabled ? 'IDLE' : 'DISABLED', enabled ? null : 'NO_PREMIUM');
    }
  }

  // ------------------------------------------------------------------ conflict review (Settings > Sync)
  async listConflicts(limit = 100) {
    return this.d.db.select<Row>('SELECT * FROM sync_conflicts ORDER BY detected_at DESC LIMIT ?', [limit]);
  }
  async markConflictReviewed(id: string) {
    await this.d.db.execute("UPDATE sync_conflicts SET status = 'REVIEWED', resolved_at = ? WHERE id = ?", [this.now().toISOString(), id]);
  }
}
