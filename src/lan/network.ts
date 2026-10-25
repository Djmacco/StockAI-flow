import type { Db } from '../database/db';
import { dataBus } from '../lib/events';
import { uuid } from '../lib/ids';
import { getSetting, setSetting } from '../services/settings';
import { checkoutIsInFlight } from '../services/checkoutJournal';
import { stripLocal, SYNC_TABLES } from '../services/repo';
import { type PullResponse, type SyncTransport } from '../sync/protocol';
import { activeHubSaleReservations, DEFAULT_HUB_PORT, fetchDeviceCode, LanError, lanTransport, normalizeHubUrl, pairWithHub, pingHub, releaseHubSale, type LanFetch, tauriLanFetch } from './transport';

/**
 * Shop network mode. off = this PC syncs with the cloud (Premium) or not at all.
 * host = this PC is the main PC (serves the shop's data on the LAN). client = this PC syncs with the main PC.
 * In host/client mode the main PC replaces the cloud as the sync partner of THIS device (versions and cursor are per partner).
 */
export type NetMode = 'off' | 'host' | 'client';
export interface NetConfig { mode: NetMode; url: string; token: string; port: number }
/** Polling interval while on a shop network (the cloud uses 30 s). Pulls are cheap on a LAN. */
export const LAN_SYNC_INTERVAL_MS = 5000;
export const CLOUD_SYNC_INTERVAL_MS = 30_000;

export async function getNetConfig(db: Db): Promise<NetConfig> {
  const mode = (await getSetting(db, 'net_mode')) as NetMode;
  return {
    mode: mode === 'host' || mode === 'client' ? mode : 'off',
    url: await getSetting(db, 'net_hub_url'), token: await getSetting(db, 'net_token'),
    port: parseInt((await getSetting(db, 'net_port')) || '', 10) || DEFAULT_HUB_PORT,
  };
}
export const lanActive = (c: NetConfig) => c.mode !== 'off' && !!c.url && !!c.token;
export const syncIntervalFor = async (db: Db) => (lanActive(await getNetConfig(db)) ? LAN_SYNC_INTERVAL_MS : CLOUD_SYNC_INTERVAL_MS);
/** Each sync partner has its own change cursor (a hub's numbers mean nothing to the cloud and the other way round). */
export const cursorKeyFor = async (db: Db) => (lanActive(await getNetConfig(db)) ? 'sync_cursor_lan' : 'sync_cursor') as 'sync_cursor' | 'sync_cursor_lan';

/** Picks the partner on every call, so switching modes takes effect immediately without rebuilding the engine. */
export function routingTransport(db: Db, deviceId: string, cloud: SyncTransport, f: LanFetch = tauriLanFetch): SyncTransport {
  const lan = lanTransport(async () => { const c = await getNetConfig(db); return lanActive(c) ? { url: c.url, token: c.token } : null; }, deviceId, f);
  const pick = async () => ((await getNetConfig(db)).mode !== 'off' ? lan : cloud);
  return { push: async (r) => (await pick()).push(r), pull: async (s, d, l) => (await pick()).pull(s, d, l) };
}

// ------------------------------------------------------------------ is this still the same main PC?
/**
 * Every pull page says which store it comes from and where its log ends. If the store is a different one (another PC became
 * the main PC) or its log is SHORTER than our position (the main PC was restored from an older backup), our cursor is
 * meaningless: start over and re-send what we hold. Nothing is lost: the hub accepts what it lacks and conflicts follow the usual rules.
 */
const anchorKey = (a: PullResponse['anchor']) => (!a ? '' : a.missing ? 'MISSING' : `${a.entityType}|${a.entityId}|${a.version}`);

export async function checkHubIdentity(db: Db, i: { hubId?: string; head?: string; cursor: string; anchor?: PullResponse['anchor'] }): Promise<'ok' | 'reset'> {
  if (!lanActive(await getNetConfig(db)) || !i.hubId) return 'ok';
  const known = await getSetting(db, 'net_hub_id');
  if (!known) { await setSetting(db, 'net_hub_id', i.hubId); return 'ok'; }   // first contact
  const cursor = Number(i.cursor);
  const mine = await getSetting(db, 'net_anchor');
  const theirs = anchorKey(i.anchor);
  const replaced = known !== i.hubId;
  // The log is shorter than our position, OR the change at our position is not the one we applied there: it was rewritten.
  const rewritten = cursor > 0 && ((i.head !== undefined && Number(i.head) < cursor) || theirs === 'MISSING' || (!!mine && !!theirs && mine !== theirs));
  if (!replaced && !rewritten) return 'ok';
  await setSetting(db, 'net_hub_id', i.hubId); await setSetting(db, 'net_anchor', '');
  return 'reset';
}
/** Remember which change we applied last, in the same transaction as the cursor. */
export async function rememberAnchor(tx: Db, page: PullResponse): Promise<void> {
  const last = page.records[page.records.length - 1];
  if (last) await setSetting(tx, 'net_anchor', `${last.entityType}|${last.entityId}|${last.version}`);
}
export async function onHubReset(db: Db): Promise<void> {
  await seedLocalForHub(db);
  await setSetting(db, 'net_notice', 'HUB_RESET');
  dataBus.emit();
}

// ------------------------------------------------------------------ seeding
/**
 * Queue every existing record for the hub (parents first, the order of SYNC_TABLES, so pulled pages stay consistent).
 * The hub starts empty, so these are accepted as first versions. Records already waiting in the queue are left alone.
 */
export async function seedLocalForHub(db: Db, now = new Date()): Promise<number> {
  let n = 0;
  await db.transaction(async (tx) => {
    for (const table of SYNC_TABLES) {
      const rows = await tx.select<Record<string, any>>(`SELECT * FROM ${table} ORDER BY rowid`);
      for (const row of rows) {
        const waiting = await tx.selectOne("SELECT 1 x FROM sync_queue WHERE entity_type = ? AND entity_id = ? AND status IN ('PENDING','FAILED','SYNCING')", [table, row.id]);
        if (waiting) continue;
        await tx.execute(
          `INSERT INTO sync_queue (id, entity_type, entity_id, operation, payload, base_version, created_at, status) VALUES (?,?,?,?,?,?,?, 'PENDING')`,
          [uuid(), table, row.id, row.deleted_at ? 'DELETE' : 'CREATE', JSON.stringify(stripLocal(table, row)), row.version ?? 0, now.toISOString()]);
        n++;
      }
    }
  });
  return n;
}

/** Does this PC already hold shop records of its own (not just the account it was set up with)? */
export async function hasLocalBusinessData(db: Db): Promise<boolean> {
  for (const t of ['products', 'sales', 'customers', 'suppliers', 'stock_movements', 'expenses']) {
    if (await db.selectOne(`SELECT 1 x FROM ${t} WHERE deleted_at IS NULL LIMIT 1`)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ tauri bridge (hub commands)
type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<any>;
let invokeOverride: Invoke | null = null;
export const __setInvokeForTests = (f: Invoke | null) => { invokeOverride = f; };
const invoke = async <T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> =>
  invokeOverride ? invokeOverride(cmd, args) : (await import('@tauri-apps/api/core')).invoke<T>(cmd, args);

export interface HubStatus {
  running: boolean; port: number | null; addresses: { name: string; ip: string }[];
  pairing: { code: string; expiresAt: number } | null;
  devices: { deviceId: string; name: string; code: string | null; pairedAt: number; lastSeenAt: number | null; revoked: boolean }[]; changes: number;
}
export interface NetInfo { addresses: { name: string; ip: string }[]; profiles: { name: string; category: string }[] }
export const hubStatus = () => invoke<HubStatus>('hub_status');
export const openPairing = (minutes = 10) => invoke<{ code: string; expiresAt: number }>('hub_open_pairing', { minutes });
export const closePairing = () => invoke<void>('hub_close_pairing');
export const revokeDevice = (deviceId: string) => invoke<void>('hub_revoke', { deviceId });
export const netInfo = () => invoke<NetInfo>('lan_net_info');
export const setHubEntitlements = (items: { deviceId: string; entitlement: string; deviceToken: string | null; expiresAt: string | null }[]) => invoke<void>('hub_set_entitlements', { items });
/** A page of the main PC's own change log (what a PC would get from /sync/pull). Used by the cloud backup. */
export const hubPull = (since: string, limit = 200) => invoke<PullResponse>('hub_pull', { since: Number(since), limit });

/** Resolve durable local checkout intents after restart. An approved sale stays reserved until its ledger movements sync. */
export async function recoverShopSaleIntents(db: Db, deviceId: string, preserveId?: string, f: LanFetch = tauriLanFetch): Promise<void> {
  const cfg = await getNetConfig(db);
  if (!lanActive(cfg)) return;
  const active = new Set(await activeHubSaleReservations(cfg.url, cfg.token, deviceId, f));
  const intents = await db.select<{ id: string }>('SELECT id FROM local_sale_intents ORDER BY created_at');
  for (const { id } of intents) {
    if (id === preserveId || checkoutIsInFlight(id)) continue;
    const sale = await db.selectOne<{ id: string }>('SELECT id FROM sales WHERE id = ?', [id]);
    if (sale && active.has(id)) continue;
    if (!sale && active.has(id)) await releaseHubSale(cfg.url, cfg.token, deviceId, id, f);
    await db.execute('DELETE FROM local_sale_intents WHERE id = ?', [id]);
  }
}

export const defaultDeviceName = (deviceId: string) => `PC-${deviceId.replace(/-/g, '').slice(-4).toUpperCase()}`;

/** Start serving (main PC) and register this PC with its own hub. Safe to call at every app start. */
export async function startHost(db: Db, deviceId: string, port: number): Promise<void> {
  try { await invoke('hub_start', { port }); } catch (e) { throw new LanError(String(e).includes('PORT_IN_USE') ? 'PORT_IN_USE' : 'HUB_START_FAILED', String(e)); }
  const reg = await invoke<{ token: string; deviceCode: string }>('hub_self_token', { deviceId, name: defaultDeviceName(deviceId), preferredCode: (await getSetting(db, 'net_device_code')) || null });
  await setSetting(db, 'net_hub_url', `http://127.0.0.1:${port}`);
  await setSetting(db, 'net_token', reg.token);
  if (reg.deviceCode) await setSetting(db, 'net_device_code', reg.deviceCode);
  await setSetting(db, 'net_port', String(port));
}

/** Make this PC the main PC. Existing local data is queued for the (empty) hub. */
export async function enableHost(db: Db, deviceId: string, port = DEFAULT_HUB_PORT): Promise<{ queued: number }> {
  await startHost(db, deviceId, port);
  await setSetting(db, 'net_mode', 'host');
  await setSetting(db, 'net_hub_id', ''); await setSetting(db, 'net_anchor', '');
  await setSetting(db, 'sync_cursor_lan', '0');
  const queued = await seedLocalForHub(db);
  dataBus.emit();
  return { queued };
}

/** Boot: a main PC serves again after every restart. Never throws (the app must start even if the port is taken). */
export async function resumeHost(db: Db, deviceId: string): Promise<void> {
  const c = await getNetConfig(db);
  if (c.mode !== 'host') return;
  try { await startHost(db, deviceId, c.port); await setSetting(db, 'net_error', ''); }
  catch (e) { await setSetting(db, 'net_error', e instanceof LanError ? e.code : 'HUB_START_FAILED'); }
}

/** Connect this PC to the main PC. `mergeLocalData`: also upload what this PC already holds (otherwise it only downloads). */
export async function joinHub(db: Db, deviceId: string, o: { address: string; code: string; deviceName?: string; mergeLocalData?: boolean }, f: LanFetch = tauriLanFetch): Promise<{ queued: number }> {
  const url = normalizeHubUrl(o.address);
  await pingHub(url, f);
  const paired = await pairWithHub(url, o.code, deviceId, (o.deviceName ?? '').trim() || defaultDeviceName(deviceId), (await getSetting(db, 'net_device_code')) || '', f);
  await setSetting(db, 'net_hub_url', url);
  await setSetting(db, 'net_token', paired.token);
  if (paired.deviceCode) await setSetting(db, 'net_device_code', paired.deviceCode);
  await setSetting(db, 'net_mode', 'client');
  await setSetting(db, 'net_hub_id', ''); await setSetting(db, 'net_anchor', '');
  await setSetting(db, 'sync_cursor_lan', '0');
  const queued = o.mergeLocalData ? await seedLocalForHub(db) : 0;
  dataBus.emit();
  return { queued };
}

/** A PC paired by an older build has no PC code yet: ask the main PC for it. Never throws (numbering falls back to the PC's own code). */
export async function ensureDeviceCode(db: Db, deviceId: string, f: LanFetch = tauriLanFetch): Promise<void> {
  try {
    const c = await getNetConfig(db);
    if (!lanActive(c) || (await getSetting(db, 'net_device_code'))) return;
    const code = await fetchDeviceCode(c.url, c.token, deviceId, f);
    if (code) await setSetting(db, 'net_device_code', code);
  } catch { /* the main PC is not reachable right now: try again at the next start */ }
}

/** Receipt numbers that appear more than once (should never happen; shown to the owner so it can be looked at). */
export async function findDuplicateReceipts(db: Db): Promise<{ receipt_no: string; n: number }[]> {
  return db.select("SELECT receipt_no, COUNT(*) n FROM sales WHERE deleted_at IS NULL GROUP BY receipt_no HAVING COUNT(*) > 1 ORDER BY receipt_no LIMIT 20");
}

/** Leave the shop network. Local data is untouched. A main PC stops serving. */
export async function leaveNetwork(db: Db): Promise<void> {
  const c = await getNetConfig(db);
  if (c.mode === 'host') await invoke('hub_stop').catch(() => undefined);
  await setSetting(db, 'net_mode', 'off');
  await setSetting(db, 'net_token', '');
  await setSetting(db, 'net_hub_url', '');
  await setSetting(db, 'net_hub_id', ''); await setSetting(db, 'net_anchor', '');
  dataBus.emit();
}
