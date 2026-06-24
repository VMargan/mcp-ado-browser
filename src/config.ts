/**
 * All runtime configuration is sourced from environment variables (mission §9).
 * Nothing about a specific org/project/id/api-version is ever hardcoded — every
 * such value flows through here or through dynamic discovery.
 */
import { z } from "zod";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigError } from "./errors.js";

const intFromEnv = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === "" ? def : Number(v)))
    .pipe(z.number().int().nonnegative());

/** Default persistent profile dir: an isolated, dedicated profile (NOT the user's daily browser). */
function defaultUserDataDir(): string {
  return path.join(os.homedir(), ".mcp-ado-browser", "profile");
}

export interface ResolvedConfig {
  org: string | null;
  project: string | null;
  userDataDir: string;
  browserChannel: "chrome" | "msedge";
  cacheTtlSeconds: number;
  cacheTtlOverrides: Record<string, number>;
  apiVersionOverride: string | null;
  cacheDbPath: string;
  fixturesDir: string;
  /** Real ids used by the live smoke / acceptance pass. */
  test: {
    workItemId: number | null;
    repoId: string | null;
    prId: number | null;
    feedId: string | null;
  };
  headless: boolean;
}

const ChannelSchema = z.enum(["chrome", "msedge"]);

/**
 * Parse env. `requireConnection` enforces org/project presence (needed for live);
 * mock-only runs can proceed without them.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
  const channel = ChannelSchema.safeParse(env.ADO_BROWSER_CHANNEL ?? "chrome");
  if (!channel.success) throw new ConfigError(`ADO_BROWSER_CHANNEL must be 'chrome' or 'msedge'`);

  const userDataDir = env.ADO_USER_DATA_DIR && env.ADO_USER_DATA_DIR.trim() !== "" ? env.ADO_USER_DATA_DIR : defaultUserDataDir();

  const ttl = intFromEnv(900).parse(env.ADO_CACHE_TTL_SECONDS);

  // Per-resource overrides: ADO_CACHE_TTL_<RESOURCE>=seconds (e.g. ADO_CACHE_TTL_WORKITEM=60)
  const overrides: Record<string, number> = {};
  for (const [k, v] of Object.entries(env)) {
    const m = k.match(/^ADO_CACHE_TTL_([A-Z_]+)$/);
    if (m && v != null && v !== "" && k !== "ADO_CACHE_TTL_SECONDS") {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) overrides[m[1].toLowerCase()] = n;
    }
  }

  const dataRoot = path.join(userDataDir, "..");
  const num = (v: string | undefined): number | null => (v && v.trim() !== "" ? Number(v) : null);
  const str = (v: string | undefined): string | null => (v && v.trim() !== "" ? v.trim() : null);

  return {
    org: str(env.ADO_ORG),
    project: str(env.ADO_PROJECT),
    userDataDir,
    browserChannel: channel.data,
    cacheTtlSeconds: ttl,
    cacheTtlOverrides: overrides,
    apiVersionOverride: str(env.ADO_API_VERSION),
    cacheDbPath: env.ADO_CACHE_DB && env.ADO_CACHE_DB.trim() !== "" ? env.ADO_CACHE_DB : path.join(dataRoot, "cache.sqlite"),
    fixturesDir: env.ADO_FIXTURES_DIR && env.ADO_FIXTURES_DIR.trim() !== "" ? env.ADO_FIXTURES_DIR : path.join(process.cwd(), "fixtures"),
    test: {
      workItemId: num(env.ADO_TEST_WORKITEM_ID),
      repoId: str(env.ADO_TEST_REPO_ID),
      prId: num(env.ADO_TEST_PR),
      feedId: str(env.ADO_TEST_FEED),
    },
    headless: env.ADO_HEADLESS === "0" ? false : true,
  };
}

/**
 * Only the ORGANIZATION is required. The project is optional: the server browses
 * EVERY project, repo and feed the user can access. A configured project is only
 * ever used as a default scope for tools that accept an optional `project` arg.
 */
export function requireConnection(cfg: ResolvedConfig): asserts cfg is ResolvedConfig & { org: string } {
  if (!cfg.org) throw new ConfigError("ADO_ORG is required");
}
