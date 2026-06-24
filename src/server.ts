/**
 * MCP server wiring. Registers exactly the 9 data tools (tools/list contract,
 * mission §7). `authenticate` is a subcommand of the same binary (see index.ts),
 * not a 10th tool — keeping tools/list at exactly 9 while staying one package.
 *
 * Every tool result is a well-formed content block. Failures map to a structured
 * AdoError JSON with isError:true — never a stack trace, never a partial success.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AdoClient } from "./ado/client.js";
import { TOOL_DEFS } from "./tools/defs.js";
import { AdoError } from "./errors.js";
import { toAdoError } from "./tools/errors.js";
import { log } from "./logger.js";

export interface McpServerDeps {
  /** Lazily provides a live AdoClient (browser session built on first call). */
  getClient: () => Promise<AdoClient>;
  name?: string;
  version?: string;
}

export function createMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer({ name: deps.name ?? "mcp-ado-browser", version: deps.version ?? "0.1.0" });

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

  return server;
}
