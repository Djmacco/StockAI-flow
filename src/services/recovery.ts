import type { Db } from '../database/db';
import { fail } from '../lib/errors';
import { audit } from './audit';
import { hashPassword, safeEqual, validatePassword } from './auth';
import { type AppContext, requirePermission, runTx } from './context';
import { getById, updateRow } from './repo';
import { getSetting, setSetting } from './settings';
import type { User } from './types';

/**
 * RECOVERY KEY - the offline way back in when the administrator forgets the password.
 *  - 20 random characters (100 bits), shown ONCE; only a salted PBKDF2 hash is stored on the device.
 *  - Single use: a successful reset immediately issues a NEW key.
 *  - 5 wrong attempts lock recovery for 15 minutes.
 *  - Only an ADMIN account can be recovered; every use is written to the audit log.
 * Whoever holds the key can reset the admin password, so it must be kept somewhere safe (printed / safe).
 */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I: easy to read and type
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

export const normalizeKey = (k: string) => k.toUpperCase().replace(/[^A-Z0-9]/g, '');

export function newRecoveryKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(20));
  const chars = [...bytes].map((b) => ALPHABET[b % 32]); // 256 % 32 == 0 -> no modulo bias
  return Array.from({ length: 5 }, (_, i) => chars.slice(i * 4, i * 4 + 4).join('')).join('-');
}

async function storeKey(db: Db, key: string, now: Date) {
  const h = await hashPassword(normalizeKey(key));
  await setSetting(db, 'recovery_hash', h.hash);
  await setSetting(db, 'recovery_salt', h.salt);
  await setSetting(db, 'recovery_iter', String(h.iterations));
  await setSetting(db, 'recovery_created_at', now.toISOString());
  await setSetting(db, 'recovery_failed', '0');
  await setSetting(db, 'recovery_locked_until', '');
}

/** Create the first key (during setup, or later for installs that predate this feature). */
export async function issueRecoveryKey(ctx: AppContext): Promise<string> {
  const key = newRecoveryKey();
  await storeKey(ctx.db, key, ctx.now());
  return key;
}

export async function recoveryStatus(db: Db): Promise<{ exists: boolean; createdAt: string | null }> {
  const hash = await getSetting(db, 'recovery_hash');
  return { exists: !!hash, createdAt: (await getSetting(db, 'recovery_created_at')) || null };
}

/** Logged-in administrator creates a replacement key (old one stops working). Needs the current password. */
export async function regenerateRecoveryKey(ctx: AppContext, currentPassword: string): Promise<string> {
  requirePermission(ctx, 'users.manage');
  const me = await getById<User>(ctx.db, 'users', ctx.user!.id);
  if (!me) return fail('errors.notFound');
  const { hash } = await hashPassword(currentPassword, me.password_salt, me.password_iterations);
  if (!safeEqual(hash, me.password_hash)) fail('errors.invalidCredentials');
  return runTx(ctx, async (tx) => {
    const key = newRecoveryKey();
    await storeKey(tx, key, ctx.now());
    await audit(tx, ctx, 'recovery.key_regenerated', 'user', me.id);
    return key;
  });
}

/** Offline password reset for an administrator. Returns the NEW recovery key (the used one is burned). */
export async function resetPasswordWithRecoveryKey(ctx: AppContext, input: { username: string; key: string; newPassword: string }): Promise<string> {
  const db = ctx.db;
  const now = ctx.now();
  const lockedUntil = await getSetting(db, 'recovery_locked_until');
  if (lockedUntil && new Date(lockedUntil) > now) fail('errors.recoveryLocked', { minutes: Math.ceil((new Date(lockedUntil).getTime() - now.getTime()) / 60000) });
  const hash = await getSetting(db, 'recovery_hash');
  if (!hash) return fail('errors.noRecoveryKey');

  const salt = await getSetting(db, 'recovery_salt');
  const iterations = parseInt(await getSetting(db, 'recovery_iter'), 10) || 150_000;
  const given = await hashPassword(normalizeKey(input.key), salt, iterations);
  if (!safeEqual(given.hash, hash)) {
    const failed = (parseInt(await getSetting(db, 'recovery_failed'), 10) || 0) + 1;
    if (failed >= MAX_ATTEMPTS) {
      await setSetting(db, 'recovery_failed', '0');
      await setSetting(db, 'recovery_locked_until', new Date(now.getTime() + LOCK_MINUTES * 60000).toISOString());
    } else await setSetting(db, 'recovery_failed', String(failed));
    return fail('errors.recoveryKeyInvalid');
  }

  const user = await db.selectOne<User>('SELECT * FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL', [input.username.trim()]);
  if (!user || user.role_code !== 'ADMIN') return fail('errors.recoveryNotAdmin');
  if (!user.active) return fail('errors.accountDisabled');
  validatePassword(input.newPassword);

  const pw = await hashPassword(input.newPassword);
  const actor = { id: user.id, username: user.username, full_name: user.full_name, role_code: user.role_code };
  const c2: AppContext = { ...ctx, user: actor };
  return runTx(c2, async (tx) => {
    await updateRow(tx, c2, 'users', user.id, { password_hash: pw.hash, password_salt: pw.salt, password_iterations: pw.iterations, failed_attempts: 0, locked_until: null });
    const fresh = newRecoveryKey();           // single use: burn the old key
    await storeKey(tx, fresh, now);
    await audit(tx, c2, 'recovery.password_reset', 'user', user.id);
    return fresh;
  });
}
