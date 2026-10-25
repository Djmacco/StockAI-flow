import type { Db } from '../database/db';
import type { AppContext } from './context';
import { getSetting, nextSequence } from './settings';

/**
 * Document numbers: PREFIX-YEAR-0001 (restarting every year), e.g. CNT-2026-0003 (stock counts), FAC-2026-0012 (invoices), PRO-2026-0004 (proformas).
 *
 * A counter lives on one PC. When several PCs share the same data (shop network or cloud account) two of them could
 * issue "FAC-2026-0005" at the same time, so on a shared setup each PC gets its own series with a short tag:
 * FAC-2026-A1B2-0005. A shop with a single PC never sees the tag.
 */
export async function isSharedSetup(db: Db): Promise<boolean> {
  const mode = await getSetting(db, 'net_mode');
  if (mode === 'host' || mode === 'client') return true;
  return !!(await getSetting(db, 'cloud_device_token')) || !!(await getSetting(db, 'cloud_session'));
}

export const deviceTag = (ctx: AppContext) => ctx.deviceId.replace(/-/g, '').slice(-4).toUpperCase();

export async function nextNumber(tx: Db, ctx: AppContext, prefix: string): Promise<string> {
  const clean = prefix.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6) || 'DOC';
  const year = ctx.now().getFullYear();
  const tag = (await isSharedSetup(tx)) ? deviceTag(ctx) : '';
  const n = await nextSequence(tx, `${clean}_${year}${tag ? `_${tag}` : ''}`);
  return `${clean}-${year}-${tag ? `${tag}-` : ''}${String(n).padStart(4, '0')}`;
}
