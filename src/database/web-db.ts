import initSqlJs from 'sql.js';
import { BaseDb, type Params, type SqlValue } from './db';

const DATABASE_NAME = 'stockflow-web-v1';
const STORE_NAME = 'databases';
const DATABASE_KEY = 'shop';

/** Browser SQLite persisted in IndexedDB. A refresh or a closed tab must never erase a shop's local work. */
export class WebDb extends BaseDb {
  private transactionDepth = 0;

  private constructor(private readonly sql: any) { super(); }

  static async create(wasmUrl?: string): Promise<WebDb> {
    const SQL = await initSqlJs(wasmUrl ? { locateFile: () => wasmUrl } : undefined);
    const saved = await loadDatabase();
    const db = new WebDb(saved ? new SQL.Database(saved) : new SQL.Database());
    db.sql.exec('PRAGMA foreign_keys = ON;');
    return db;
  }

  protected async rawSelect(sql: string, params: Params) {
    const stmt = this.sql.prepare(sql);
    try {
      stmt.bind(params.map(norm));
      const rows: any[] = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      return rows;
    } finally { stmt.free(); }
  }

  protected async rawExecute(sql: string, params: Params) {
    this.sql.run(sql, params.map(norm));
    const command = sql.trim().split(/\s+/, 1)[0].toUpperCase();
    if (command === 'BEGIN' || command === 'SAVEPOINT') this.transactionDepth++;
    else if (command === 'RELEASE') this.transactionDepth = Math.max(0, this.transactionDepth - 1);
    else if (command === 'COMMIT') this.transactionDepth = 0;
    else if (command === 'ROLLBACK') {
      if (/^ROLLBACK\s+TO\b/i.test(sql.trim())) return this.sql.getRowsModified();
      this.transactionDepth = 0;
    }

    if (command === 'COMMIT' || (this.transactionDepth === 0 && !['BEGIN', 'SAVEPOINT', 'RELEASE', 'ROLLBACK', 'PRAGMA', 'SELECT'].includes(command))) {
      await saveDatabase(this.sql.export());
    }
    return this.sql.getRowsModified();
  }

  protected async rawBatch(sql: string) {
    this.sql.exec(sql);
    if (this.transactionDepth === 0) await saveDatabase(this.sql.export());
  }
}

const norm = (value: SqlValue) => typeof value === 'boolean' ? (value ? 1 : 0) : value === undefined ? null : value;

let openPromise: Promise<IDBDatabase> | null = null;
function openStore(): Promise<IDBDatabase> {
  if (openPromise) return openPromise;
  openPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { openPromise = null; reject(request.error ?? new Error('Could not open local storage.')); };
    request.onblocked = () => reject(new Error('Local storage is busy in another tab. Close duplicate StockFlow tabs and try again.'));
  });
  return openPromise;
}

async function loadDatabase(): Promise<Uint8Array | null> {
  const db = await openStore();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(DATABASE_KEY);
    request.onsuccess = () => {
      const value = request.result as ArrayBuffer | Uint8Array | undefined;
      resolve(value ? new Uint8Array(value instanceof Uint8Array ? value : value) : null);
    };
    request.onerror = () => reject(request.error ?? new Error('Could not read local shop data.'));
  });
}

async function saveDatabase(bytes: Uint8Array): Promise<void> {
  const db = await openStore();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(bytes, DATABASE_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('Could not save local shop data.'));
    tx.onabort = () => reject(tx.error ?? new Error('Saving local shop data was interrupted.'));
  });
}
