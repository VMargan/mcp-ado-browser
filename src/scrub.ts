/**
 * Deterministic scrubbing of personal identifiers before anything is written to
 * disk (fixtures, live-acceptance-report.json). Same input -> same pseudonym, so
 * checksums stay stable across runs while emails/names/UPNs never leak.
 */
import * as crypto from "node:crypto";

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/** Keys whose string values are treated as personal and pseudonymized wholesale. */
const PERSONAL_KEYS = new Set(["displayname", "uniquename", "mail", "principalname", "emailaddress", "directoryalias", "authenticateduser"]);

function pseudo(prefix: string, value: string): string {
  const h = crypto.createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${prefix}-${h}`;
}

function scrubString(s: string): string {
  return s.replace(EMAIL_RE, (m) => `user-${crypto.createHash("sha256").update(m).digest("hex").slice(0, 8)}@example.invalid`);
}

export function scrub<T>(value: T): T {
  return walk(value) as T;
}

function walk(value: unknown): unknown {
  if (typeof value === "string") return scrubString(value);
  if (Array.isArray(value)) return value.map(walk);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v === "string" && PERSONAL_KEYS.has(k.toLowerCase())) {
        out[k] = pseudo("person", v);
      } else {
        out[k] = walk(v);
      }
    }
    return out;
  }
  return value;
}
