/**
 * Structured error taxonomy. Every tool failure maps to one of these so the MCP
 * layer can emit a clean, machine-readable error instead of a stack trace.
 *
 * Sentinel strings (ADO_AUTH_EXPIRED, ADO_HTTP_xxx) are thrown deep in the
 * transport (inside page.evaluate) where only strings survive serialization;
 * they are re-hydrated into these classes at the transport boundary.
 */

export type AdoErrorCode =
  | "AUTH_REQUIRED"
  | "NOT_FOUND"
  | "HTTP_ERROR"
  | "VALIDATION_ERROR"
  | "EMPIRICALLY_BLOCKED"
  | "CONFIG_ERROR"
  | "INTERNAL";

export class AdoError extends Error {
  readonly code: AdoErrorCode;
  readonly details?: Record<string, unknown>;
  constructor(code: AdoErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "AdoError";
    this.code = code;
    this.details = details;
  }
  toJSON() {
    return { code: this.code, message: this.message, ...(this.details ? { details: this.details } : {}) };
  }
}

/** Session cookie is dead / expired. The agent must re-run `authenticate`. */
export class AuthRequiredError extends AdoError {
  constructor(url?: string) {
    super("AUTH_REQUIRED", "AUTH_REQUIRED: run the `authenticate` tool", url ? { url } : undefined);
    this.name = "AuthRequiredError";
  }
}

/** A requested id/resource does not exist. */
export class NotFoundError extends AdoError {
  constructor(resource: string, id: string | number, url?: string) {
    super("NOT_FOUND", `NOT_FOUND: ${resource} '${id}' does not exist`, { resource, id, ...(url ? { url } : {}) });
    this.name = "NotFoundError";
  }
}

/** Any other non-2xx HTTP response. */
export class HttpError extends AdoError {
  readonly status: number;
  constructor(status: number, url: string, body?: string) {
    super("HTTP_ERROR", `ADO_HTTP_${status}: ${url}`, { status, url, ...(body ? { body: body.slice(0, 500) } : {}) });
    this.name = "HttpError";
    this.status = status;
  }
}

/** Output JSON did not match its declared zod schema (schema drift). */
export class ValidationError extends AdoError {
  constructor(message: string, issues?: unknown) {
    super("VALIDATION_ERROR", `VALIDATION_ERROR: ${message}`, issues ? { issues } : undefined);
    this.name = "ValidationError";
  }
}

/** A feature that was empirically proven unavailable via the browser session. */
export class EmpiricallyBlockedError extends AdoError {
  constructor(message: string, evidence: Record<string, unknown>) {
    super("EMPIRICALLY_BLOCKED", `EMPIRICALLY_BLOCKED: ${message}`, evidence);
    this.name = "EmpiricallyBlockedError";
  }
}

export class ConfigError extends AdoError {
  constructor(message: string) {
    super("CONFIG_ERROR", `CONFIG_ERROR: ${message}`);
    this.name = "ConfigError";
  }
}

/** Sentinel thrown from inside page.evaluate (only strings survive there). */
export const SENTINEL = {
  authExpired: "ADO_AUTH_EXPIRED",
  httpPrefix: "ADO_HTTP_", // followed by `${status}:${url}`
} as const;

/** Re-hydrate a sentinel string thrown across the page.evaluate boundary. */
export function rehydrateSentinel(err: unknown, fallbackUrl?: string): AdoError {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes(SENTINEL.authExpired)) return new AuthRequiredError(fallbackUrl);
  const m = msg.match(/ADO_HTTP_(\d+):(.*)$/s);
  if (m) {
    const status = Number(m[1]);
    const url = m[2] || fallbackUrl || "";
    if (status === 404) return new NotFoundError("resource", url, url);
    if (status === 401 || status === 403) return new AuthRequiredError(url);
    return new HttpError(status, url);
  }
  if (err instanceof AdoError) return err;
  return new AdoError("INTERNAL", msg);
}
