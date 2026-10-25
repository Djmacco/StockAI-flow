import type { Db } from '../database/db';
import { fail } from '../lib/errors';
import { uuid } from '../lib/ids';
import { audit } from './audit';
import { type AppContext, type SessionUser, requirePermission, runTx } from './context';
import { DEFAULT_ROLE_NAMES, DEFAULT_ROLE_PERMISSIONS, PERMISSIONS, ROLE_ADMIN, type Permission } from './permissions';
import { getById, insertRow, updateRow } from './repo';
import { setShopSetting, snapshotRolePermissions } from './settings';
import type { User } from './types';

const ITERATIONS = 150_000;
const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 5;

const toHex = (b: ArrayBuffer | Uint8Array) => [...new Uint8Array(b as ArrayBuffer)].map((x) => x.toString(16).padStart(2, '0')).join('');
const fromHex = (h: string) => new Uint8Array(h.match(/.{2}/g)!.map((x) => parseInt(x, 16)));

/** PBKDF2-SHA256 with a per-user random salt. Plain-text passwords are never stored. */
export async function hashPassword(password: string, saltHex?: string, iterations = ITERATIONS) {
  const salt = saltHex ? fromHex(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations }, key, 256);
  return { hash: toHex(bits), salt: toHex(salt), iterations };
}

/** Constant-time comparison. */
export function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function validatePassword(pw: string) {
  if (pw.length < 6) fail('errors.passwordTooShort', { min: 6 });
}

// ------------------------------------------------------------------ roles
/**
 * Creates the default roles ONCE. Existing roles are left exactly as the administrator configured them
 * (a removed permission must stay removed after a restart).
 */
export async function seedRoles(db: Db) {
  for (const [code, perms] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    const created = await db.execute('INSERT OR IGNORE INTO roles (code, name, is_system) VALUES (?,?,1)', [code, DEFAULT_ROLE_NAMES[code]]);
    if (created > 0) for (const p of perms) await db.execute('INSERT OR IGNORE INTO role_permissions (role_code, permission) VALUES (?,?)', [code, p]);
  }
}

export async function permissionsForRole(db: Db, role: string): Promise<Set<string>> {
  if (role === ROLE_ADMIN) return new Set(PERMISSIONS); // admin is always full access
  const rows = await db.select<{ permission: string }>('SELECT permission FROM role_permissions WHERE role_code = ?', [role]);
  return new Set(rows.map((r) => r.permission));
}

export async function listRolePermissions(db: Db): Promise<Record<string, string[]>> {
  const rows = await db.select<{ role_code: string; permission: string }>('SELECT * FROM role_permissions');
  const out: Record<string, string[]> = { ADMIN: [...PERMISSIONS], MANAGER: [], CASHIER: [] };
  rows.forEach((r) => (out[r.role_code] ??= []).push(r.permission));
  out.ADMIN = [...PERMISSIONS];
  return out;
}

export async function setRolePermission(ctx: AppContext, role: string, permission: Permission, allowed: boolean) {
  requirePermission(ctx, 'users.manage');
  if (role === ROLE_ADMIN) fail('errors.adminLocked');
  await runTx(ctx, async (tx) => {
    if (allowed) await tx.execute('INSERT OR IGNORE INTO role_permissions (role_code, permission) VALUES (?,?)', [role, permission]);
    else await tx.execute('DELETE FROM role_permissions WHERE role_code = ? AND permission = ?', [role, permission]);
    await snapshotRolePermissions(tx, ctx);           // so every PC (and a restored one) gets the same permissions
    await audit(tx, ctx, 'role.permission_changed', 'role', role, { permission, allowed });
  });
}

// ------------------------------------------------------------------ first-run setup
export async function hasAnyUser(db: Db): Promise<boolean> {
  return ((await db.selectOne<{ n: number }>('SELECT COUNT(*) n FROM users WHERE deleted_at IS NULL'))?.n ?? 0) > 0;
}

export async function createInitialAdmin(
  ctx: AppContext,
  input: { business_name: string; branch_name?: string; full_name: string; username: string; password: string },
): Promise<SessionUser> {
  if (await hasAnyUser(ctx.db)) fail('errors.setupAlreadyDone');
  validatePassword(input.password);
  if (!input.username.trim() || !input.full_name.trim() || !input.business_name.trim()) fail('errors.requiredFields');
  const pw = await hashPassword(input.password);
  const user = await runTx(ctx, async (tx) => {
    await seedRoles(tx);
    const u = await insertRow<User>(tx, ctx, 'users', {
      username: input.username.trim(), full_name: input.full_name.trim(), email: null,
      password_hash: pw.hash, password_salt: pw.salt, password_iterations: pw.iterations,
      role_code: ROLE_ADMIN, active: 1, failed_attempts: 0, locked_until: null, last_login_at: null,
    });
    await setShopSetting(tx, ctx, 'business_name', input.business_name.trim());
    await setShopSetting(tx, ctx, 'branch_name', (input.branch_name ?? 'Agence principale').trim());
    await tx.execute("INSERT INTO app_settings (key, value, updated_at) VALUES ('setup_completed','1',?) ON CONFLICT(key) DO UPDATE SET value='1'", [ctx.now().toISOString()]);
    await audit(tx, { ...ctx, user: { id: u.id, username: u.username, full_name: u.full_name, role_code: ROLE_ADMIN } }, 'user.created', 'user', u.id, { role: ROLE_ADMIN });
    return u;
  });
  return { id: user.id, username: user.username, full_name: user.full_name, role_code: user.role_code };
}

// ------------------------------------------------------------------ login (works fully offline)
export async function login(ctx: AppContext, username: string, password: string): Promise<SessionUser> {
  const user = await ctx.db.selectOne<User>('SELECT * FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL', [username.trim()]);
  const now = ctx.now();
  // Same error for unknown user / wrong password (no user enumeration).
  if (!user) return fail('errors.invalidCredentials');
  if (user.locked_until && new Date(user.locked_until) > now) {
    const mins = Math.ceil((new Date(user.locked_until).getTime() - now.getTime()) / 60000);
    return fail('errors.accountLocked', { minutes: mins });
  }
  if (!user.active) return fail('errors.accountDisabled');
  const { hash } = await hashPassword(password, user.password_salt, user.password_iterations);
  if (!safeEqual(hash, user.password_hash)) {
    const attempts = user.failed_attempts + 1;
    const lock = attempts >= MAX_ATTEMPTS ? new Date(now.getTime() + LOCK_MINUTES * 60000).toISOString() : null;
    await ctx.db.execute('UPDATE users SET failed_attempts = ?, locked_until = ? WHERE id = ?', [lock ? 0 : attempts, lock, user.id]);
    return fail('errors.invalidCredentials');
  }
  const session: SessionUser = { id: user.id, username: user.username, full_name: user.full_name, role_code: user.role_code };
  await runTx({ ...ctx, user: session }, async (tx) => {
    await tx.execute('UPDATE users SET failed_attempts = 0, locked_until = NULL, last_login_at = ? WHERE id = ?', [now.toISOString(), user.id]);
    await audit(tx, { ...ctx, user: session }, 'user.login', 'user', user.id);
  });
  return session;
}

export async function logout(ctx: AppContext) {
  if (ctx.user) await runTx(ctx, (tx) => audit(tx, ctx, 'user.logout', 'user', ctx.user!.id));
}

// ------------------------------------------------------------------ user management
export async function listUsers(ctx: AppContext) {
  requirePermission(ctx, 'users.manage');
  return ctx.db.select<User>('SELECT * FROM users WHERE deleted_at IS NULL ORDER BY full_name');
}

export async function createUser(ctx: AppContext, input: { username: string; full_name: string; password: string; role_code: string }) {
  requirePermission(ctx, 'users.manage');
  validatePassword(input.password);
  const dup = await ctx.db.selectOne('SELECT 1 x FROM users WHERE lower(username) = lower(?) AND deleted_at IS NULL', [input.username.trim()]);
  if (dup) fail('errors.usernameTaken');
  const pw = await hashPassword(input.password);
  return runTx(ctx, async (tx) => {
    const u = await insertRow<User>(tx, ctx, 'users', {
      username: input.username.trim(), full_name: input.full_name.trim(), email: null,
      password_hash: pw.hash, password_salt: pw.salt, password_iterations: pw.iterations,
      role_code: input.role_code, active: 1, failed_attempts: 0, locked_until: null, last_login_at: null,
    });
    await audit(tx, ctx, 'user.created', 'user', u.id, { role: input.role_code });
    return u;
  });
}

export async function updateUser(ctx: AppContext, id: string, patch: { full_name?: string; role_code?: string; active?: boolean; password?: string }) {
  requirePermission(ctx, 'users.manage');
  const target = await getById<User>(ctx.db, 'users', id);
  if (!target) return fail('errors.notFound');
  if (id === ctx.user!.id && (patch.active === false || (patch.role_code && patch.role_code !== target.role_code))) fail('errors.cannotEditSelf');
  const data: Record<string, any> = {};
  if (patch.full_name !== undefined) data.full_name = patch.full_name.trim();
  if (patch.role_code !== undefined) data.role_code = patch.role_code;
  if (patch.active !== undefined) data.active = patch.active ? 1 : 0;
  if (patch.password) {
    validatePassword(patch.password);
    const pw = await hashPassword(patch.password);
    Object.assign(data, { password_hash: pw.hash, password_salt: pw.salt, password_iterations: pw.iterations, failed_attempts: 0, locked_until: null });
  }
  await runTx(ctx, async (tx) => {
    await updateRow(tx, ctx, 'users', id, data);
    await audit(tx, ctx, patch.role_code ? 'user.role_changed' : 'user.updated', 'user', id, { role: patch.role_code, active: patch.active, passwordChanged: !!patch.password });
  });
}

export async function changeOwnPassword(ctx: AppContext, oldPw: string, newPw: string) {
  if (!ctx.user) fail('errors.notAuthenticated');
  validatePassword(newPw);
  const user = (await getById<User>(ctx.db, 'users', ctx.user!.id))!;
  const { hash } = await hashPassword(oldPw, user.password_salt, user.password_iterations);
  if (!safeEqual(hash, user.password_hash)) fail('errors.invalidCredentials');
  const pw = await hashPassword(newPw);
  await runTx(ctx, async (tx) => {
    await updateRow(tx, ctx, 'users', user.id, { password_hash: pw.hash, password_salt: pw.salt, password_iterations: pw.iterations });
    await audit(tx, ctx, 'user.password_changed', 'user', user.id);
  });
}

export const newId = uuid;
