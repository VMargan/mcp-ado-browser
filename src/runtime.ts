/**
 * Runtime wiring: builds the live AdoClient (browser session + cache + versions)
 * and runs the interactive authenticate flow. Shared by the MCP server and the CLI.
 */
import { loadConfig, requireConnection, ResolvedConfig } from "./config.js";
import { BrowserSession } from "./browser/session.js";
import { SqliteCache } from "./cache/sqlite-cache.js";
import { AdoClient } from "./ado/client.js";
import { VersionRegistry } from "./ado/versions.js";
import { CachePort } from "./cache/types.js";
import { log } from "./logger.js";

export interface LiveRuntime {
  client: AdoClient;
  session: BrowserSession;
  cache: CachePort;
  versions: VersionRegistry;
  cfg: ResolvedConfig & { org: string };
}

export async function buildLiveRuntime(cfg: ResolvedConfig = loadConfig(), opts?: { headless?: boolean }): Promise<LiveRuntime> {
  requireConnection(cfg);
  const versions = new VersionRegistry(cfg.apiVersionOverride);
  const session = new BrowserSession({ userDataDir: cfg.userDataDir, channel: cfg.browserChannel, org: cfg.org, versions });
  await session.ensureLaunched(opts?.headless ?? cfg.headless);
  const cache = new SqliteCache({ dbPath: cfg.cacheDbPath, defaultTtlSeconds: cfg.cacheTtlSeconds, ttlOverrides: cfg.cacheTtlOverrides });
  const client = new AdoClient({ transport: session.transport, hosts: session.hosts, versions, project: cfg.project, cache });
  return { client, session, cache, versions, cfg };
}

/** Interactive (re)authentication: opens a VISIBLE browser, waits for sign-in, persists session. */
export async function runAuthenticate(cfg: ResolvedConfig = loadConfig()): Promise<number> {
  requireConnection(cfg);
  const session = new BrowserSession({ userDataDir: cfg.userDataDir, channel: cfg.browserChannel, org: cfg.org, versions: new VersionRegistry(cfg.apiVersionOverride) });
  const timeoutMs = (Number(process.env.ADO_AUTH_TIMEOUT_SECONDS) || 600) * 1000;
  try {
    const id = await session.authenticate(timeoutMs);
    log.info(`Authentication OK — session persisted at ${cfg.userDataDir}. Identity: ${id.displayName}`);
    // Prove the persisted session is reusable headless.
    await session.close();
    const ok = await session.validate();
    log.info(ok ? "Headless re-validation OK (session reused without re-login)." : "WARNING: headless re-validation failed.");
    return ok ? 0 : 1;
  } catch (e) {
    log.error(`Authentication failed: ${String(e)}`);
    return 1;
  } finally {
    await session.close();
  }
}
