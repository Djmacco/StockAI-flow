import { type AppContext, requirePermission, runTx } from '../services/context';
import { audit } from '../services/audit';
import { updateRow } from '../services/repo';
import { fail } from '../lib/errors';

/** Columns that are bookkeeping or derived from the ledger: never restored from an old snapshot. */
const SKIP = new Set(['id', 'created_at', 'updated_at', 'device_id', 'version', 'sync_status', 'quantity', 'expiry_date', 'quantity_remaining']);
const MUTABLE = new Set(['categories', 'suppliers', 'customers', 'products', 'expenses']);

/**
 * "Keep my version": the copy that lost an automatic conflict is re-applied as a NEW edit
 * (so it syncs like any other change). Nothing is ever deleted from sync_conflicts' history.
 */
export async function restoreLocalVersion(ctx: AppContext, conflictId: string) {
  requirePermission(ctx, 'sync.manage');
  const c = await ctx.db.selectOne<any>('SELECT * FROM sync_conflicts WHERE id = ?', [conflictId]);
  if (!c || !MUTABLE.has(c.entity_type)) return fail('errors.notRestorable');
  const local = JSON.parse(c.local_payload);
  const patch: Record<string, any> = {};
  for (const [k, v] of Object.entries(local)) if (!SKIP.has(k)) patch[k] = v;
  await runTx(ctx, async (tx) => {
    await updateRow(tx, ctx, c.entity_type, c.entity_id, patch);
    await tx.execute("UPDATE sync_conflicts SET status = 'REVIEWED', resolved_at = ? WHERE id = ?", [ctx.now().toISOString(), conflictId]);
    await audit(tx, ctx, 'sync.conflict_restored', c.entity_type, c.entity_id);
  });
}
