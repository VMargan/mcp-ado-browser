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
import { AuthResult } from "./ado/schemas.js";
import { AuthRequiredError } from "./errors.js";
import { log } from "./logger.js";

/**
 * Owns a SINGLE browser profile across the server's lifetime and arbitrates between
 * the HEADLESS work session (data tools) and the HEADFUL interactive sign-in — so the
 * profile lock is never held by two Chrome instances at once. This is what lets the
 * `authenticate` MCP tool open the login window from inside the running server.
 */
export class AdoRuntime {
  private readonly cfg: ResolvedConfig;
  private readonly versions: VersionRegistry;
  private cache: SqliteCache | null = null;
  private session: BrowserSession | null = null;
  private client: AdoClient | null = null;

  // NOTE: org is validated lazily (getClient/authenticate), NOT in the constructor —
  // so `initialize`/`tools/list` work over stdio even before any org is configured.
  constructor(cfg: ResolvedConfig = loadConfig()) {
    this.cfg = cfg;
    this.versions = new VersionRegistry(cfg.apiVersionOverride);
  }

  private newSession(): BrowserSession {
    requireConnection(this.cfg); // throws CONFIG_ERROR if ADO_ORG is missing
    return new BrowserSession({ userDataDir: this.cfg.userDataDir, channel: this.cfg.browserChannel, org: this.cfg.org!, versions: this.versions });
  }

  private getCache(): SqliteCache {
    if (!this.cache) this.cache = new SqliteCache({ dbPath: this.cfg.cacheDbPath, defaultTtlSeconds: this.cfg.cacheTtlSeconds, ttlOverrides: this.cfg.cacheTtlOverrides });
    return this.cache;
  }

  /** Lazily (re)build the HEADLESS work client, reusing the persisted session cookies. */
  async getClient(): Promise<AdoClient> {
    if (this.client && this.session) return this.client;
    this.session = this.newSession();
    await this.session.ensureLaunched(true);
    this.client = new AdoClient({ transport: this.session.transport, hosts: this.session.hosts, versions: this.versions, project: this.cfg.project, cache: this.getCache() });
    return this.client;
  }

  private async disposeSession(): Promise<void> {
    if (this.session) await this.session.close();
    this.session = null;
    this.client = null;
  }

  /**
   * Interactive sign-in usable as an MCP tool. If the session is already valid it
   * returns immediately (no window). Otherwise it releases the headless session,
   * opens a VISIBLE window, polls until sign-in (bounded), persists, and closes the
   * window so the next data call relaunches headless and reuses the cookies.
   */
  async authenticate(timeoutMs: number): Promise<AuthResult> {
    try {
      await this.getClient();
      if (await this.session!.validate()) {
        return { authenticated: true, identity: null, message: "Already signed in — the persisted session is still valid." };
      }
    } catch {
      /* fall through to interactive sign-in */
    }
    await this.disposeSession(); // free the profile lock for the headful window
    const auth = this.newSession();
    try {
      const id = await auth.authenticate(timeoutMs);
      return { authenticated: true, identity: id.displayName, message: `Signed in as ${id.displayName}. Session persisted; tools are ready.` };
    } catch (e) {
      if (e instanceof AuthRequiredError) {
        return { authenticated: false, identity: null, message: "Timed out waiting for sign-in. A browser window was opened — complete the login, then call `authenticate` again." };
      }
      throw e;
    } finally {
      await auth.close();
    }
  }

  async close(): Promise<void> {
    await this.disposeSession();
    this.cache?.close();
    this.cache = null;
  }
}

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

/** Clear the persisted session (and cached data) — a local "sign out". No org needed. */
export async function runLogout(cfg: ResolvedConfig = loadConfig()): Promise<number> {
  const fs = await import("node:fs");
  let cleared = 0;
  for (const target of [cfg.userDataDir, cfg.cacheDbPath]) {
    if (fs.existsSync(target)) {
      fs.rmSync(target, { recursive: true, force: true });
      cleared++;
    }
  }
  log.info(cleared > 0 ? `Logged out — browser session and cache cleared (${cfg.userDataDir}).` : "Nothing to clear — no persisted session found.");
  return 0;
}

/** Report the configured org/profile and whether the persisted session is signed in. */
export async function runStatus(cfg: ResolvedConfig = loadConfig()): Promise<number> {
  log.info(`Profile dir : ${cfg.userDataDir}`);
  log.info(`Cache DB    : ${cfg.cacheDbPath}`);
  if (!cfg.org) {
    log.info("Org         : (not set — pass --org or set ADO_ORG)");
    log.info("Signed in   : unknown (no org to check against)");
    return 0;
  }
  log.info(`Org         : ${cfg.org}${cfg.project ? `   Project: ${cfg.project}` : ""}`);
  const session = new BrowserSession({ userDataDir: cfg.userDataDir, channel: cfg.browserChannel, org: cfg.org, versions: new VersionRegistry(cfg.apiVersionOverride) });
  try {
    const id = await session.whoami();
    log.info(id ? `Signed in   : yes — ${id.displayName}` : "Signed in   : no — run `authenticate` to sign in");
    return id ? 0 : 1;
  } finally {
    await session.close();
  }
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
