import type { Db } from '../database/db';
import { fail } from '../lib/errors';
import { dataBus } from '../lib/events';
import type { Permission } from './permissions';

export interface SessionUser {
  id: string;
  username: string;
  full_name: string;
  role_code: string;
}

export interface AppContext {
  db: Db;
  deviceId: string;
  user: SessionUser | null;
  permissions: ReadonlySet<string>;
  /** Injectable clock (tests). */
  now: () => Date;
  /** Desktop shop-network checkout approval. Missing only in isolated service tests / non-desktop previews. */
  authorizeShopSale?: (saleId: string, items: { productId: string; quantity: number }[]) => Promise<void>;
  releaseShopSale?: (saleId: string) => Promise<void>;
}

export const can = (ctx: AppContext, p: Permission) => ctx.permissions.has(p);

export function requirePermission(ctx: AppContext, p: Permission): void {
  if (!ctx.user) fail('errors.notAuthenticated');
  if (!ctx.permissions.has(p)) fail('errors.forbidden', { permission: p });
}

export function requireUser(ctx: AppContext): SessionUser {
  if (!ctx.user) return fail('errors.notAuthenticated');
  return ctx.user!;
}

/** Run a unit of work atomically, then tell the UI + sync engine something changed. */
export async function runTx<T>(ctx: AppContext, fn: (tx: Db) => Promise<T>): Promise<T> {
  const out = await ctx.db.transaction(fn);
  dataBus.emit();
  return out;
}
