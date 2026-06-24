/**
 * api-version handling. Mission rule: api-versions are NOT hardcoded across the
 * codebase. They are either (a) supplied via ADO_API_VERSION, or (b) discovered,
 * or (c) fall back to a SINGLE centralized default table living only here.
 *
 * `versions.ts` is the one and only place an api-version literal may appear, and
 * the grep gate explicitly excludes this file from the "no hardcoded api-version"
 * scan because here they are the documented, overridable fallback registry.
 */

export type ApiArea =
  | "wit" // work item tracking
  | "wit-comments" // comments endpoint (preview)
  | "git" // pull requests, repos
  | "packaging-feeds" // feeds.dev.azure.com
  | "packaging-pkgs" // pkgs.dev.azure.com download
  | "search" // almsearch
  | "analytics" // OData
  | "core"; // connectionData/projects

/** Fallback defaults — used only when neither config override nor discovery applies. */
const DEFAULT_VERSIONS: Record<ApiArea, string> = {
  wit: "7.1",
  "wit-comments": "7.1-preview.4",
  git: "7.1",
  "packaging-feeds": "7.1-preview.1",
  "packaging-pkgs": "7.1-preview.1",
  search: "7.1-preview.1",
  analytics: "v4.0-preview",
  // connectionData is a PREVIEW resource: a non-preview api-version returns HTTP 400
  // (VssInvalidPreviewVersionException). Confirmed empirically against a live org.
  core: "7.1-preview",
};

export class VersionRegistry {
  private discovered: Partial<Record<ApiArea, string>> = {};
  constructor(private readonly override: string | null) {}

  /** Resolve effective version for an area: explicit override > discovered > default. */
  forArea(area: ApiArea): string {
    if (this.override) return this.override;
    return this.discovered[area] ?? DEFAULT_VERSIONS[area];
  }

  /** Record a version learned via discovery (e.g. OPTIONS / ResourceAreas). */
  setDiscovered(area: ApiArea, version: string): void {
    this.discovered[area] = version;
  }

  snapshot(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const area of Object.keys(DEFAULT_VERSIONS) as ApiArea[]) out[area] = this.forArea(area);
    return out;
  }
}

/** Append api-version to a URL, respecting an already-present query string. */
export function withApiVersion(url: string, version: string): string {
  if (/[?&]api-version=/.test(url)) return url;
  const sep = url.includes("?") ? "&" : "?";
  return `${url}${sep}api-version=${encodeURIComponent(version)}`;
}
