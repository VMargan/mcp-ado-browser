/**
 * BrowserSession — owns a Playwright persistent context on an ISOLATED, dedicated
 * profile (never the user's daily browser). Work runs headless; the window is only
 * made visible during the interactive (re)authentication flow.
 *
 * Data access is done via `page.evaluate(fetch(...))` executed in the page's own
 * origin so the session cookies attach automatically and JSON comes back. The DOM
 * is touched ONLY for the interactive login.
 *
 * Uses playwright-core + channel:'chrome'|'msedge' => relies on an already-installed
 * browser and NEVER downloads a Playwright Chromium (mission §2 / restricted env).
 */
import { chromium, type BrowserContext, type Page } from "playwright-core";
import { AuthRequiredError, HttpError, NotFoundError } from "../errors.js";
import { log } from "../logger.js";
import { HostResolver } from "../ado/hosts.js";
import { VersionRegistry, withApiVersion } from "../ado/versions.js";
import { AdoTransport, BinaryResult, FetchInit, JsonResult, mandatoryHeaders } from "../transport/types.js";
import { DetectedIdentity, detectIdentity, pollUntilAuthenticated } from "./auth-detect.js";

export interface SessionOptions {
  userDataDir: string;
  channel: "chrome" | "msedge";
  org: string;
  /** Version registry for the bootstrap connectionData call (no hardcoded api-version). */
  versions?: VersionRegistry;
}

interface EvalJsonResult {
  data?: unknown;
  error?: string;
  status?: number;
  headers: Record<string, string>;
  bodyText?: string;
}
interface EvalBufResult {
  b64?: string;
  error?: string;
  status?: number;
  headers: Record<string, string>;
}

export class BrowserSession {
  private context?: BrowserContext;
  private page?: Page;
  private launchedHeadless?: boolean;
  readonly hosts: HostResolver;
  readonly transport: BrowserTransport;
  private readonly versions: VersionRegistry;

  constructor(private readonly opts: SessionOptions) {
    this.hosts = new HostResolver(opts.org);
    this.transport = new BrowserTransport(this);
    this.versions = opts.versions ?? new VersionRegistry(null);
  }

  private connectionDataUrl(): string {
    return withApiVersion(`${this.hosts.base("core")}/_apis/connectionData`, this.versions.forArea("core"));
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
    this.page = this.context.pages()[0] ?? (await this.context.newPage());
    this.launchedHeadless = headless;
  }

  currentPage(): Page {
    if (!this.page) throw new Error("BrowserSession not launched");
    return this.page;
  }

  /**
   * Navigate the page to the target `origin` so subsequent fetches are same-origin
   * (cookies attach). We land on the ORG-scoped path `<origin>/<org>` rather than
   * the bare origin: the bare dev.azure.com root bounces unauthenticated users to
   * the marketing site, while the org path stays on the ADO origin.
   */
  async ensureOrigin(origin: string): Promise<void> {
    const page = this.currentPage();
    let cur = "";
    try {
      cur = new URL(page.url()).origin;
    } catch {
      cur = "";
    }
    if (cur === origin) return;
    // Land on a STABLE same-origin response, not the SPA app shell: the dev.azure.com
    // app continuously client-side-navigates, which destroys page.evaluate execution
    // contexts. The connectionData JSON endpoint is a static page on the core origin;
    // other ADO hosts (feeds/pkgs/...) don't serve the SPA, so the org path is stable.
    const coreOrigin = new URL(this.hosts.base("core")).origin;
    const landing = origin === coreOrigin ? this.connectionDataUrl() : `${origin}/${encodeURIComponent(this.opts.org)}`;
    try {
      await page.goto(landing, { waitUntil: "domcontentloaded", timeout: 30_000 });
    } catch (e) {
      // A 404/error page at the landing is fine — we only need the origin context for cookies.
      log.debug(`ensureOrigin soft-nav note for ${landing}: ${String(e)}`);
    }
  }

  /**
   * Interactive login. Opens a VISIBLE window, lets the human complete MFA, and
   * detects success by polling an authenticated endpoint (connectionData) until it
   * returns a real (non-anonymous) identity. Session is persisted in userDataDir.
   */
  async authenticate(timeoutMs = 300_000): Promise<DetectedIdentity> {
    await this.ensureLaunched(false);
    const page = this.currentPage();
    // Navigate to the ORG-scoped URL (not the bare origin): the bare dev.azure.com
    // root redirects unauthenticated users to the marketing page, while the
    // org-scoped URL triggers the AAD sign-in flow.
    const orgUrl = this.hosts.base("core");
    try {
      await page.goto(orgUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    } catch (e) {
      log.debug(`authenticate initial nav note: ${String(e)}`);
    }
    log.info("Waiting for interactive sign-in (MFA). Complete the login in the open window.");
    // Poll via context.request so we read connectionData using the SHARED session
    // cookie jar without CORS and WITHOUT navigating the user's login tab away.
    const id = await pollUntilAuthenticated(() => this.requestConnectionData(), { timeoutMs });
    log.info(`Signed in as ${id.displayName}`);
    return id;
  }

  /** Read connectionData via the context's cookie jar (used by auth polling + validate). */
  private async requestConnectionData(): Promise<any> {
    if (!this.context) throw new Error("BrowserSession not launched");
    const res = await this.context.request.get(this.connectionDataUrl(), { headers: mandatoryHeaders() });
    if (res.status() === 401) throw new AuthRequiredError(this.connectionDataUrl());
    if (!res.ok()) throw new HttpError(res.status(), this.connectionDataUrl());
    return res.json();
  }

  /**
   * Cross-host data fetch via the context cookie jar. Used for hosts other than the
   * core dev.azure.com origin (feeds/pkgs/search/analytics): navigating a real page
   * to those hosts is unreliable (bare org paths 4xx, download URLs trigger file
   * downloads), but context.request carries the SAME authenticated session cookies
   * without CORS or page navigation. Still strictly the browser session — no PAT.
   */
  async contextFetchJson<T>(url: string, init?: FetchInit): Promise<JsonResult<T>> {
    const res = await this.context!.request.fetch(url, { method: init?.method ?? "GET", headers: mandatoryHeaders(init?.headers), data: init?.body });
    const headers = res.headers();
    if (res.status() === 401 || res.status() === 403) throw new AuthRequiredError(url);
    if (res.status() === 404) throw new NotFoundError("resource", url, url);
    if (!res.ok()) throw new HttpError(res.status(), url, (await res.text()).slice(0, 500));
    return { data: (await res.json()) as T, headers };
  }

  async contextFetchBuffer(url: string, init?: FetchInit): Promise<BinaryResult> {
    const res = await this.context!.request.fetch(url, { method: init?.method ?? "GET", headers: mandatoryHeaders({ Accept: "application/octet-stream", ...(init?.headers ?? {}) }), data: init?.body });
    const headers = res.headers();
    if (res.status() === 401 || res.status() === 403) throw new AuthRequiredError(url);
    if (res.status() === 404) throw new NotFoundError("resource", url, url);
    if (!res.ok()) throw new HttpError(res.status(), url, (await res.text()).slice(0, 500));
    const data = await res.body();
    const cl = headers["content-length"];
    return { data, contentLength: cl != null ? Number(cl) : null, contentType: headers["content-type"] ?? null, headers };
  }

  /** Lightweight check: is the persisted session currently valid? */
  async validate(): Promise<boolean> {
    try {
      await this.ensureLaunched(true);
      const data = await this.requestConnectionData();
      return !!detectIdentity(data);
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    try {
      await this.context?.close();
    } catch {
      /* ignore */
    }
    this.context = undefined;
    this.page = undefined;
    this.launchedHeadless = undefined;
  }
}

/** AdoTransport over a live BrowserSession via same-origin page.evaluate(fetch). */
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

  /** Run an in-page evaluate, retrying once if a SPA navigation destroys the context. */
  private async evalWithRetry<R>(targetUrl: string, fn: (a: any) => any, arg: any): Promise<R> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return (await this.session.currentPage().evaluate(fn, arg)) as R;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (attempt === 0 && /Execution context was destroyed|context was destroyed|frame was detached|navigating and changing|Target closed/i.test(msg)) {
          await new Promise((r) => setTimeout(r, 500));
          await this.session.ensureOrigin(new URL(targetUrl).origin);
          continue;
        }
        throw e;
      }
    }
    throw new Error("unreachable");
  }

  /** True when the URL targets the core dev.azure.com origin (page.evaluate path). */
  private isCoreOrigin(url: string): boolean {
    return new URL(url).origin === new URL(this.session.hosts.base("core")).origin;
  }

  async fetchJson<T>(url: string, init?: FetchInit): Promise<JsonResult<T>> {
    this.calledUrls.push(url);
    this.fetchCount++;
    if (!this.isCoreOrigin(url)) {
      const res = await this.session.contextFetchJson<T>(url, init);
      this.lastHeaders = res.headers;
      return res;
    }
    await this.session.ensureOrigin(new URL(url).origin);
    const headers = mandatoryHeaders(init?.headers);
    const r = await this.evalWithRetry<EvalJsonResult>(
      url,
      async ({ url, method, headers, body }) => {
        const res = await fetch(url, { method: method ?? "GET", headers, body, credentials: "include" });
        const h: Record<string, string> = {};
        res.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
        if (res.status === 401) return { error: "ADO_AUTH_EXPIRED", status: 401, headers: h };
        if (!res.ok) {
          const t = await res.text().catch(() => "");
          return { error: "ADO_HTTP_" + res.status, status: res.status, headers: h, bodyText: t.slice(0, 500) };
        }
        const data = await res.json();
        return { data, headers: h };
      },
      { url, method: init?.method, headers, body: init?.body },
    );
    this.throwIfError(r, url);
    this.lastHeaders = r.headers;
    return { data: r.data as T, headers: r.headers };
  }

  async fetchBuffer(url: string, init?: FetchInit): Promise<BinaryResult> {
    this.calledUrls.push(url);
    this.fetchCount++;
    if (!this.isCoreOrigin(url)) {
      const res = await this.session.contextFetchBuffer(url, init);
      this.lastHeaders = res.headers;
      return res;
    }
    await this.session.ensureOrigin(new URL(url).origin);
    const headers = mandatoryHeaders({ Accept: "application/octet-stream", ...(init?.headers ?? {}) });
    const r = await this.evalWithRetry<EvalBufResult>(
      url,
      async ({ url, method, headers, body }) => {
        const res = await fetch(url, { method: method ?? "GET", headers, body, credentials: "include" });
        const h: Record<string, string> = {};
        res.headers.forEach((v, k) => (h[k.toLowerCase()] = v));
        if (res.status === 401) return { error: "ADO_AUTH_EXPIRED", status: 401, headers: h };
        if (!res.ok) return { error: "ADO_HTTP_" + res.status, status: res.status, headers: h };
        const buf = new Uint8Array(await res.arrayBuffer());
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < buf.length; i += chunk) binary += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + chunk)));
        return { b64: btoa(binary), headers: h };
      },
      { url, method: init?.method, headers, body: init?.body },
    );
    if (r.error) this.throwIfError(r as EvalJsonResult, url);
    const data = Buffer.from(r.b64 ?? "", "base64");
    const cl = r.headers["content-length"];
    this.lastHeaders = r.headers;
    return { data, contentLength: cl != null ? Number(cl) : null, contentType: r.headers["content-type"] ?? null, headers: r.headers };
  }

  private throwIfError(r: EvalJsonResult, url: string): void {
    if (!r.error) return;
    if (r.error === "ADO_AUTH_EXPIRED" || r.status === 401 || r.status === 403) throw new AuthRequiredError(url);
    if (r.status === 404) throw new NotFoundError("resource", url, url);
    throw new HttpError(r.status ?? 0, url, r.bodyText);
  }
}
