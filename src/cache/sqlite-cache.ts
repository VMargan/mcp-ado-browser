/**
 * SqliteCache — persistent query cache backed by node:sqlite (built into Node >=22.5).
 *
 * Why node:sqlite (mission §2): zero native build, nothing to compile, nothing that
 * a restricted environment can block at install time. better-sqlite3 was rejected
 * for its native build step. The DB file persists across process restarts (Gate 2).
 *
 * Logical cache identity is (kind, key, version): the row carries the resource
 * version (work item Rev, etc.) so a freshness oracle can confirm the cached value
 * is still current without a full re-fetch.
 */
import { DatabaseSync } from "node:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { CacheEntry, CachePort } from "./types.js";

export interface SqliteCacheOptions {
  dbPath: string;
  defaultTtlSeconds: number;
  ttlOverrides: Record<string, number>;
}

export class SqliteCache implements CachePort {
  private db: DatabaseSync;

  constructor(private readonly opts: SqliteCacheOptions) {
    if (opts.dbPath !== ":memory:") fs.mkdirSync(path.dirname(opts.dbPath), { recursive: true });
    this.db = new DatabaseSync(opts.dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cache (
        kind         TEXT NOT NULL,
        key          TEXT NOT NULL,
        version      TEXT NOT NULL,
        value        TEXT NOT NULL,
        stored_at    INTEGER NOT NULL,
        validated_at INTEGER NOT NULL,
        PRIMARY KEY (kind, key)
      );
    `);
  }

  get<T>(kind: string, key: string): CacheEntry<T> | null {
    const row = this.db.prepare(`SELECT version, value, stored_at, validated_at FROM cache WHERE kind = ? AND key = ?`).get(kind, key) as
      | { version: string; value: string; stored_at: number; validated_at: number }
      | undefined;
    if (!row) return null;
    return { value: JSON.parse(row.value) as T, version: row.version, storedAt: row.stored_at, validatedAt: row.validated_at };
  }

  set<T>(kind: string, key: string, value: T, version: string): void {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO cache (kind, key, version, value, stored_at, validated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(kind, key) DO UPDATE SET version=excluded.version, value=excluded.value, stored_at=excluded.stored_at, validated_at=excluded.validated_at`,
      )
      .run(kind, key, version, JSON.stringify(value), now, now);
  }

  touch(kind: string, key: string): void {
    this.db.prepare(`UPDATE cache SET validated_at = ? WHERE kind = ? AND key = ?`).run(Date.now(), kind, key);
  }

  ttlFor(kind: string): number {
    const o = this.opts.ttlOverrides[kind];
    return o !== undefined ? o : this.opts.defaultTtlSeconds;
  }

  clear(): void {
    this.db.exec(`DELETE FROM cache`);
  }

  /** Test/diagnostic hook: artificially age an entry so the freshness path triggers. */
  expire(kind: string, key: string): void {
    this.db.prepare(`UPDATE cache SET validated_at = 0, stored_at = 0 WHERE kind = ? AND key = ?`).run(kind, key);
  }

  close(): void {
    this.db.close();
  }
}
