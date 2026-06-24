/** Gate 2 — SQLite cache + freshness, measured by fetchCount + URL spy (not timing). */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { GateRun } from "../report.js";
import { assert, makeClient } from "../helpers.js";
import { SqliteCache } from "../../../src/cache/sqlite-cache.js";
import { MockTransport } from "../../../src/transport/mock-transport.js";
import { startMock, revState } from "../../mock-fixtures.js";

const isBatch = (u: string) => /_apis\/wit\/workitemsbatch/i.test(u);
const isFull = (u: string) => /_apis\/wit\/workitems\/\d+(\?|$)/i.test(u);

export async function gate2(g: GateRun): Promise<void> {
  const { server, baseUrl } = await startMock();
  const snapshot = revState[101];
  try {
    // 2.1 — fresh hit within TTL => ZERO network on the 2nd identical call.
    await g.assert("2.1 two identical calls within TTL: 2nd does 0 network calls", async () => {
      const t = new MockTransport(baseUrl);
      const cache = new SqliteCache({ dbPath: ":memory:", defaultTtlSeconds: 900, ttlOverrides: {} });
      const c = makeClient({ mockBaseUrl: baseUrl, transport: t, cache });
      await c.getWorkItem(101);
      const afterFirst = t.fetchCount;
      assert(afterFirst >= 1, "first call made no network call");
      t.resetCounters();
      const again = await c.getWorkItem(101);
      assert(t.fetchCount === 0, `2nd call made ${t.fetchCount} network calls (expected 0)`);
      assert(again.id === 101, "cached value wrong");
      cache.close();
      return `1st=${afterFirst} calls, 2nd=0 calls`;
    });

    // 2.2 — stale + rev UNCHANGED => exactly 1 call (freshness batch), 0 full fetch.
    await g.assert("2.2 stale + rev unchanged: exactly 1 freshness-batch call, 0 full fetch", async () => {
      revState[101] = snapshot;
      const t = new MockTransport(baseUrl);
      const cache = new SqliteCache({ dbPath: ":memory:", defaultTtlSeconds: 900, ttlOverrides: {} });
      const c = makeClient({ mockBaseUrl: baseUrl, transport: t, cache });
      await c.getWorkItem(101); // store rev
      cache.expire("workitem", "101"); // simulate TTL elapsed
      t.resetCounters();
      await c.getWorkItem(101);
      assert(t.fetchCount === 1, `expected exactly 1 call, got ${t.fetchCount}: ${t.calledUrls.join(", ")}`);
      assert(isBatch(t.calledUrls[0]), `expected the single call to be workitemsbatch, was ${t.calledUrls[0]}`);
      assert(!t.calledUrls.some(isFull), "a full work-item fetch was made despite unchanged rev");
      cache.close();
      return `1 call (batch), 0 full fetch`;
    });

    // 2.3 — stale + rev CHANGED => freshness batch THEN full fetch; cache updated; new value served.
    await g.assert("2.3 stale + rev changed: freshness then full fetch, cache updated, new value served", async () => {
      revState[101] = snapshot;
      const t = new MockTransport(baseUrl);
      const cache = new SqliteCache({ dbPath: ":memory:", defaultTtlSeconds: 900, ttlOverrides: {} });
      const c = makeClient({ mockBaseUrl: baseUrl, transport: t, cache });
      const first = await c.getWorkItem(101);
      assert(first.rev === snapshot, "first rev wrong");
      cache.expire("workitem", "101");
      revState[101] = snapshot + 1; // bump rev (resource changed)
      t.resetCounters();
      const updated = await c.getWorkItem(101);
      assert(t.calledUrls.some(isBatch), "no freshness batch call");
      assert(t.calledUrls.some(isFull), "no full fetch after rev change");
      assert(t.fetchCount === 2, `expected 2 calls (batch+full), got ${t.fetchCount}`);
      assert(updated.rev === snapshot + 1, `expected updated rev ${snapshot + 1}, got ${updated.rev}`);
      const peek = cache.get<{ rev: number }>("workitem", "101");
      assert(peek?.version === String(snapshot + 1), "cache not updated with new version");
      cache.close();
      return `batch+full=2 calls, rev ${snapshot}->${snapshot + 1}`;
    });

    // 2.4 — persistence across a process "restart" (close + reopen same DB file).
    await g.assert("2.4 cache survives a restart (SQLite persistence)", async () => {
      revState[101] = snapshot;
      const dbPath = path.join(os.tmpdir(), `ado-verify-cache-${process.pid}.sqlite`);
      try {
        fs.rmSync(dbPath, { force: true });
      } catch {}
      const t1 = new MockTransport(baseUrl);
      const cache1 = new SqliteCache({ dbPath, defaultTtlSeconds: 900, ttlOverrides: {} });
      const c1 = makeClient({ mockBaseUrl: baseUrl, transport: t1, cache: cache1 });
      await c1.getWorkItem(101);
      cache1.close(); // "process exit"

      const t2 = new MockTransport(baseUrl);
      const cache2 = new SqliteCache({ dbPath, defaultTtlSeconds: 900, ttlOverrides: {} });
      const c2 = makeClient({ mockBaseUrl: baseUrl, transport: t2, cache: cache2 });
      t2.resetCounters();
      const wi = await c2.getWorkItem(101);
      assert(t2.fetchCount === 0, `expected 0 network after restart hit, got ${t2.fetchCount}`);
      assert(wi.id === 101, "restored value wrong");
      cache2.close();
      fs.rmSync(dbPath, { force: true });
      return "served from persisted DB, 0 network";
    });

    // 2.5 — TTL=0 forces a full refetch every time.
    await g.assert("2.5 TTL=0 forces re-fetch (cache disabled for the resource)", async () => {
      revState[101] = snapshot;
      const t = new MockTransport(baseUrl);
      const cache = new SqliteCache({ dbPath: ":memory:", defaultTtlSeconds: 900, ttlOverrides: { workitem: 0 } });
      const c = makeClient({ mockBaseUrl: baseUrl, transport: t, cache });
      await c.getWorkItem(101);
      t.resetCounters();
      await c.getWorkItem(101);
      assert(t.calledUrls.some(isFull) && t.fetchCount >= 1, `TTL=0 did not force a full refetch (${t.calledUrls.join(",")})`);
      cache.close();
      return "full refetch every call";
    });

    // 2.6 — cache identity includes version (id + rev) to avoid stale collisions.
    await g.assert("2.6 cache entry is versioned (id + rev) to avoid collisions", async () => {
      revState[101] = snapshot;
      const cache = new SqliteCache({ dbPath: ":memory:", defaultTtlSeconds: 900, ttlOverrides: {} });
      const c = makeClient({ mockBaseUrl: baseUrl, transport: new MockTransport(baseUrl), cache });
      await c.getWorkItem(101);
      const e = cache.get("workitem", "101");
      assert(e?.version === String(snapshot), `version not recorded (got ${e?.version})`);
      cache.close();
      return `version=${e!.version}`;
    });
  } finally {
    revState[101] = snapshot;
    await server.stop();
  }
}
