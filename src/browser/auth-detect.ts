/**
 * Login-detection logic, isolated from Playwright so it is deterministically
 * testable against MockAdoServer (Gate 0). The interactive window is driven by
 * BrowserSession; this module only decides "is this connectionData authenticated?"
 * and runs the polling loop.
 */
import { AuthRequiredError } from "../errors.js";
import { log } from "../logger.js";

export interface DetectedIdentity {
  id: string;
  displayName: string;
  descriptor?: string;
}

const ANON_ID = "00000000-0000-0000-0000-000000000000";
/** ADO's "anonymous / not authorized" identity in TF400813 error payloads. */
const ANON_ID_ALT = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";

/**
 * Why a connectionData probe did not yield an identity. Surfaced in logs and in
 * the final AuthRequiredError: a silent "keep polling" made a 401, a non-JSON
 * body and an anonymous identity indistinguishable from outside, which is what
 * let a session-expiry symptom be misdiagnosed as a transport bug.
 */
export interface DetectionDiagnostic {
  reason: string;
  status?: number;
  contentType?: string;
  bodyPrefix?: string;
  url?: string;
  /** Where the browser actually is, when it never reached the ADO origin. */
  landedOn?: string;
}

/** Decide whether a connectionData payload represents a real, signed-in identity. */
export function detectIdentity(connectionData: any): DetectedIdentity | null {
  return detectIdentityVerbose(connectionData).identity;
}

/**
 * Same as `detectIdentity` but also explains a rejection.
 *
 * Deliberately lenient about descriptors: some tenants/api-versions return a
 * perfectly authenticated `authenticatedUser` without `subjectDescriptor` or
 * `descriptor`. A non-anonymous id plus a display name IS an identity; requiring
 * a descriptor would reject a valid session.
 */
export function detectIdentityVerbose(connectionData: any): { identity: DetectedIdentity | null; diagnostic?: DetectionDiagnostic } {
  const u = connectionData?.authenticatedUser;
  if (!u) {
    return { identity: null, diagnostic: { reason: "payload has no authenticatedUser" } };
  }
  const provider = u.providerDisplayName ?? u.properties?.Account?.$value;
  const id = u.id != null ? String(u.id) : "";
  if (provider === "Anonymous" || id === ANON_ID || id === ANON_ID_ALT) {
    return { identity: null, diagnostic: { reason: `anonymous identity (id=${id || "?"}, provider=${provider ?? "?"})` } };
  }
  if (!id) {
    return { identity: null, diagnostic: { reason: "authenticatedUser has no id" } };
  }
  const descriptor = u.subjectDescriptor ?? u.descriptor;
  if (!descriptor) log.debug("connectionData identity has neither subjectDescriptor nor descriptor — accepting on non-anonymous id");
  return { identity: { id, displayName: String(provider ?? id), descriptor }, diagnostic: undefined };
}

/**
 * Poll `fetchConnectionData` until it yields an authenticated identity or the
 * deadline passes.
 *
 * Every failed attempt is LOGGED (status, content-type, body prefix, or the
 * rejection reason) and the last one is carried into the thrown AuthRequiredError.
 * Nothing is swallowed silently: an outside observer must be able to tell a 401
 * from an HTML redirect page from an anonymous identity.
 */
export async function pollUntilAuthenticated(
  fetchConnectionData: () => Promise<any>,
  opts: { timeoutMs: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<DetectedIdentity> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.intervalMs ?? 2000;
  const deadline = now() + opts.timeoutMs;
  let attempt = 0;
  let last: DetectionDiagnostic | undefined;
  do {
    attempt++;
    try {
      const data = await fetchConnectionData();
      const { identity, diagnostic } = detectIdentityVerbose(data);
      if (identity) return identity;
      last = diagnostic ?? { reason: "identity rejected" };
    } catch (e) {
      last = diagnosticFromError(e);
    }
    log.debug(`auth poll #${attempt}: ${formatDiagnostic(last)}`);
    if (now() >= deadline) break;
    await sleep(interval);
  } while (now() < deadline);
  log.warn(`Sign-in not detected after ${attempt} attempt(s). Last probe: ${formatDiagnostic(last)}`);
  throw new AuthRequiredError(last?.url, last ? { lastProbe: formatDiagnostic(last) } : undefined);
}

/**
 * Turn a thrown transport error into a diagnostic without losing its detail.
 *
 * Prefers the structured `reason` a transport attached ("browser is still in the
 * sign-in flow", "server returned an HTML page", …) over the error's generic
 * user-facing message — repeating "not signed in, call authenticate" once per poll
 * says nothing about WHY, which is the whole point of these logs.
 */
export function diagnosticFromError(e: unknown): DetectionDiagnostic {
  const details = (e as any)?.details as Record<string, unknown> | undefined;
  const str = (k: string): string | undefined => (typeof details?.[k] === "string" ? (details[k] as string) : undefined);
  const fallback = e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200);
  return {
    reason: str("reason") ?? fallback,
    status: typeof details?.status === "number" ? (details.status as number) : undefined,
    contentType: str("contentType"),
    bodyPrefix: str("body")?.slice(0, 200),
    url: str("url"),
    landedOn: str("landedOn"),
  };
}

export function formatDiagnostic(d?: DetectionDiagnostic): string {
  if (!d) return "(no diagnostic)";
  const parts = [d.reason];
  if (d.status !== undefined) parts.push(`status=${d.status}`);
  if (d.contentType) parts.push(`content-type=${d.contentType}`);
  if (d.url) parts.push(`url=${d.url}`);
  if (d.bodyPrefix) parts.push(`body="${d.bodyPrefix.replace(/\s+/g, " ").slice(0, 160)}"`);
  return parts.join(" | ");
}
