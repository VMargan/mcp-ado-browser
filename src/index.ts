#!/usr/bin/env node
/**
 * Single binary entry point (mission §1: one package, one npx binary).
 *
 *   npx mcp-ado-browser                -> start the MCP stdio server (9 tools)
 *   npx mcp-ado-browser authenticate   -> open a VISIBLE browser for interactive
 *                                          (re)auth on the isolated profile, persist
 *                                          the session, then re-validate headless.
 *
 * The authenticate subcommand is the "authenticate tool/mechanism" of mission §3,
 * kept out of tools/list so that list stays at exactly the 9 data tools (§7).
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createMcpServer } from "./server.js";
import { buildLiveRuntime, runAuthenticate } from "./runtime.js";
import { AdoClient } from "./ado/client.js";
import { applyArgs, parseArgs } from "./cli.js";
import { log } from "./logger.js";

const HELP = `mcp-ado-browser — read-only Azure DevOps for MCP, via your browser session (no PAT)

Usage:
  npx mcp-ado-browser [--org <org>] [--project <project>]      start the MCP stdio server
  npx mcp-ado-browser authenticate --org <org>                 interactive sign-in (visible browser)

Options (also settable via env, shown in []):
  --org <org>                 [ADO_ORG]                 organization (required)
  --project <project>         [ADO_PROJECT]             default project scope (optional; org-wide otherwise)
  --channel <chrome|msedge>   [ADO_BROWSER_CHANNEL]     installed browser to drive (default chrome)
  --user-data-dir <path>      [ADO_USER_DATA_DIR]       isolated persistent profile dir
  --cache-ttl <seconds>       [ADO_CACHE_TTL_SECONDS]   cache TTL (default 900)
  --api-version <v>           [ADO_API_VERSION]         force an api-version (else discovery/defaults)
  --no-app-window             [ADO_APP_WINDOW=0]        normal browser window for auth (not chromeless)
  --headed                    [ADO_HEADLESS=0]          run work with a visible window
`;

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2));
  applyArgs(parsed); // CLI flags -> process.env (precedence), before loadConfig
  const sub = parsed.command;

  if (sub === "authenticate" || sub === "auth") {
    process.exitCode = await runAuthenticate();
    return;
  }
  if (sub === "help" || process.argv.includes("--help") || process.argv.includes("-h")) {
    process.stdout.write(HELP);
    return;
  }

  // Default: MCP stdio server. The live client (browser session) is built lazily
  // on the first tool call so `initialize`/`tools/list` work without a browser.
  const cfg = loadConfig();
  let cached: AdoClient | null = null;
  const getClient = async (): Promise<AdoClient> => {
    if (cached) return cached;
    const rt = await buildLiveRuntime(cfg);
    cached = rt.client;
    return cached;
  };

  const server = createMcpServer({ getClient });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  log.info("MCP stdio server ready (mcp-ado-browser).");
}

main().catch((e) => {
  log.error(`fatal: ${String(e)}`);
  process.exit(1);
});
