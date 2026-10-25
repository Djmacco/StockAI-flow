import type { Db } from '../database/db';
import type { AppContext } from './context';
import { insertRow } from './repo';
import type { AuditEntry } from './types';

/** Append an audit entry inside the caller's transaction. */
export async function audit(
  tx: Db, ctx: AppContext, action: string, entityType?: string, entityId?: string, metadata?: Record<string, unknown>,
) {
  await insertRow(tx, ctx, 'audit_log', {
    user_id: ctx.user?.id ?? null,
    user_name: ctx.user?.full_name ?? null,
    action,
    entity_type: entityType ?? null,
    entity_id: entityId ?? null,
    metadata: metadata ? JSON.stringify(metadata) : null,
  });
}

export async function listAudit(ctx: AppContext, limit = 200, offset = 0): Promise<AuditEntry[]> {
  return ctx.db.select<AuditEntry>('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT ? OFFSET ?', [limit, offset]);
}
