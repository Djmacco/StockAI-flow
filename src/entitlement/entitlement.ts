import { ed25519 } from '@noble/curves/ed25519.js';
import type { Db } from '../database/db';
import { getSetting, setSetting } from '../services/settings';

/**
 * SIGNED ENTITLEMENTS
 * The backend (after verifying the Notch Pay transaction server-side) signs a payload with
 * its Ed25519 PRIVATE key. The desktop only knows the PUBLIC key, so it can verify the token
 * offline but can never forge one. `premium = true` is never stored anywhere.
 *
 * Token format:  base64url(JSON payload) + "." + base64url(signature over the payload bytes)
 */
export const FEATURES = ['CLOUD_SYNC', 'AI_STORE_SCAN'] as const;
export type Feature = (typeof FEATURES)[number];
export const PREMIUM_PRICE_XAF = 3900;

export interface EntitlementPayload {
  v: 1;
  userId: string;
  deviceId: string;
  plan: 'PREMIUM';
  features: Feature[];
  startedAt: string;
  expiresAt: string;
  issuedAt: string;
}

export type EntitlementState = 'NONE' | 'ACTIVE' | 'EXPIRED' | 'INVALID' | 'WRONG_DEVICE' | 'CLOCK_TAMPERED';
export interface EntitlementStatus {
  state: EntitlementState;
  plan: 'FREE' | 'PREMIUM';
  features: Feature[];
  expiresAt: string | null;
  startedAt: string | null;
  daysLeft: number | null;
}

/** Hex public key injected at build time: VITE_ENTITLEMENT_PUBLIC_KEY (never a secret). */
export const DEFAULT_PUBLIC_KEY: string =
  (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_ENTITLEMENT_PUBLIC_KEY) || '';

const CLOCK_TOLERANCE_MS = 24 * 3600 * 1000;
export const FREE_STATUS: EntitlementStatus = { state: 'NONE', plan: 'FREE', features: [], expiresAt: null, startedAt: null, daysLeft: null };

const b64u = {
  enc: (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''),
  dec: (s: string) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)),
};
const hex = (h: string) => Uint8Array.from(h.match(/.{2}/g)?.map((x) => parseInt(x, 16)) ?? []);

/** Used by the backend / dev tooling (never ships with the app's secrets). */
export function signEntitlement(payload: EntitlementPayload, privateKeyHex: string): string {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  return `${b64u.enc(bytes)}.${b64u.enc(ed25519.sign(bytes, hex(privateKeyHex)))}`;
}

export function parseAndVerify(token: string, publicKeyHex: string): EntitlementPayload | null {
  try {
    const [p, s] = token.trim().split('.');
    if (!p || !s || !publicKeyHex) return null;
    const bytes = b64u.dec(p);
    if (!ed25519.verify(b64u.dec(s), bytes, hex(publicKeyHex))) return null;
    const payload = JSON.parse(new TextDecoder().decode(bytes)) as EntitlementPayload;
    if (payload.v !== 1 || payload.plan !== 'PREMIUM' || !Array.isArray(payload.features)) return null;
    return payload;
  } catch {
    return null;
  }
}

/** Pure evaluation: easy to test with any clock. */
export function evaluate(token: string | null, now: Date, deviceId: string, publicKeyHex: string, lastSeen: Date | null): EntitlementStatus {
  if (!token) return FREE_STATUS;
  const p = parseAndVerify(token, publicKeyHex);
  if (!p) return { ...FREE_STATUS, state: 'INVALID' };
  const base = { plan: 'PREMIUM' as const, expiresAt: p.expiresAt, startedAt: p.startedAt };
  if (p.deviceId !== deviceId) return { ...base, plan: 'FREE', state: 'WRONG_DEVICE', features: [], daysLeft: null };
  // Rolling the system clock back to stretch a subscription is detected via a monotonic "last seen" mark.
  if (lastSeen && now.getTime() < lastSeen.getTime() - CLOCK_TOLERANCE_MS) return { ...base, plan: 'FREE', state: 'CLOCK_TAMPERED', features: [], daysLeft: null };
  const exp = new Date(p.expiresAt).getTime();
  if (isNaN(exp) || now.getTime() >= exp) return { ...base, plan: 'FREE', state: 'EXPIRED', features: [], daysLeft: 0 };
  return { ...base, state: 'ACTIVE', features: p.features, daysLeft: Math.ceil((exp - now.getTime()) / 86400000) };
}

export const hasFeature = (status: EntitlementStatus, f: Feature) => status.state === 'ACTIVE' && status.features.includes(f);

// ------------------------------------------------------------------ persistence
export async function loadStatus(db: Db, deviceId: string, now: Date, publicKeyHex = DEFAULT_PUBLIC_KEY): Promise<EntitlementStatus> {
  const token = (await getSetting(db, 'entitlement')) || null;
  const seen = await getSetting(db, 'last_seen_time');
  const lastSeen = seen ? new Date(seen) : null;
  const status = evaluate(token, now, deviceId, publicKeyHex, lastSeen);
  // advance the monotonic clock mark (never moves backwards)
  if (!lastSeen || now > lastSeen) await setSetting(db, 'last_seen_time', now.toISOString());
  return status;
}

/** Install a token received from the backend (or pasted by the user). Returns the new status or throws on bad signature. */
export async function installToken(db: Db, token: string, deviceId: string, now: Date, publicKeyHex = DEFAULT_PUBLIC_KEY): Promise<EntitlementStatus> {
  const status = evaluate(token, now, deviceId, publicKeyHex, null);
  if (status.state === 'INVALID') throw new Error('errors.entitlementInvalid');
  if (status.state === 'WRONG_DEVICE') throw new Error('errors.entitlementWrongDevice');
  await setSetting(db, 'entitlement', token.trim());
  await setSetting(db, 'last_seen_time', now.toISOString());
  return status;
}

export async function clearToken(db: Db) {
  await setSetting(db, 'entitlement', '');
}
