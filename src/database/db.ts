/**
 * Database abstraction.
 *
 * All access goes through ONE serialized queue so that a transaction opened by
 * one async flow can never interleave with statements from another flow
 * (the Tauri backend uses a single SQLite connection).
 *
 *  - TauriDb   : production, talks to the Rust `db_*` commands (rusqlite).
 *  - SqlJsDb   : tests + `npm run dev` in a plain browser (in-memory sql.js).
 */
export type SqlValue = string | number | null | boolean;
export type Params = SqlValue[];

export interface Db {
  select<T = Record<string, any>>(sql: string, params?: Params): Promise<T[]>;
  selectOne<T = Record<string, any>>(sql: string, params?: Params): Promise<T | undefined>;
  execute(sql: string, params?: Params): Promise<number>;
  /** Run several statements without parameters (migrations). */
  execBatch(sql: string): Promise<void>;
  /** Atomic unit of work. Nested calls become SAVEPOINTs. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

export abstract class BaseDb implements Db {
  private tail: Promise<unknown> = Promise.resolve();
  private spCounter = 0;

  protected abstract rawSelect(sql: string, params: Params): Promise<any[]>;
  protected abstract rawExecute(sql: string, params: Params): Promise<number>;
  protected abstract rawBatch(sql: string): Promise<void>;

  /** Serialize `fn` after everything queued before it. */
  protected enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.catch(() => undefined);
    return run;
  }

  select<T = Record<string, any>>(sql: string, params: Params = []) {
    return this.enqueue(() => this.rawSelect(sql, params)) as Promise<T[]>;
  }
  async selectOne<T = Record<string, any>>(sql: string, params: Params = []) {
    return (await this.select<T>(sql, params))[0];
  }
  execute(sql: string, params: Params = []) {
    return this.enqueue(() => this.rawExecute(sql, params));
  }
  execBatch(sql: string) {
    return this.enqueue(() => this.rawBatch(sql));
  }

  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    return this.enqueue(async () => {
      await this.rawExecute('BEGIN IMMEDIATE', []);
      const tx = this.makeTx();
      try {
        const out = await fn(tx);
        await this.rawExecute('COMMIT', []);
        return out;
      } catch (e) {
        try {
          await this.rawExecute('ROLLBACK', []);
        } catch {
          /* connection already rolled back */
        }
        throw e;
      }
    });
  }

  /** Db handle valid only while the outer transaction runs: bypasses the queue. */
  private makeTx(): Db {
    const self = this;
    const tx: Db = {
      select: (sql, params = []) => self.rawSelect(sql, params) as Promise<any[]>,
      selectOne: async (sql, params = []) => (await self.rawSelect(sql, params))[0],
      execute: (sql, params = []) => self.rawExecute(sql, params),
      execBatch: (sql) => self.rawBatch(sql),
      transaction: async <T>(fn: (t: Db) => Promise<T>) => {
        const name = `sp_${++self.spCounter}`;
        await self.rawExecute(`SAVEPOINT ${name}`, []);
        try {
          const out = await fn(tx);
          await self.rawExecute(`RELEASE ${name}`, []);
          return out;
        } catch (e) {
          await self.rawExecute(`ROLLBACK TO ${name}`, []);
          await self.rawExecute(`RELEASE ${name}`, []);
          throw e;
        }
      },
    };
    return tx;
  }
}

// ------------------------------------------------------------------ Tauri
export class TauriDb extends BaseDb {
  private invoke!: (cmd: string, args?: Record<string, unknown>) => Promise<any>;
  async init() {
    const { invoke } = await import('@tauri-apps/api/core');
    this.invoke = invoke;
  }
  protected rawSelect(sql: string, params: Params) {
    return this.invoke('db_select', { sql, params });
  }
  protected rawExecute(sql: string, params: Params) {
    return this.invoke('db_execute', { sql, params }) as Promise<number>;
  }
  protected async rawBatch(sql: string) {
    await this.invoke('db_execute_batch', { sql });
  }
  /** Tauri-only commands (backup / restore live in Rust). Waits for running transactions. */
  command<T = any>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    return this.enqueue(() => this.invoke(cmd, args)) as Promise<T>;
  }
}

// ------------------------------------------------------------------ sql.js
export class SqlJsDb extends BaseDb {
  constructor(private sql: any) {
    super();
  }
  static async create(wasmUrl?: string): Promise<SqlJsDb> {
    const initSqlJs = (await import('sql.js')).default as any;
    const SQL = await initSqlJs(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
    const raw = new SQL.Database();
    raw.exec('PRAGMA foreign_keys = ON;');
    return new SqlJsDb(raw);
  }
  protected async rawSelect(sql: string, params: Params) {
    const stmt = this.sql.prepare(sql);
    try {
      stmt.bind(params.map(norm));
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally {
      stmt.free();
    }
  }
  protected async rawExecute(sql: string, params: Params) {
    this.sql.run(sql, params.map(norm));
    return this.sql.getRowsModified();
  }
  protected async rawBatch(sql: string) {
    this.sql.exec(sql);
  }
}
const norm = (v: SqlValue) => (typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v);
