/** Cache contract used by AdoClient. Implemented by SqliteCache (node:sqlite). */
export interface CacheEntry<T> {
  value: T;
  /** Epoch ms when the full value was last fetched/stored. */
  storedAt: number;
  /** Epoch ms when the value was last confirmed fresh (>= storedAt). */
  validatedAt: number;
  /** Resource version marker (work item Rev, PR last-update, feed etag/date...). */
  version: string;
}

export interface CachePort {
  get<T>(kind: string, key: string): CacheEntry<T> | null;
  set<T>(kind: string, key: string, value: T, version: string): void;
  /** Refresh validatedAt to now WITHOUT changing the value (freshness confirmed cheaply). */
  touch(kind: string, key: string): void;
  /** Effective TTL (seconds) for a resource kind, honoring per-resource overrides. */
  ttlFor(kind: string): number;
  clear(): void;
  close(): void;
}
