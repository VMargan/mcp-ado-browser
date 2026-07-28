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

/** Session is dead / expired. The agent must re-run `authenticate`. */
export class AuthRequiredError extends AdoError {
  constructor(url?: string, extra?: Record<string, unknown>) {
    super(
      "AUTH_REQUIRED",
      "AUTH_REQUIRED: not signed in to Azure DevOps. Call the `authenticate` tool (it opens a browser for interactive sign-in), then retry this request.",
      url || extra ? { ...(url ? { url } : {}), ...(extra ?? {}) } : undefined,
    );
    this.name = "AuthRequiredError";
  }
}

/**
 * The isolated browser profile is locked by another Chrome instance — almost
 * always a still-open interactive sign-in window. Raised instead of Playwright's
 * raw "Failed to create .../SingletonLock: File exists" stack.
 */
export class ProfileLockedError extends AdoError {
  constructor(userDataDir: string, cause?: string) {
    super(
      "CONFIG_ERROR",
      "PROFILE_LOCKED: the browser profile is already in use — an authentication window is probably still open. " +
        "Close it (or finish the sign-in) and retry.",
      { userDataDir, ...(cause ? { cause: cause.slice(0, 300) } : {}) },
    );
    this.name = "ProfileLockedError";
  }
}

/**
 * Authenticated, but not allowed on this resource (HTTP 403). Deliberately NOT an
 * AuthRequiredError: re-running `authenticate` cannot fix a permission problem, and
 * conflating the two turns a clear "you may not read this feed" into a misleading
 * "not signed in".
 */
export class ForbiddenError extends AdoError {
  readonly status = 403;
  constructor(url: string, body?: string) {
    super("HTTP_ERROR", `FORBIDDEN (403): the signed-in account is not allowed to access ${url}. This is a permission issue, not a sign-in issue.`, {
      status: 403,
      url,
      ...(body ? { body: body.slice(0, 500) } : {}),
    });
    this.name = "ForbiddenError";
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
    if (status === 401) return new AuthRequiredError(url);
    if (status === 403) return new ForbiddenError(url);
    return new HttpError(status, url);
  }
  if (err instanceof AdoError) return err;
  return new AdoError("INTERNAL", msg);
}
