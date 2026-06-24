/**
 * Azure DevOps service topology. These are platform-fixed host *templates*
 * parameterized solely by the organization name — NOT org-specific data and
 * NOT hardcoded ids/projects. Centralized here so the URL-spy gates and the
 * "no hardcoded org" grep gate have exactly one place to reason about.
 *
 * Every host below is `<service>.dev.azure.com/{org}` form; the org is injected.
 */

export type HostKind = "core" | "feeds" | "pkgs" | "search" | "analytics";

const HOST_TEMPLATES: Record<HostKind, (org: string) => string> = {
  core: (org) => `https://dev.azure.com/${org}`,
  feeds: (org) => `https://feeds.dev.azure.com/${org}`,
  pkgs: (org) => `https://pkgs.dev.azure.com/${org}`,
  search: (org) => `https://almsearch.dev.azure.com/${org}`,
  analytics: (org) => `https://analytics.dev.azure.com/${org}`,
};

export class HostResolver {
  constructor(private readonly org: string) {
    if (!org) throw new Error("HostResolver requires an org");
  }
  base(kind: HostKind): string {
    return HOST_TEMPLATES[kind](this.org);
  }
  /** True if the given absolute URL points at one of the real ADO hosts (used by live gates). */
  static isRealAdoHost(url: string): boolean {
    try {
      const h = new URL(url).host;
      return /\.dev\.azure\.com$/.test(h) || h === "dev.azure.com";
    } catch {
      return false;
    }
  }
}
