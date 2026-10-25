/**
 * Wire protocol between the desktop SyncEngine and the (future) NestJS backend.
 * Documented for the backend team in docs/SYNC_PROTOCOL.md.
 */
export type Operation = 'CREATE' | 'UPDATE' | 'DELETE';

export interface PushChange {
  /** sync_queue.id — idempotency key: replaying the same opId must never create a duplicate. */
  opId: string;
  entityType: string;
  entityId: string;
  operation: Operation;
  /** Server version this edit was based on (0 for a brand-new record). */
  baseVersion: number;
  data: Record<string, any>;
}

export interface ServerRecord {
  entityType: string;
  entityId: string;
  version: number;
  deleted: boolean;
  data: Record<string, any>;
  /** Shop hub only: which PC made this change (so the others can say "Caisse 2 sold ..."). */
  deviceId?: string;
  deviceName?: string;
}

export type PushStatus = 'ACCEPTED' | 'DUPLICATE' | 'CONFLICT' | 'REJECTED';
export interface PushResult {
  opId: string;
  entityId: string;
  status: PushStatus;
  /** Version assigned by the server (ACCEPTED / DUPLICATE). */
  version?: number;
  /** Current server copy (CONFLICT). */
  serverRecord?: ServerRecord;
  error?: string;
}

export interface PushRequest { deviceId: string; changes: PushChange[] }
export interface PushResponse { results: PushResult[] }

export interface PullResponse {
  records: (ServerRecord & { cursor: string })[];
  nextCursor: string;
  hasMore: boolean;
  /** Shop hub only: identity of the store and the end of its change log (lets a client notice a restored / replaced main PC). */
  hubId?: string;
  head?: string;
  /** The change this store holds at the client's position (null when reading from the beginning). */
  anchor?: { entityType?: string; entityId?: string; version?: number; missing?: boolean } | null;
}

export interface SyncTransport {
  push(req: PushRequest): Promise<PushResponse>;
  pull(since: string, deviceId: string, limit: number): Promise<PullResponse>;
}

/** Thrown by transports. `kind` lets the engine tell "no network" from "not allowed". */
export class SyncTransportError extends Error {
  constructor(public kind: 'NETWORK' | 'AUTH' | 'PREMIUM_REQUIRED' | 'SERVER', message: string) {
    super(message);
  }
}
