/**
 * MockTransport: executes canonical ADO URLs against a local MockAdoServer.
 *
 * It records the *canonical* (real-host) URL in calledUrls — so cache and live
 * gates assert on what the client intended to fetch — while physically routing
 * the request to the mock base. The real host is forwarded in `x-ado-real-host`
 * so the mock can key fixtures across the 5 ADO hosts on a single port.
 */
import { AuthRequiredError, HttpError, NotFoundError } from "../errors.js";
import { AdoTransport, BinaryResult, FetchInit, JsonResult, mandatoryHeaders } from "./types.js";

export class MockTransport implements AdoTransport {
  readonly kind = "mock" as const;
  readonly calledUrls: string[] = [];
  fetchCount = 0;
  lastHeaders: Record<string, string> = {};

  constructor(private readonly mockBase: string) {}

  resetCounters(): void {
    this.calledUrls.length = 0;
    this.fetchCount = 0;
  }

  private rewrite(url: string): { exec: string; realHost: string } {
    const u = new URL(url);
    const realHost = u.host;
    const exec = `${this.mockBase}${u.pathname}${u.search}`;
    return { exec, realHost };
  }

  private async raw(url: string, init: FetchInit | undefined): Promise<Response> {
    this.calledUrls.push(url);
    this.fetchCount++;
    const { exec, realHost } = this.rewrite(url);
    const res = await fetch(exec, {
      method: init?.method ?? "GET",
      headers: mandatoryHeaders({ ...(init?.headers ?? {}), "x-ado-real-host": realHost }),
      body: init?.body,
    });
    if (res.status === 401) throw new AuthRequiredError(url);
    if (res.status === 404) throw new NotFoundError("resource", url, url);
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new HttpError(res.status, url, body);
    }
    return res;
  }

  async fetchJson<T>(url: string, init?: FetchInit): Promise<JsonResult<T>> {
    const res = await this.raw(url, init);
    const data = (await res.json()) as T;
    this.lastHeaders = headerObj(res.headers);
    return { data, headers: this.lastHeaders };
  }

  async fetchBuffer(url: string, init?: FetchInit): Promise<BinaryResult> {
    const res = await this.raw(url, init);
    const ab = await res.arrayBuffer();
    const data = Buffer.from(ab);
    const cl = res.headers.get("content-length");
    this.lastHeaders = headerObj(res.headers);
    return {
      data,
      contentLength: cl != null ? Number(cl) : null,
      contentType: res.headers.get("content-type"),
      headers: this.lastHeaders,
    };
  }
}

function headerObj(h: Headers): Record<string, string> {
  const o: Record<string, string> = {};
  h.forEach((v, k) => (o[k.toLowerCase()] = v));
  return o;
}
