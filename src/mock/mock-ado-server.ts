/**
 * MockAdoServer — a deterministic replay/route server over node:http.
 *
 * Keys routes by the *real* ADO host (forwarded by MockTransport in
 * `x-ado-real-host`) + method + pathname, so all 5 ADO hosts share one port.
 *
 * It also ENFORCES the mandatory `X-TFS-FedAuthRedirect: Suppress` header: a
 * request missing it gets 400. That turns mission §1's "header obligatoire" into
 * a positive, testable assertion rather than a convention.
 *
 * Handlers are dynamic (not just static fixtures) so freshness tests can mutate
 * the returned `System.Rev` between calls, and auth-expiry can be toggled live.
 */
import * as http from "node:http";
import { AddressInfo } from "node:net";

export interface MockReq {
  method: string;
  /** Real ADO host the client *intended* to hit (from x-ado-real-host). */
  host: string;
  pathname: string;
  query: URLSearchParams;
  body: string;
  headers: http.IncomingHttpHeaders;
}

export interface MockResponse {
  status?: number;
  json?: unknown;
  buffer?: Buffer;
  headers?: Record<string, string>;
}

type Handler = (req: MockReq) => MockResponse | Promise<MockResponse>;

interface Route {
  method: string;
  host?: string; // undefined = any host
  match: (pathname: string, req: MockReq) => boolean;
  handler: Handler;
}

export class MockAdoServer {
  private server?: http.Server;
  private routes: Route[] = [];
  private baseUrl = "";

  /** When true, every request returns 401 (simulates a dead session). */
  failAuth = false;

  /** Count of requests that arrived missing the mandatory FedAuthRedirect header. */
  missingFedAuthHeaderCount = 0;

  /** Register a handler. `host` is the real ADO host (e.g. "dev.azure.com"); omit for any. */
  on(method: string, host: string | undefined, match: string | RegExp | ((p: string, r: MockReq) => boolean), handler: Handler): this {
    const matcher =
      typeof match === "string"
        ? (p: string) => p === match
        : match instanceof RegExp
          ? (p: string) => match.test(p)
          : match;
    this.routes.push({ method: method.toUpperCase(), host, match: matcher, handler });
    return this;
  }

  /** Convenience: static JSON fixture for an exact method+host+path. */
  fixture(method: string, host: string, pathname: string, response: MockResponse): this {
    return this.on(method, host, pathname, () => response);
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const addr = this.server!.address() as AddressInfo;
    this.baseUrl = `http://127.0.0.1:${addr.port}`;
    return this.baseUrl;
  }

  url(): string {
    return this.baseUrl;
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");

    const realHost = (req.headers["x-ado-real-host"] as string) || "dev.azure.com";
    const u = new URL(req.url ?? "/", `http://${realHost}`);
    const mreq: MockReq = {
      method: (req.method ?? "GET").toUpperCase(),
      host: realHost,
      pathname: u.pathname,
      query: u.searchParams,
      body,
      headers: req.headers,
    };

    // Enforce the mandatory anti-redirect header.
    const fed = req.headers["x-tfs-fedauthredirect"];
    if (fed !== "Suppress") {
      this.missingFedAuthHeaderCount++;
      return send(res, 400, { message: "missing or wrong X-TFS-FedAuthRedirect header" });
    }

    if (this.failAuth) {
      return send(res, 401, { message: "Azure DevOps session expired (mock failAuth)" }, { "x-vss-mock": "failAuth" });
    }

    const route = this.routes.find((r) => r.method === mreq.method && (r.host === undefined || r.host === realHost) && r.match(mreq.pathname, mreq));
    if (!route) {
      return send(res, 404, { message: `no mock route for ${mreq.method} ${realHost}${mreq.pathname}` });
    }

    let out: MockResponse;
    try {
      out = await route.handler(mreq);
    } catch (e) {
      return send(res, 500, { message: String(e) });
    }

    const status = out.status ?? 200;
    const headers: Record<string, string> = { "x-vss-mock": "1", activityid: "mock-activity-0000", ...(out.headers ?? {}) };
    if (out.buffer) {
      res.writeHead(status, { "content-type": headers["content-type"] ?? "application/octet-stream", "content-length": String(out.buffer.length), ...stripContentHeaders(headers) });
      res.end(out.buffer);
      return;
    }
    return send(res, status, out.json ?? {}, headers);
  }
}

function stripContentHeaders(h: Record<string, string>): Record<string, string> {
  const o = { ...h };
  delete o["content-type"];
  delete o["content-length"];
  return o;
}

function send(res: http.ServerResponse, status: number, json: unknown, headers: Record<string, string> = {}): void {
  const body = Buffer.from(JSON.stringify(json));
  res.writeHead(status, { "content-type": "application/json", "content-length": String(body.length), ...headers });
  res.end(body);
}
