/**
 * CLI argument parsing so configuration can be passed directly to the npx binary,
 * e.g. `npx mcp-ado-browser --org myorg` or `npx mcp-ado-browser authenticate --org myorg`.
 * Flags map onto the same env vars used everywhere else; env still works and CLI
 * flags take precedence. Only the organization is required.
 */
export interface ParsedArgs {
  /** First non-flag token: a subcommand (e.g. "authenticate") or null. */
  command: string | null;
  /** Env overrides derived from flags (to merge into process.env). */
  env: Record<string, string>;
}

const FLAG_TO_ENV: Record<string, string> = {
  org: "ADO_ORG",
  project: "ADO_PROJECT",
  channel: "ADO_BROWSER_CHANNEL",
  "user-data-dir": "ADO_USER_DATA_DIR",
  "cache-ttl": "ADO_CACHE_TTL_SECONDS",
  "api-version": "ADO_API_VERSION",
  "log-level": "ADO_LOG_LEVEL",
};

/** Boolean flags (presence => value). */
const BOOL_FLAGS: Record<string, [string, string]> = {
  "no-app-window": ["ADO_APP_WINDOW", "0"],
  "no-sandbox": ["ADO_NO_SANDBOX", "1"],
  headed: ["ADO_HEADLESS", "0"],
};

export function parseArgs(argv: string[]): ParsedArgs {
  const env: Record<string, string> = {};
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      const name = eq === -1 ? body : body.slice(0, eq);
      if (BOOL_FLAGS[name]) {
        const [k, v] = BOOL_FLAGS[name];
        env[k] = v;
        continue;
      }
      const envKey = FLAG_TO_ENV[name];
      if (!envKey) continue; // unknown flag: ignore (help/-h handled by caller)
      let value: string;
      if (eq !== -1) value = body.slice(eq + 1);
      else value = argv[++i] ?? "";
      env[envKey] = value;
    } else if (command === null) {
      command = tok;
    }
  }
  return { command, env };
}

/** Apply parsed flag overrides onto process.env (CLI precedence over existing env). */
export function applyArgs(parsed: ParsedArgs): void {
  for (const [k, v] of Object.entries(parsed.env)) process.env[k] = v;
}
