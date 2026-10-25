import type { Db } from '../database/db';
import { getSetting, setSetting } from '../services/settings';
import {
  type PullResponse, type PushRequest, type PushResponse, type SyncTransport, SyncTransportError,
} from '../sync/protocol';

/**
 * Client for the NestJS backend. The desktop never talks to Supabase directly and never holds any
 * secret key: it only holds the user's own JWT session (stored locally) and the public entitlement key.
 *
 * Endpoint contract: docs/BACKEND_CONTRACT.md
 */
export interface CloudSession { email: string; accessToken: string; refreshToken: string }

export class CloudError extends Error {
  constructor(public kind: 'NOT_CONFIGURED' | 'NO_SESSION' | 'NETWORK' | 'AUTH' | 'PREMIUM_REQUIRED' | 'SERVER', message: string, public status?: number, public code?: string, public reason?: string) {
    super(message);
  }
}

export interface PaymentStart { reference: string; status: string; authorizationUrl?: string; message?: string; deviceToken?: string }
/** none: public call · session: account JWT · either: JWT or device token · optional: token if we have one */
export type Auth = 'none' | 'session' | 'either' | 'optional';
export interface SubscriptionStatus { status: 'NONE' | 'PENDING' | 'ACTIVE' | 'EXPIRED' | 'FAILED'; entitlement?: string | null; expiresAt?: string | null }
export interface TrialStatus {
  eligible: boolean;
  mainDevice: boolean;
  premium: boolean;
  sync: { available: boolean; startedAt: string | null; expiresAt: string | null };
  scan: { available: boolean; used: boolean };
}
export interface ScanDetection { label: string; quantity: number | null; confidence: 'HIGH' | 'MEDIUM' | 'LOW' }

export class CloudClient {
  constructor(private db: Db, private deviceId: string) {}

  async baseUrl(): Promise<string> {
    const env = (import.meta as any).env?.VITE_CLOUD_API_URL as string | undefined;
    return ((await getSetting(this.db, 'cloud_api_url')) || env || '').replace(/\/+$/, '');
  }
  async isConfigured() { return !!(await this.baseUrl()); }

  async getSession(): Promise<CloudSession | null> {
    try { return JSON.parse((await getSetting(this.db, 'cloud_session')) || 'null'); } catch { return null; }
  }
  private async setSession(s: CloudSession | null) { await setSetting(this.db, 'cloud_session', s ? JSON.stringify(s) : ''); }
  async hasSession() { return !!(await this.getSession()); }
  async signOut() { await this.setSession(null); }

  // ------------------------------------------------------------------ raw request with 1 automatic token refresh
  private async raw(path: string, init: RequestInit, token?: string): Promise<Response> {
    const base = await this.baseUrl();
    if (!base) throw new CloudError('NOT_CONFIGURED', 'Cloud API URL not configured');
    try {
      return await fetch(base + path, {
        ...init,
        headers: { 'Content-Type': 'application/json', 'X-Device-Id': this.deviceId, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init.headers ?? {}) },
      });
    } catch (e: any) {
      throw new CloudError('NETWORK', e?.message ?? 'network');
    }
  }

  /**
   * The device token is issued by the backend when a payment is started from this device. It lets the app
   * check / renew its subscription and use the AI scan without any account sign-in.
   */
  async getDeviceToken(): Promise<string | null> { return (await getSetting(this.db, 'cloud_device_token')) || null; }

  async request<T>(path: string, init: RequestInit = {}, auth: Auth = 'session'): Promise<T> {
    let session = auth === 'session' || auth === 'either' || auth === 'optional' ? await this.getSession() : null;
    const dev = auth === 'either' || auth === 'optional' ? await this.getDeviceToken() : null;
    if (auth === 'session' && !session) throw new CloudError('NO_SESSION', 'Not signed in to the cloud account');
    if (auth === 'either' && !session && !dev) throw new CloudError('NO_SESSION', 'No account or subscription on this device');
    let res = await this.raw(path, init, session?.accessToken ?? dev ?? undefined);
    if (res.status === 401 && session) {
      session = await this.refresh(session);
      res = await this.raw(path, init, session.accessToken);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const kind = res.status === 401 ? 'AUTH' : res.status === 402 || res.status === 403 ? 'PREMIUM_REQUIRED' : 'SERVER';
      let detail: { code?: string; reason?: string; message?: string } = {};
      try { detail = JSON.parse(body); } catch { /* preserve a plain-text server message */ }
      throw new CloudError(kind, detail.message || body.slice(0, 300) || `HTTP ${res.status}`, res.status, detail.code, detail.reason);
    }
    return (await res.json()) as T;
  }

  private async refresh(s: CloudSession): Promise<CloudSession> {
    const res = await this.raw('/auth/refresh', { method: 'POST', body: JSON.stringify({ refreshToken: s.refreshToken, deviceId: this.deviceId }) });
    if (!res.ok) { await this.setSession(null); throw new CloudError('AUTH', 'Session expired, please sign in again'); }
    const j = await res.json();
    const next = { email: s.email, accessToken: j.accessToken, refreshToken: j.refreshToken ?? s.refreshToken }; // refresh-token rotation
    await this.setSession(next);
    return next;
  }

  // ------------------------------------------------------------------ account
  async login(email: string, password: string, deviceName: string) {
    const j = await this.request<{ accessToken: string; refreshToken: string }>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password, deviceId: this.deviceId, deviceName, platform: this.platform() }) }, 'none');
    await this.setSession({ email, accessToken: j.accessToken, refreshToken: j.refreshToken });
  }
  async register(email: string, password: string, fullName: string, deviceName: string) {
    const j = await this.request<{ accessToken: string; refreshToken: string }>('/auth/register', { method: 'POST', body: JSON.stringify({ email, password, fullName, deviceId: this.deviceId, deviceName, platform: this.platform() }) }, 'none');
    await this.setSession({ email, accessToken: j.accessToken, refreshToken: j.refreshToken });
  }

  private platform() { return typeof window !== 'undefined' && !('__TAURI_INTERNALS__' in window) ? 'WEB' : 'DESKTOP'; }

  /** Authorize this signed-in browser using the shop's existing paid subscription. */
  shareWebDevice() {
    return this.request<{ deviceId: string; status: string; entitlement: string | null; deviceToken: string | null; expiresAt: string | null }>(
      '/subscriptions/share/web', { method: 'POST', body: '{}' }, 'session',
    );
  }

  // ------------------------------------------------------------------ subscription (payment is verified by the BACKEND only)
  /** Starts a Notch Pay mobile-money charge: the customer receives a PIN prompt on their phone. No account needed. */
  async startPayment(provider: 'MTN_MOMO' | 'ORANGE_MONEY', phone: string): Promise<PaymentStart> {
    const r = await this.request<PaymentStart>('/payments/notchpay/create', { method: 'POST', body: JSON.stringify({ plan: 'PREMIUM', provider, phone, deviceId: this.deviceId }) }, 'none');
    if (r.deviceToken) await setSetting(this.db, 'cloud_device_token', r.deviceToken);
    return r;
  }
  subscriptionStatus(reference?: string) {
    return this.request<SubscriptionStatus>(`/subscriptions/status?deviceId=${encodeURIComponent(this.deviceId)}${reference ? `&reference=${encodeURIComponent(reference)}` : ''}`, {}, 'optional');
  }

  trialStatus() { return this.request<TrialStatus>('/subscriptions/trial'); }
  startSyncTrial() { return this.request<{ premium: boolean; startedAt?: string; expiresAt: string | null }>('/subscriptions/trial/sync', { method: 'POST' }); }

  // ------------------------------------------------------------------ AI store scan (premium, online)
  storeScan(imageBase64: string, mime: string, lang: string) {
    return this.request<{ detections: ScanDetection[] }>('/ai/store-scan', { method: 'POST', body: JSON.stringify({ image: imageBase64, mime, lang }) }, 'either');
  }

  // ------------------------------------------------------------------ sync transport
  transport(): SyncTransport {
    const wrap = async <T>(fn: () => Promise<T>): Promise<T> => {
      try { return await fn(); } catch (e) {
        if (e instanceof CloudError) {
          const kind = e.kind === 'NETWORK' ? 'NETWORK' : e.kind === 'AUTH' || e.kind === 'NO_SESSION' || e.kind === 'NOT_CONFIGURED' ? 'AUTH' : e.kind === 'PREMIUM_REQUIRED' ? 'PREMIUM_REQUIRED' : 'SERVER';
          throw new SyncTransportError(kind, e.message);
        }
        throw e;
      }
    };
    return {
      push: (req: PushRequest) => wrap(() => this.request<PushResponse>('/sync/push', { method: 'POST', body: JSON.stringify(req) })),
      pull: (since: string, deviceId: string, limit: number) =>
        wrap(() => this.request<PullResponse>(`/sync/pull?since=${encodeURIComponent(since)}&deviceId=${encodeURIComponent(deviceId)}&limit=${limit}`)),
    };
  }
}
