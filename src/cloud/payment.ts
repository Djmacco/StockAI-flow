import type { Db } from '../database/db';
import { installToken } from '../entitlement/entitlement';
import { AppError } from '../lib/errors';
import { normalizeCmPhone } from '../lib/phone';
import { getSetting, setSetting } from '../services/settings';
import type { PaymentStart, SubscriptionStatus } from './client';

/** The slice of CloudClient that payments need (so tests can pass a fake). */
export interface PaymentCloud {
  startPayment(provider: 'MTN_MOMO' | 'ORANGE_MONEY', phone: string): Promise<PaymentStart>;
  subscriptionStatus(reference?: string): Promise<SubscriptionStatus>;
}
export interface PaymentEnv { db: Db; deviceId: string; cloud: PaymentCloud; now?: () => Date }
export type Provider = 'MTN_MOMO' | 'ORANGE_MONEY';
export type PaymentResult = 'ACTIVE' | 'PENDING' | 'FAILED';

const PENDING_TTL_MS = 24 * 3600 * 1000;

/**
 * 1) validates the phone locally, 2) asks the BACKEND to create the Notch Pay charge (the customer gets the
 * PIN prompt on their phone), 3) remembers the reference so a paid-but-not-yet-confirmed payment can still be
 * verified later (even after closing the app).
 */
export async function beginPayment(env: PaymentEnv, provider: Provider, rawPhone: string): Promise<PaymentStart> {
  const phone = normalizeCmPhone(rawPhone);
  if (!phone) throw new AppError('errors.invalidPhone');
  const r = await env.cloud.startPayment(provider, phone);
  await setSetting(env.db, 'pending_payment', JSON.stringify({ ref: r.reference, at: (env.now?.() ?? new Date()).toISOString() }));
  return r;
}

export async function getPending(db: Db, now = new Date()): Promise<{ ref: string; at: string } | null> {
  try {
    const p = JSON.parse((await getSetting(db, 'pending_payment')) || 'null');
    return p && now.getTime() - new Date(p.at).getTime() < PENDING_TTL_MS ? p : null;
  } catch { return null; }
}
export const clearPending = (db: Db) => setSetting(db, 'pending_payment', '');

/**
 * Asks the backend whether the payment went through. Premium is switched on ONLY when the backend returns a
 * signed entitlement whose signature verifies on this device. The app never decides that a payment succeeded.
 */
export async function verifyPayment(env: PaymentEnv, reference: string): Promise<PaymentResult> {
  const s = await env.cloud.subscriptionStatus(reference);
  if (s.status === 'ACTIVE' && s.entitlement) {
    await installToken(env.db, s.entitlement, env.deviceId, env.now?.() ?? new Date());
    await clearPending(env.db);
    return 'ACTIVE';
  }
  if (s.status === 'FAILED') { await clearPending(env.db); return 'FAILED'; }
  return 'PENDING';
}
