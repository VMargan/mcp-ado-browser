/** Shared builders for the verify gates. */
import { AdoClient } from "../../src/ado/client.js";
import { HostResolver } from "../../src/ado/hosts.js";
import { VersionRegistry } from "../../src/ado/versions.js";
import { MockTransport } from "../../src/transport/mock-transport.js";
import { SqliteCache } from "../../src/cache/sqlite-cache.js";
import { CachePort } from "../../src/cache/types.js";

export const TEST_ORG = "contoso";
export const TEST_PROJECT = "demo";

export function makeMockTransport(mockBaseUrl: string): MockTransport {
  return new MockTransport(mockBaseUrl);
}

export function makeClient(opts: { mockBaseUrl: string; transport?: MockTransport; cache?: CachePort | null; apiVersion?: string | null }): AdoClient {
  const transport = opts.transport ?? new MockTransport(opts.mockBaseUrl);
  return new AdoClient({
    transport,
    hosts: new HostResolver(TEST_ORG),
    versions: new VersionRegistry(opts.apiVersion ?? null),
    project: TEST_PROJECT,
    cache: opts.cache ?? null,
  });
}

export function memCache(ttlSeconds = 900, overrides: Record<string, number> = {}): SqliteCache {
  return new SqliteCache({ dbPath: ":memory:", defaultTtlSeconds: ttlSeconds, ttlOverrides: overrides });
}

export function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

export function deepEqualish(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
