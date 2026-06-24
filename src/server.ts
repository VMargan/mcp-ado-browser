/**
 * MCP server wiring. Registers exactly the 9 data tools (tools/list contract,
 * mission §7). `authenticate` is a subcommand of the same binary (see index.ts),
 * not a 10th tool — keeping tools/list at exactly 9 while staying one package.
 *
 * Every tool result is a well-formed content block. Failures map to a structured
 * AdoError JSON with isError:true — never a stack trace, never a partial success.
 */
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AdoClient } from "./ado/client.js";
import { TOOL_DEFS } from "./tools/defs.js";
import { AdoError } from "./errors.js";
import { AuthResult } from "./ado/schemas.js";
import { toAdoError } from "./tools/errors.js";
import { log } from "./logger.js";

export interface McpServerDeps {
  /** Lazily provides a live AdoClient (browser session built on first call). */
  getClient: () => Promise<AdoClient>;
  /** Interactive sign-in (opens a visible browser). When absent, the tool reports it must be run via the CLI. */
  authenticate?: (timeoutSeconds: number) => Promise<AuthResult>;
  name?: string;
  version?: string;
}

const AUTH_TOOL_DESCRIPTION =
  "Sign in to Azure DevOps by opening a VISIBLE browser window for interactive login (MFA included). Run this once (or whenever a tool returns AUTH_REQUIRED). The session is persisted on an isolated profile and reused headless afterward — no PAT or token is ever stored.";

export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: deps.name ?? "mcp-ado-browser", version: deps.version ?? "0.0.0" });

  for (const t of TOOL_DEFS) {
    server.registerTool(t.name, { description: t.description, inputSchema: t.inputShape }, async (args: unknown) => {
      try {
        const client = await deps.getClient();
        const out = await t.run(client, args as any);
        return { content: [{ type: "text" as const, text: JSON.stringify(out, null, 2) }] };
      } catch (e) {
        const err: AdoError = toAdoError(e);
        log.warn(`tool ${t.name} failed: ${err.code} ${err.message}`);
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(err.toJSON()) }] };
      }
    });
  }

  // The `authenticate` tool — folds the interactive sign-in into the MCP itself so
  // setup is a single client-config step (no separate terminal command).
  server.registerTool(
    "authenticate",
    {
      description: AUTH_TOOL_DESCRIPTION,
      inputSchema: { timeoutSeconds: z.number().int().positive().max(600).optional().describe("How long to wait for sign-in (default 240s).") },
    },
    async (args: { timeoutSeconds?: number }) => {
      if (!deps.authenticate) {
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify({ code: "CONFIG_ERROR", message: "Interactive authenticate is unavailable here. Run: npx mcp-ado-browser authenticate --org <org>" }) }] };
      }
      try {
        const result = await deps.authenticate(args.timeoutSeconds ?? 240);
        return { isError: !result.authenticated, content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        const err = toAdoError(e);
        log.warn(`authenticate failed: ${err.code} ${err.message}`);
        return { isError: true, content: [{ type: "text" as const, text: JSON.stringify(err.toJSON()) }] };
      }
    },
  );

  return server;
}
