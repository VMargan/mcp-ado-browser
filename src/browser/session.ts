/**
 * BrowserSession — owns a Playwright persistent context on an ISOLATED, dedicated
 * profile (never the user's daily browser). Work runs headless; the window is only
 * made visible during the interactive (re)authentication flow.
 *
 * HOW REQUESTS ARE AUTHENTICATED
 * ------------------------------
 * OBSERVED BEHAVIOUR, not a documented Microsoft product change: on the tenants
 * this was measured against, the org's sign-in URL carries `protocol=cookieless`,
 * the web app authenticates its own `/_apis/` calls with `Authorization: Bearer`
 * (MSAL), and a 401 answers with `WWW-Authenticate: Bearer ..., TFS-Federated`.
 * No Microsoft announcement stating that Azure DevOps moved its web UI off cookie
 * authentication could be found, so treat this as behaviour to detect at runtime
 * rather than a rule to rely on. What it means in practice:
 *
 *   - The cookie jar authenticates NOTHING any more. `context.request` gets a hard
 *     401 (`TF400813 ... 'aaaaaaaa-...' is not authorized`) on every host — core,
 *     feeds and almsearch alike — with the full jar attached, and adding
 *     Origin/Referer/Sec-Fetch headers does not change it.
 *   - A same-origin `page.evaluate(fetch)` on dev.azure.com DOES return 200, but
 *     cross-origin calls to feeds/pkgs/almsearch from that page are blocked
 *     ("TypeError: Failed to fetch"), and those origins cannot be navigated to
 *     directly (they bounce back into the federated sign-in).
 *
 * So the session's usable credential is the ACCESS TOKEN the web app already holds.
 * We load the app shell once and observe the `Authorization: Bearer` header on its
 * own API traffic, then replay that token through `context.request` for every host.
 * This is still strictly the user's browser session — no PAT is ever created.
 *
 * The token is kept IN MEMORY only. It is deliberately never written to disk: an
 * access token readable from JS/browser storage is more exposed than an httpOnly
 * cookie (Microsoft's own MSAL guidance says session/local storage is only safe
 * absent XSS, and that its cache encryption reduces persistence rather than adding
 * security), so we do not widen that exposure by persisting it ourselves.
 *
 * SESSION PERSISTENCE: the cookie that lets the app shell load is a SESSION cookie,
 * which Chrome drops on exit, and under Conditional Access the federated re-login
 * does not replay from a cold profile. We therefore snapshot `storageState()` after
 * a successful sign-in and re-inject it on the next launch — with that in place the
 * whole chain (vssps -> AAD -> DeviceAuthTls -> _signedin) replays silently.
 *
 * Uses playwright-core + channel:'chrome'|'msedge' => relies on an already-installed
 * browser and NEVER downloads a Playwright Chromium (mission §2 / restricted env).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { AdoError, AuthRequiredError, ForbiddenError, HttpError, NotFoundError, ProfileLockedError } from "../errors.js";
import { log } from "../logger.js";
import { HostResolver } from "../ado/hosts.js";
import { VersionRegistry, withApiVersion } from "../ado/versions.js";
import { AdoTransport, BinaryResult, FetchInit, JsonResult, mandatoryHeaders } from "../transport/types.js";
import { DetectedIdentity, detectIdentityVerbose, formatDiagnostic, pollUntilAuthenticated } from "./auth-detect.js";

export interface SessionOptions {
  userDataDir: string;
  channel: "chrome" | "msedge";
  org: string;
  /** Version registry for the bootstrap connectionData call (no hardcoded api-version). */
  versions?: VersionRegistry;
  /** Where to snapshot storageState so session cookies survive a browser restart. */
  sessionStatePath?: string;
}

/** How long to wait for the app shell to emit an authenticated API call. */
const BEARER_WAIT_MS = 45_000;

export class BrowserSession {
  private context?: BrowserContext;
  private page?: Page;
  private launchedHeadless?: boolean;
  /** Access token observed on the web app's own API traffic. */
  private bearer?: string;
  private bearerPending?: Promise<string | undefined>;
  readonly hosts: HostResolver;
  readonly transport: BrowserTransport;
  private readonly versions: VersionRegistry;
  private readonly sessionStatePath: string;

  constructor(private readonly opts: SessionOptions) {
    this.hosts = new HostResolver(opts.org);
    this.transport = new BrowserTransport(this);
    this.versions = opts.versions ?? new VersionRegistry(null);
    this.sessionStatePath = opts.sessionStatePath ?? path.join(path.dirname(opts.userDataDir), "session-state.json");
  }

  private connectionDataUrl(): string {
    return withApiVersion(`${this.hosts.base("core")}/_apis/connectionData`, this.versions.forArea("core"));
  }

  /** The app-shell URL whose own API calls carry the access token. */
  private appShellUrl(): string {
    return `${this.hosts.base("core")}/_home`;
  }

  async ensureLaunched(headless: boolean): Promise<void> {
    if (this.context && this.launchedHeadless === headless) return;
    if (this.context) await this.close();
    log.info(`Launching ${this.opts.channel} (headless=${headless}) on isolated profile ${this.opts.userDataDir}`);
    const args = ["--no-first-run", "--no-default-browser-check"];
    // Visible (auth) window: open in Chrome "app" mode — a clean, chromeless window
    // (no address bar, toolbar, tabs or bookmarks), pointed straight at the org URL.
    // Opt out with ADO_APP_WINDOW=0.
    if (!headless && process.env.ADO_APP_WINDOW !== "0") {
      args.push(`--app=${this.hosts.base("core")}`, "--window-size=1100,820");
    }
    try {
      this.context = await chromium.launchPersistentContext(this.opts.userDataDir, {
        headless,
        channel: this.opts.channel,
        viewport: null,
        // Enable Chromium's sandbox for the VISIBLE auth window so it doesn't show the
        // "--no-sandbox / security will suffer" banner (playwright-core defaults the
        // sandbox OFF). Headless work runs keep the default (no banner is shown there
        // anyway, and it avoids any sandbox-init issues in restricted environments).
        // Force-disable everywhere with ADO_NO_SANDBOX=1.
        chromiumSandbox: !headless && process.env.ADO_NO_SANDBOX !== "1",
        args,
      });
    } catch (e) {
      const msg = String(e);
      // Playwright surfaces a held ProcessSingleton as a raw filesystem error; an
      // opaque "SingletonLock: File exists" stack is useless to the caller.
      if (/SingletonLock|ProcessSingleton|profile.*in use/i.test(msg)) throw new ProfileLockedError(this.opts.userDataDir, msg);
      throw e;
    }
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.bearer = undefined;
    this.bearerPending = undefined;
    this.launchedHeadless = headless;
    await this.restoreSessionState();
  }

  currentPage(): Page {
    if (!this.page) throw new Error("BrowserSession not launched");
    return this.page;
  }

  // ───────────────────────── session persistence ─────────────────────────

  /**
   * Re-inject a previously captured storageState. Chrome persists only NON-session
   * cookies; the app-shell cookie is session-scoped, so without this the next
   * headless launch bounces straight back to the federated sign-in page.
   */
  private async restoreSessionState(): Promise<void> {
    if (!this.context || !fs.existsSync(this.sessionStatePath)) return;
    try {
      const state = JSON.parse(fs.readFileSync(this.sessionStatePath, "utf8"));
      if (Array.isArray(state?.cookies) && state.cookies.length) {
        await this.context.addCookies(state.cookies);
        log.debug(`Restored ${state.cookies.length} cookie(s) from ${this.sessionStatePath}`);
      }
    } catch (e) {
      log.warn(`Could not restore session state (${this.sessionStatePath}): ${String(e).slice(0, 200)}`);
    }
  }

  /** Snapshot cookies (including SESSION cookies) so the next launch stays signed in. */
  async saveSessionState(): Promise<void> {
    if (!this.context) return;
    try {
      const state = await this.context.storageState();
      fs.mkdirSync(path.dirname(this.sessionStatePath), { recursive: true });
      // 0600: this file carries a live session credential — same sensitivity as the profile.
      fs.writeFileSync(this.sessionStatePath, JSON.stringify(state), { mode: 0o600 });
      fs.chmodSync(this.sessionStatePath, 0o600);
      log.debug(`Session state saved to ${this.sessionStatePath} (${state.cookies.length} cookies)`);
    } catch (e) {
      log.warn(`Could not save session state: ${String(e).slice(0, 200)}`);
    }
  }

  // ───────────────────────── access-token acquisition ─────────────────────────

  /**
   * Load the app shell and observe the `Authorization: Bearer` header on its own
   * API traffic. That token — the one the signed-in web app already uses — is what
   * authenticates every subsequent request.
   *
   * Returns undefined when the app shell cannot reach a signed-in state (expired
   * session): callers turn that into AUTH_REQUIRED.
   */
  async ensureBearer(force = false): Promise<string | undefined> {
    if (this.bearer && !force) return this.bearer;
    if (this.bearerPending) return this.bearerPending;
    this.bearerPending = this.acquireBearer().finally(() => (this.bearerPending = undefined));
    return this.bearerPending;
  }

  private async acquireBearer(): Promise<string | undefined> {
    if (!this.context) throw new Error("BrowserSession not launched");
    const page = this.page && !this.page.isClosed() ? this.page : await this.context.newPage();
    this.page = page;

    let found: string | undefined;
    let resolveFound: (() => void) | undefined;
    const gotOne = new Promise<void>((r) => (resolveFound = r));
    const onRequest = (req: import("playwright-core").Request) => {
      if (found) return;
      // allHeaders() is async; the request may already be in flight — best effort.
      req
        .allHeaders()
        .then((h) => {
          const a = h["authorization"];
          if (!found && typeof a === "string" && a.startsWith("Bearer ")) {
            found = a;
            resolveFound?.();
          }
        })
        .catch(() => {
          /* request gone */
        });
    };
    page.on("request", onRequest);

    try {
      const shell = this.appShellUrl();
      try {
        // Always force a FULL load of the shell: a plain reload on an already-booted
        // SPA can serve everything from cache and never re-issue an authenticated
        // API call, which would leave us with no token to observe.
        if (safeOrigin(page.url()) === new URL(shell).origin) {
          await page.goto("about:blank", { timeout: 15_000 }).catch(() => undefined);
        }
        await page.goto(shell, { waitUntil: "domcontentloaded", timeout: 60_000 });
      } catch (e) {
        log.debug(`app-shell nav note: ${String(e).slice(0, 160)}`);
      }
      // The federated chain (vssps -> AAD -> _signedin -> app) settles on its own
      // once the session cookies are in place; the token appears with the first
      // authenticated API call the app makes.
      await Promise.race([gotOne, sleep(BEARER_WAIT_MS)]);
      if (!found) {
        // Give a late-booting shell one more chance to emit an API call.
        await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
        await Promise.race([gotOne, sleep(5_000)]);
      }
      if (found) {
        this.bearer = found;
        log.debug(`Acquired session access token from the app shell (${found.length} chars)`);
      } else {
        log.warn(`No access token observed from the app shell at ${page.url().slice(0, 120)} — session is probably expired`);
      }
      return found;
    } finally {
      page.off("request", onRequest);
    }
  }

  /** Mandatory headers plus the session access token, when we have one. */
  private async authHeaders(extra?: Record<string, string>): Promise<Record<string, string>> {
    const bearer = await this.ensureBearer();
    return mandatoryHeaders({ ...(bearer ? { Authorization: bearer } : {}), ...(extra ?? {}) });
  }

  // ───────────────────────── interactive sign-in ─────────────────────────

  /**
   * Interactive login. Opens a VISIBLE window, lets the human complete MFA, and
   * detects success by polling an authenticated endpoint (connectionData) until it
   * returns a real (non-anonymous) identity. Session is persisted in userDataDir
   * AND snapshotted to sessionStatePath (session cookies do not survive otherwise).
   */
  async authenticate(timeoutMs = 300_000): Promise<DetectedIdentity> {
    await this.ensureLaunched(false);
    const page = this.currentPage();
    // Navigate to the ORG-scoped URL (not the bare origin): the bare dev.azure.com
    // root redirects unauthenticated users to the marketing page, while the
    // org-scoped URL triggers the AAD sign-in flow.
    try {
      await page.goto(this.hosts.base("core"), { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (e) {
      log.debug(`authenticate initial nav note: ${String(e)}`);
    }
    log.info("Waiting for interactive sign-in (MFA). Complete the login in the open window.");
    const id = await pollUntilAuthenticated(() => this.probeConnectionData(), { timeoutMs, intervalMs: 3000 });
    log.info(`Signed in as ${id.displayName}`);
    // Snapshot BEFORE the window closes: the app-shell cookie is session-scoped.
    await this.saveSessionState();
    return id;
  }

  /**
   * One connectionData probe. During interactive sign-in the app shell is being
   * driven by the human, so we read it in-page (same-origin, no token needed);
   * that also avoids fighting the user's tab for navigation.
   */
  private async probeConnectionData(): Promise<any> {
    if (!this.context) throw new Error("BrowserSession not launched");
    const url = this.connectionDataUrl();
    const page = this.currentPage();
    if (safeOrigin(page.url()) === new URL(url).origin) {
      const r = await pageFetch(page, url, { headers: mandatoryHeaders() });
      if (r.fetchError) throw new AdoError("INTERNAL", `in-page fetch failed: ${r.fetchError}`, { url, fetchError: r.fetchError });
      if (r.status < 200 || r.status >= 300) this.assertOk(r.status, url, r.text ?? "", r.headers["content-type"]);
      return parseJsonOrThrow(r.text ?? "", url, r.headers["content-type"]);
    }
    // Not on the ADO origin yet (still in the federated chain) — report precisely
    // instead of letting a cross-origin fetch fail as an opaque "Failed to fetch".
    throw new AuthRequiredError(url, { reason: "browser is still in the sign-in flow", landedOn: page.url().slice(0, 160) });
  }

  // ───────────────────────── data fetches ─────────────────────────

  /**
   * JSON fetch for any ADO host, authenticated with the session access token.
   * On 401/403 the token is re-acquired once (it is short-lived) before failing.
   */
  async fetchJson<T>(url: string, init?: FetchInit): Promise<JsonResult<T>> {
    return this.withRetry(url, async () => {
      const res = await this.context!.request.fetch(url, {
        method: init?.method ?? "GET",
        headers: await this.authHeaders(init?.headers),
        data: init?.body,
      });
      const headers = res.headers();
      const body = await res.text();
      this.assertOk(res.status(), url, body, headers["content-type"]);
      return { data: parseJsonOrThrow(body, url, headers["content-type"]) as T, headers };
    });
  }

  async fetchBuffer(url: string, init?: FetchInit): Promise<BinaryResult> {
    return this.withRetry(url, async () => {
      const res = await this.context!.request.fetch(url, {
        method: init?.method ?? "GET",
        headers: await this.authHeaders({ Accept: "application/octet-stream", ...(init?.headers ?? {}) }),
        data: init?.body,
      });
      const headers = res.headers();
      if (!res.ok()) this.assertOk(res.status(), url, await res.text(), headers["content-type"]);
      const data = await res.body();
      const cl = headers["content-length"];
      return { data, contentLength: cl != null ? Number(cl) : null, contentType: headers["content-type"] ?? null, headers };
    });
  }

  /**
   * Map an HTTP status onto the error taxonomy.
   *
   * 401 and 403 are NOT the same thing and must not be conflated: 401 means the
   * session is not authenticated (re-run `authenticate`), while 403 means the
   * session IS authenticated but lacks permission on that specific resource — e.g.
   * a feed the user cannot read. Reporting the latter as AUTH_REQUIRED sends the
   * agent into a pointless re-login loop and hides a genuine permission problem.
   */
  private assertOk(status: number, url: string, body: string, contentType?: string): void {
    if (status === 401) throw new AuthRequiredError(url, { status, contentType, body: body.slice(0, 300) });
    if (status === 403) throw new ForbiddenError(url, body.slice(0, 300));
    if (status === 404) throw new NotFoundError("resource", url, url);
    if (status < 200 || status >= 300) throw new HttpError(status, url, body.slice(0, 500));
  }

  /** Run `fn`; on AUTH_REQUIRED refresh the short-lived token once and retry. */
  private async withRetry<R>(url: string, fn: () => Promise<R>): Promise<R> {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof AuthRequiredError)) throw e;
      log.debug(`401 on ${url} — refreshing the session access token and retrying once`);
      const refreshed = await this.ensureBearer(true);
      if (!refreshed) throw e;
      return fn();
    }
  }

  // ───────────────────────────── identity ─────────────────────────────

  /** Who is the persisted session signed in as? Returns null if not authenticated. */
  async whoami(): Promise<DetectedIdentity | null> {
    try {
      await this.ensureLaunched(true);
      const { data } = await this.fetchJson<any>(this.connectionDataUrl());
      const { identity, diagnostic } = detectIdentityVerbose(data);
      if (!identity) log.debug(`whoami: not signed in — ${formatDiagnostic(diagnostic)}`);
      return identity;
    } catch (e) {
      log.debug(`whoami failed: ${String(e).slice(0, 200)}`);
      return null;
    }
  }

  /** Lightweight check: is the persisted session currently valid? */
  async validate(): Promise<boolean> {
    return (await this.whoami()) !== null;
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    this.context = undefined;
    this.page = undefined;
    this.bearer = undefined;
    this.bearerPending = undefined;
    this.launchedHeadless = undefined;
  }
}

interface PageFetchResult {
  status: number;
  headers: Record<string, string>;
  text?: string;
  fetchError?: string;
}

/** Run a fetch inside the page (same-origin only — used during interactive sign-in). */
async function pageFetch(page: Page, url: string, init: { headers: Record<string, string> }): Promise<PageFetchResult> {
  return (await page.evaluate(
    async ({ url, headers }: { url: string; headers: Record<string, string> }) => {
      try {
        const res = await fetch(url, { headers, credentials: "include" });
        const h: Record<string, string> = {};
        res.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
        return { status: res.status, headers: h, text: await res.text() };
      } catch (e) {
        return { status: 0, headers: {}, fetchError: String(e) };
      }
    },
    { url, headers: init.headers },
  )) as PageFetchResult;
}

/** Parse a body as JSON, turning an HTML sign-in page into a precise AUTH_REQUIRED. */
function parseJsonOrThrow(body: string, url: string, contentType?: string): any {
  try {
    return JSON.parse(body);
  } catch {
    if (/^\s*<(?:!doctype|html)/i.test(body)) {
      throw new AuthRequiredError(url, {
        reason: "server returned an HTML page (sign-in / redirect) instead of JSON",
        contentType,
        body: body.slice(0, 200).replace(/\s+/g, " "),
      });
    }
    throw new AdoError("INTERNAL", `Non-JSON response from ${url}`, { url, contentType, body: body.slice(0, 300) });
  }
}

function safeOrigin(url: string): string {
  try {
    const o = new URL(url).origin;
    return o === "null" ? "" : o;
  } catch {
    return "";
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * AdoTransport over a live BrowserSession. Every request is issued through the
 * browser context carrying the session's own access token, so it works uniformly
 * across dev.azure.com, feeds/pkgs and almsearch — no per-origin page navigation,
 * no CORS, and clean HTTP status codes (401 -> AUTH_REQUIRED, 404 -> NOT_FOUND).
 */
export class BrowserTransport implements AdoTransport {
  readonly kind = "browser" as const;
  readonly calledUrls: string[] = [];
  fetchCount = 0;
  lastHeaders: Record<string, string> = {};

  constructor(private readonly session: BrowserSession) {}

  resetCounters(): void {
    this.calledUrls.length = 0;
    this.fetchCount = 0;
  }

  async fetchJson<T>(url: string, init?: FetchInit): Promise<JsonResult<T>> {
    this.calledUrls.push(url);
    this.fetchCount++;
    const res = await this.session.fetchJson<T>(url, init);
    this.lastHeaders = res.headers;
    return res;
  }

  async fetchBuffer(url: string, init?: FetchInit): Promise<BinaryResult> {
    this.calledUrls.push(url);
    this.fetchCount++;
    const res = await this.session.fetchBuffer(url, init);
    this.lastHeaders = res.headers;
    return res;
  }
}
