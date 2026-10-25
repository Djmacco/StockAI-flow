import { type PullResponse, type PushRequest, type PushResponse, type SyncTransport, SyncTransportError } from '../sync/protocol';

/**
 * Talks to a shop hub (the "main PC") on the local network, with the SAME push/pull protocol as the cloud API.
 * Requests go through the Rust `lan_request` command: the webview's security policy blocks plain http, and Rust refuses
 * any address that is not on the local network, so shop data can never leave the shop through this path.
 */
export interface LanRequest { method: 'GET' | 'POST' | 'DELETE'; url: string; token?: string; deviceId?: string; body?: string; timeoutMs?: number }
export interface LanResponse { status: number; body: string }
export type LanFetch = (r: LanRequest) => Promise<LanResponse>;

/** code: NETWORK · NOT_LOCAL · BAD_ADDRESS · NOT_A_HUB · BAD_CODE · PAIRING_CLOSED · PAIRING_LOCKED · UNAUTHORIZED · SERVER */
export class LanError extends Error {
  constructor(public code: string, message?: string) { super(message ?? code); }
}

export const tauriLanFetch: LanFetch = async (r) => {
  const { invoke } = await import('@tauri-apps/api/core');
  try {
    return await invoke<LanResponse>('lan_request', { method: r.method, url: r.url, token: r.token ?? null, deviceId: r.deviceId ?? null, body: r.body ?? null, timeoutMs: r.timeoutMs ?? null });
  } catch (e) {
    const m = String((e as any)?.message ?? e);
    if (m.includes('not_a_local_address')) throw new LanError('NOT_LOCAL', m);
    if (m.includes('bad_address')) throw new LanError('BAD_ADDRESS', m);
    throw new LanError('NETWORK', m);
  }
};

/** "192.168.1.10" -> "http://192.168.1.10:47800". Only plain http on the LAN is accepted. */
export const DEFAULT_HUB_PORT = 47800;
export function normalizeHubUrl(input: string): string {
  let s = input.trim().replace(/\/+$/, '');
  if (!s) throw new LanError('BAD_ADDRESS');
  if (/^https:\/\//i.test(s)) throw new LanError('BAD_ADDRESS');
  if (!/^http:\/\//i.test(s)) s = `http://${s}`;
  if (!/^http:\/\/[^/?#]+$/i.test(s) || /@/.test(s)) throw new LanError('BAD_ADDRESS');
  if (!/:\d+$/.test(s)) s += `:${DEFAULT_HUB_PORT}`;
  return s.replace(/^http:/i, 'http:');
}

export async function call(f: LanFetch, r: LanRequest): Promise<any> {
  const res = await f(r);
  let json: any = null;
  try { json = res.body ? JSON.parse(res.body) : null; } catch { /* not JSON */ }
  if (res.status >= 200 && res.status < 300) return json;
  throw new LanError(typeof json?.code === 'string' ? json.code : res.status === 401 ? 'UNAUTHORIZED' : 'SERVER', json?.message ?? `HTTP ${res.status}`);
}

/** Is there a StockFlow hub at this address? (no login needed) */
export async function pingHub(url: string, f: LanFetch = tauriLanFetch): Promise<void> {
  let j: any;
  try { j = await call(f, { method: 'GET', url: `${url}/ping`, timeoutMs: 4000 }); } catch (e) { if (e instanceof LanError && e.code === 'SERVER') throw new LanError('NOT_A_HUB'); throw e; }
  if (j?.app !== 'stockflow-hub') throw new LanError('NOT_A_HUB');
}

/**
 * Exchange the pairing code (shown on the main PC) for this PC's own access token and its short PC code
 * (printed in receipt numbers). `preferredCode` = the code this PC already used, kept when still free.
 */
export async function pairWithHub(url: string, code: string, deviceId: string, deviceName: string, preferredCode = '', f: LanFetch = tauriLanFetch): Promise<{ token: string; deviceCode: string }> {
  const j = await call(f, { method: 'POST', url: `${url}/pair`, body: JSON.stringify({ code: code.replace(/\s+/g, ''), deviceId, deviceName, preferredCode }) });
  if (typeof j?.token !== 'string') throw new LanError('SERVER');
  return { token: j.token, deviceCode: typeof j.deviceCode === 'string' ? j.deviceCode : '' };
}

/** A PC paired by an older build has no PC code yet: the main PC assigns one. */
export async function fetchDeviceCode(url: string, token: string, deviceId: string, f: LanFetch = tauriLanFetch): Promise<string> {
  const j = await call(f, { method: 'GET', url: `${url}/device`, token, deviceId, timeoutMs: 5000 });
  return typeof j?.deviceCode === 'string' ? j.deviceCode : '';
}

export interface SaleReservationLine { productId: string; quantity: number }
/** Atomically reserve a client checkout against the hub's current stock ledger. */
export async function reserveHubSale(url: string, token: string, deviceId: string, saleId: string, items: SaleReservationLine[], f: LanFetch = tauriLanFetch): Promise<void> {
  await call(f, { method: 'POST', url: `${url}/sales/reserve`, token, deviceId, body: JSON.stringify({ saleId, items }), timeoutMs: 5000 });
}
export async function activeHubSaleReservations(url: string, token: string, deviceId: string, f: LanFetch = tauriLanFetch): Promise<string[]> {
  const j = await call(f, { method: 'GET', url: `${url}/sales/reservations`, token, deviceId, timeoutMs: 5000 });
  return Array.isArray(j?.saleIds) ? j.saleIds.filter((x: unknown): x is string => typeof x === 'string') : [];
}
export async function releaseHubSale(url: string, token: string, deviceId: string, saleId: string, f: LanFetch = tauriLanFetch): Promise<boolean> {
  const r = await f({ method: 'DELETE', url: `${url}/sales/reservations/${encodeURIComponent(saleId)}`, token, deviceId, timeoutMs: 5000 });
  let j: any = null; try { j = r.body ? JSON.parse(r.body) : null; } catch { /* call below reports malformed errors */ }
  if (r.status < 200 || r.status >= 300) throw new LanError(typeof j?.code === 'string' ? j.code : 'SERVER', j?.message ?? `HTTP ${r.status}`);
  return j?.released === true;
}

export function lanTransport(conn: () => Promise<{ url: string; token: string } | null>, deviceId: string, f: LanFetch = tauriLanFetch): SyncTransport {
  const wrap = async <T>(fn: (c: { url: string; token: string }) => Promise<T>): Promise<T> => {
    const c = await conn();
    if (!c) throw new SyncTransportError('AUTH', 'Not connected to a main PC');
    try { return await fn(c); } catch (e) {
      if (e instanceof LanError) throw new SyncTransportError(e.code === 'NETWORK' ? 'NETWORK' : e.code === 'UNAUTHORIZED' ? 'AUTH' : 'SERVER', e.message);
      throw e;
    }
  };
  return {
    push: (req: PushRequest) => wrap((c) => call(f, { method: 'POST', url: `${c.url}/sync/push`, token: c.token, deviceId, body: JSON.stringify(req) }) as Promise<PushResponse>),
    pull: (since: string, _d: string, limit: number) =>
      wrap((c) => call(f, { method: 'GET', url: `${c.url}/sync/pull?since=${encodeURIComponent(since)}&limit=${limit}`, token: c.token, deviceId }) as Promise<PullResponse>),
  };
}
