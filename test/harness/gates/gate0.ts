/** Gate 0 — Foundations + one end-to-end tool, validated offline against the mock. */
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { GateRun } from "../report.js";
import { assert, makeClient, makeMockTransport } from "../helpers.js";
import { startMock } from "../../mock-fixtures.js";
import { createMcpServer } from "../../../src/server.js";
import { TOOL_DEFS } from "../../../src/tools/defs.js";
import { AuthRequiredError, NotFoundError } from "../../../src/errors.js";
import { detectIdentity, pollUntilAuthenticated } from "../../../src/browser/auth-detect.js";
import { mandatoryHeaders } from "../../../src/transport/types.js";
import { parseArgs } from "../../../src/cli.js";

/** The canonical tool set exposed by tools/list (9 read tools + 2 discovery tools + authenticate). */
export const EXPECTED_TOOLS = [
  "list_projects",
  "list_repositories",
  "search_work_items",
  "get_work_item",
  "get_work_item_comments",
  "get_comment_details",
  "search_pull_requests",
  "get_pull_request",
  "get_pull_request_comments",
  "search_feeds",
  "download_artifact",
  "authenticate",
];

export async function gate0(g: GateRun): Promise<void> {
  const { server, baseUrl } = await startMock();
  try {
    // 0.1 — MCP conformance: initialize + tools/list exposes exactly the canonical tools.
    await g.assert(`0.1 MCP initialize + tools/list exposes exactly ${EXPECTED_TOOLS.length} tools with input schemas`, async () => {
      const mcp = createMcpServer({ getClient: async () => makeClient({ mockBaseUrl: baseUrl }) });
      const client = new Client({ name: "verify", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(a), client.connect(b)]);
      const list = await client.listTools();
      assert(list.tools.length === EXPECTED_TOOLS.length, `expected ${EXPECTED_TOOLS.length} tools, got ${list.tools.length}`);
      const names = new Set(list.tools.map((t) => t.name));
      for (const n of EXPECTED_TOOLS) assert(names.has(n), `missing tool ${n}`);
      for (const t of list.tools) assert(t.inputSchema && t.inputSchema.type === "object", `tool ${t.name} has no object input schema`);
      await client.close();
      return `${EXPECTED_TOOLS.length} tools: ${EXPECTED_TOOLS.join(", ")}`;
    });

    // 0.1b — the ACTUAL binary (`npx <pkg>`) starts a real stdio MCP process and
    //        answers initialize + tools/list over JSON-RPC on stdout.
    await g.assert("0.1b real `node dist/src/index.js` process answers initialize + tools/list over stdio", async () => {
      const entry = path.join(process.cwd(), "dist", "src", "index.js");
      const transport = new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "ignore" });
      const client = new Client({ name: "verify-stdio", version: "0" });
      await client.connect(transport); // performs the initialize handshake
      const list = await client.listTools();
      assert(list.tools.length === EXPECTED_TOOLS.length, `stdio process reported ${list.tools.length} tools`);
      await client.close();
      return `stdio handshake OK, ${list.tools.length} tools`;
    });

    // 0.2 — tools/call get_work_item returns a zod-valid JSON content block.
    await g.assert("0.2 tools/call get_work_item -> well-formed, schema-valid JSON content block", async () => {
      const mcp = createMcpServer({ getClient: async () => makeClient({ mockBaseUrl: baseUrl }) });
      const client = new Client({ name: "verify", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(a), client.connect(b)]);
      const res: any = await client.callTool({ name: "get_work_item", arguments: { id: 101 } });
      assert(!res.isError, `unexpected isError: ${JSON.stringify(res.content)}`);
      assert(Array.isArray(res.content) && res.content[0]?.type === "text", "content block not text");
      const wi = JSON.parse(res.content[0].text);
      assert(wi.id === 101 && wi.type === "Bug" && wi.title.length > 0, "work item fields missing");
      assert(Array.isArray(wi.relations) && wi.relations.length >= 4, "relations not populated");
      await client.close();
      return `id=${wi.id} rev=${wi.rev} relations=${wi.relations.length}`;
    });

    // 0.3 — 401 injection => structured AUTH_REQUIRED, no crash, no partial output.
    await g.assert("0.3 401 -> AUTH_REQUIRED structured error (no crash, no partial output)", async () => {
      server.failAuth = true;
      try {
        const c = makeClient({ mockBaseUrl: baseUrl });
        let threw: unknown;
        try {
          await c.getWorkItem(101, { bypassCache: true });
        } catch (e) {
          threw = e;
        }
        assert(threw instanceof AuthRequiredError, `expected AuthRequiredError, got ${threw}`);
        assert((threw as AuthRequiredError).code === "AUTH_REQUIRED", "wrong code");
        // Also via MCP boundary -> isError content with code AUTH_REQUIRED.
        const mcp = createMcpServer({ getClient: async () => makeClient({ mockBaseUrl: baseUrl }) });
        const client = new Client({ name: "verify", version: "0" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([mcp.connect(a), client.connect(b)]);
        const res: any = await client.callTool({ name: "get_work_item", arguments: { id: 101 } });
        assert(res.isError === true, "expected isError true");
        const err = JSON.parse(res.content[0].text);
        assert(err.code === "AUTH_REQUIRED", `expected AUTH_REQUIRED, got ${err.code}`);
        await client.close();
        return "structured AUTH_REQUIRED at client + MCP boundary";
      } finally {
        server.failAuth = false;
      }
    });

    // 0.4 — mandatory X-TFS-FedAuthRedirect header is enforced (and always sent).
    await g.assert("0.4 X-TFS-FedAuthRedirect:Suppress is mandatory and always sent", async () => {
      // a) our transport always sends it -> normal call works
      const t = makeMockTransport(baseUrl);
      await t.fetchJson(`https://dev.azure.com/contoso/_apis/connectionData?api-version=7.1`);
      // b) a raw call WITHOUT the header is rejected 400 by the mock (proves enforcement)
      const before = server.missingFedAuthHeaderCount;
      const raw = await fetch(`${baseUrl}/contoso/_apis/connectionData`, { headers: { Accept: "application/json", "x-ado-real-host": "dev.azure.com" } });
      assert(raw.status === 400, `expected 400 without header, got ${raw.status}`);
      assert(server.missingFedAuthHeaderCount === before + 1, "mock did not flag missing header");
      // c) confirm our mandatoryHeaders includes it
      assert(mandatoryHeaders()["X-TFS-FedAuthRedirect"] === "Suppress", "mandatoryHeaders missing the header");
      return "enforced (400 when absent) + present on every request";
    });

    // 0.5 — id that does not exist => NOT_FOUND, not a crash.
    await g.assert("0.5 nonexistent id -> NOT_FOUND structured error", async () => {
      const c = makeClient({ mockBaseUrl: baseUrl });
      let threw: unknown;
      try {
        await c.getWorkItem(99999, { bypassCache: true });
      } catch (e) {
        threw = e;
      }
      assert(threw instanceof NotFoundError, `expected NotFoundError, got ${threw}`);
      return "NOT_FOUND";
    });

    // 0.6 — authenticate detection logic (deterministic, against the mock).
    await g.assert("0.6 authenticate login-detection polls connectionData until authenticated", async () => {
      // anonymous payload -> not detected
      assert(detectIdentity({ authenticatedUser: { providerDisplayName: "Anonymous", id: "00000000-0000-0000-0000-000000000000" } }) === null, "anonymous wrongly detected");
      // real identity -> detected
      const id = detectIdentity({ authenticatedUser: { id: "u1", providerDisplayName: "Jane", subjectDescriptor: "aad.x" } });
      assert(id?.id === "u1", "real identity not detected");
      // polling: third poll returns authenticated
      let n = 0;
      const got = await pollUntilAuthenticated(
        async () => {
          n++;
          if (n < 3) throw new AuthRequiredError(); // session not ready yet
          return { authenticatedUser: { id: "u1", providerDisplayName: "Jane", subjectDescriptor: "aad.x" } };
        },
        { timeoutMs: 10_000, intervalMs: 1, now: () => Date.now() },
      );
      assert(got.id === "u1" && n === 3, `polling failed (n=${n})`);
      // dead session forever -> throws AuthRequired within deadline
      let timedOut = false;
      try {
        await pollUntilAuthenticated(async () => { throw new AuthRequiredError(); }, { timeoutMs: 5, intervalMs: 1 });
      } catch (e) {
        timedOut = e instanceof AuthRequiredError;
      }
      assert(timedOut, "dead session did not time out to AuthRequired");
      return "detection + polling verified";
    });

    // 0.7 — every data tool def declares input + output schema (wiring sanity).
    //       TOOL_DEFS are the 11 data tools; `authenticate` is registered separately.
    g.check(`0.7 all ${TOOL_DEFS.length} data tool defs declare input shape + output schema`, TOOL_DEFS.every((t) => t.inputShape && t.outputSchema) && TOOL_DEFS.length === EXPECTED_TOOLS.length - 1, `${TOOL_DEFS.length} defs + authenticate`);

    // 0.7b — the authenticate tool is exposed and gated when no runtime is provided.
    await g.assert("0.7b authenticate tool is listed and reports clearly when no runtime is wired", async () => {
      const mcp = createMcpServer({ getClient: async () => makeClient({ mockBaseUrl: baseUrl }) }); // no `authenticate` dep
      const client = new Client({ name: "verify", version: "0" });
      const [a, b] = InMemoryTransport.createLinkedPair();
      await Promise.all([mcp.connect(a), client.connect(b)]);
      const res: any = await client.callTool({ name: "authenticate", arguments: {} });
      assert(res.isError === true, "authenticate without runtime should report an error");
      const err = JSON.parse(res.content[0].text);
      assert(err.code === "CONFIG_ERROR", `expected CONFIG_ERROR, got ${err.code}`);
      await client.close();
      return "authenticate present + gated";
    });

    // 0.8 — CLI args map onto env (so `npx mcp-ado-browser --org X` works).
    await g.assert("0.8 CLI flags parse into config (--org, --project, subcommand, bool flags)", () => {
      const p = parseArgs(["authenticate", "--org", "myorg", "--project=Proj", "--no-app-window"]);
      assert(p.command === "authenticate", "subcommand not parsed");
      assert(p.env.ADO_ORG === "myorg", "--org not mapped");
      assert(p.env.ADO_PROJECT === "Proj", "--project= not mapped");
      assert(p.env.ADO_APP_WINDOW === "0", "--no-app-window not mapped");
      const p2 = parseArgs(["--org=acme"]);
      assert(p2.command === null && p2.env.ADO_ORG === "acme", "no-subcommand form failed");
      return "flags + subcommand parsed";
    });
  } finally {
    await server.stop();
  }
}
