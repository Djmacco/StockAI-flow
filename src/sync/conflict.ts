/**
 * Conflict policy. Pure functions - no database access - so they are trivial to test.
 *
 *  - Immutable ledgers (stock movements, sale lines, payments, audit): same id = same record. No conflict.
 *  - Completed sales are NEVER overwritten. The only legal change is CANCELLED, and cancellation wins.
 *  - Everything else: last writer wins (updated_at, ties broken by device id), BUT
 *      * an edit always beats a delete (RESURRECTED) - deleting never silently destroys someone's edit,
 *      * quantities / balances are derived from the ledger, so they never conflict,
 *      * the losing version is stored in sync_conflicts so nothing is lost silently.
 */
type Row = Record<string, any>;

export const IMMUTABLE_TABLES = new Set([
  'stock_movements', 'sale_items', 'customer_payments', 'supplier_payments', 'purchase_items', 'audit_log',
]);

export type Resolution = 'LOCAL_WINS' | 'REMOTE_WINS' | 'CANCELLATION_WINS' | 'RESURRECTED' | 'DUPLICATE';
export interface Outcome { resolution: Resolution; winner: Row; keepLocalPending: boolean; record: boolean }

const t = (r: Row) => new Date(r.updated_at).getTime() || 0;

export function resolveConflict(table: string, local: Row, remote: Row): Outcome {
  if (IMMUTABLE_TABLES.has(table)) return { resolution: 'DUPLICATE', winner: local, keepLocalPending: false, record: false };

  if (table === 'sales') {
    const lc = local.status === 'CANCELLED', rc = remote.status === 'CANCELLED';
    // Keep the original financial figures from whichever copy we already hold; only the status may change.
    if (rc && !lc) return { resolution: 'CANCELLATION_WINS', winner: { ...local, status: 'CANCELLED', cancelled_at: remote.cancelled_at, cancel_reason: remote.cancel_reason, updated_at: remote.updated_at, version: remote.version, device_id: remote.device_id }, keepLocalPending: false, record: true };
    if (lc && !rc) return { resolution: 'CANCELLATION_WINS', winner: local, keepLocalPending: true, record: true };
    return { resolution: 'DUPLICATE', winner: local, keepLocalPending: false, record: false };
  }

  const ld = !!local.deleted_at, rd = !!remote.deleted_at;
  if (ld !== rd) {
    // edit beats delete
    return ld
      ? { resolution: 'RESURRECTED', winner: remote, keepLocalPending: false, record: true }
      : { resolution: 'RESURRECTED', winner: local, keepLocalPending: true, record: true };
  }
  const localWins = t(local) > t(remote) || (t(local) === t(remote) && String(local.device_id) >= String(remote.device_id));
  return localWins
    ? { resolution: 'LOCAL_WINS', winner: local, keepLocalPending: true, record: true }
    : { resolution: 'REMOTE_WINS', winner: remote, keepLocalPending: false, record: true };
}
