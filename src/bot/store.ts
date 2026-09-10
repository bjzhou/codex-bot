import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

/** Local durable state. All transactions are synchronous; never hold one over network I/O. */
export class Store {
  private db: DatabaseSync;
  private lock: DatabaseSync;
  constructor(directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const lockPath = join(directory, 'instance.sqlite');
    this.lock = new DatabaseSync(lockPath);
    chmodSync(lockPath, 0o600);
    try { this.lock.exec('PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;'); }
    catch { this.lock.close(); throw new Error('此状态目录已有 Bot 进程运行，请先停止原进程。'); }
    const path = join(directory, 'bot.sqlite');
    try {
      this.db = new DatabaseSync(path); chmodSync(path, 0o600);
      this.db.exec('PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);');
    } catch (error) { this.lock.close(); throw error; }
  }
  get<T>(key: string): T | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key);
    return row ? JSON.parse(String(row.value)) : undefined;
  }
  put(key: string, value: unknown) {
    this.db.prepare('INSERT INTO state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
  }
  delete(key: string) { this.db.prepare('DELETE FROM state WHERE key = ?').run(key); }
  list<T>(prefix: string): [string, T][] {
    return this.db.prepare('SELECT key, value FROM state WHERE key >= ? AND key < ? ORDER BY key').all(prefix, `${prefix}\uffff`)
      .map(row => [String(row.key), JSON.parse(String(row.value))]);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      if (result instanceof Promise) throw new Error('SQLite transaction callbacks must be synchronous');
      this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close() { this.db.close(); this.lock.close(); }
}
