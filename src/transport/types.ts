/**
 * Transport abstraction. The high-level ADO client always builds *canonical real*
 * URLs (https://dev.azure.com/{org}/...). A transport decides how to execute them:
 *
 *  - BrowserTransport: runs `page.evaluate(fetch(url))` same-origin so the browser
 *    session cookies are attached automatically and JSON comes back. (live)
 *  - MockTransport: rewrites the URL's origin onto a local MockAdoServer but records
 *    the canonical URL for URL-spy assertions. (offline/deterministic)
 *
 * Both apply the mandatory headers (Accept + X-TFS-FedAuthRedirect: Suppress) and
 * both surface 401 -> AuthRequiredError, 404 -> NotFoundError uniformly.
 */
export interface FetchInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export interface BinaryResult {
  data: Buffer;
  /** Parsed Content-Length header (bytes), or null if absent. */
  contentLength: number | null;
  contentType: string | null;
  /** All response headers, lowercased keys (for authenticity proof: x-vss-*, ActivityId). */
  headers: Record<string, string>;
}

export interface JsonResult<T> {
  data: T;
  headers: Record<string, string>;
}

export interface AdoTransport {
  /** Canonical URLs that were actually requested, in order (URL-spy for cache/live gates). */
  readonly calledUrls: string[];
  /** Number of network round-trips issued through this transport. */
  readonly fetchCount: number;
  /** Identifies the transport kind so live gates can assert they did NOT hit the mock. */
  readonly kind: "browser" | "mock";
  /** Response headers of the most recent call (authenticity proof: ActivityId / x-vss-*). */
  readonly lastHeaders: Record<string, string>;

  fetchJson<T>(url: string, init?: FetchInit): Promise<JsonResult<T>>;
  fetchBuffer(url: string, init?: FetchInit): Promise<BinaryResult>;

  /** Reset instrumentation counters (used between gate assertions). */
  resetCounters(): void;
}

/** The mandatory headers every ADO request must carry (mission §1). */
export function mandatoryHeaders(extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: "application/json",
    "X-TFS-FedAuthRedirect": "Suppress",
    ...(extra ?? {}),
  };
}
