/**
 * Login-detection logic, isolated from Playwright so it is deterministically
 * testable against MockAdoServer (Gate 0). The interactive window is driven by
 * BrowserSession; this module only decides "is this connectionData authenticated?"
 * and runs the polling loop.
 */
import { AuthRequiredError } from "../errors.js";

export interface DetectedIdentity {
  id: string;
  displayName: string;
  descriptor?: string;
}

const ANON_ID = "00000000-0000-0000-0000-000000000000";

/** Decide whether a connectionData payload represents a real, signed-in identity. */
export function detectIdentity(connectionData: any): DetectedIdentity | null {
  const u = connectionData?.authenticatedUser;
  if (!u) return null;
  const provider = u.providerDisplayName ?? u.properties?.Account?.$value;
  const isAnon = provider === "Anonymous" || u.id === ANON_ID;
  if (isAnon) return null;
  if (!u.subjectDescriptor && !u.descriptor) return null;
  return { id: String(u.id), displayName: String(provider ?? u.id), descriptor: u.subjectDescriptor ?? u.descriptor };
}

/**
 * Poll `fetchConnectionData` until it yields an authenticated identity or the
 * deadline passes. `fetchConnectionData` should throw on 401 (dead session); we
 * swallow that and keep waiting for the human to finish signing in.
 */
export async function pollUntilAuthenticated(
  fetchConnectionData: () => Promise<any>,
  opts: { timeoutMs: number; intervalMs?: number; now?: () => number; sleep?: (ms: number) => Promise<void> },
): Promise<DetectedIdentity> {
  const now = opts.now ?? (() => Date.now());
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const interval = opts.intervalMs ?? 2000;
  const deadline = now() + opts.timeoutMs;
  do {
    try {
      const data = await fetchConnectionData();
      const id = detectIdentity(data);
      if (id) return id;
    } catch {
      /* dead session / transient — keep polling until deadline */
    }
    if (now() >= deadline) break;
    await sleep(interval);
  } while (now() < deadline);
  throw new AuthRequiredError();
}
