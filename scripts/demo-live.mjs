/**
 * Live end-to-end demo: spins up the ACTUAL MCP stdio server (the npx binary) and
 * drives it as a real MCP client — tools/list + a few live tools/call against real
 * Azure DevOps. This is the server as a client (Claude, Cursor, ...) would use it.
 *
 * All targets come from the environment — nothing org-specific is hardcoded:
 *   ADO_ORG (required), ADO_TEST_WORKITEM_ID, ADO_TEST_REPO_ID, ADO_TEST_PR
 *
 * Example:
 *   ADO_ORG=myorg ADO_TEST_WORKITEM_ID=123 ADO_TEST_REPO_ID=my-repo ADO_TEST_PR=45 \
 *     node scripts/demo-live.mjs
 */
import * as path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

if (!process.env.ADO_ORG) {
  console.error("Set ADO_ORG (and optionally ADO_TEST_WORKITEM_ID / ADO_TEST_REPO_ID / ADO_TEST_PR).");
  process.exit(2);
}

const entry = path.join(process.cwd(), "dist", "src", "index.js");
const transport = new StdioClientTransport({ command: process.execPath, args: [entry], env: { ...process.env, ADO_LOG_LEVEL: "error" }, stderr: "ignore" });
const client = new Client({ name: "live-demo", version: "0" });
await client.connect(transport);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  if (res.isError) throw new Error(`${name} -> ${res.content[0].text}`);
  return JSON.parse(res.content[0].text);
};

console.log("→ initialize + tools/list");
const list = await client.listTools();
console.log(`  ${list.tools.length} tools: ${list.tools.map((t) => t.name).join(", ")}\n`);

console.log("→ list_projects()  [org-wide]");
const projects = await call("list_projects", {});
console.log(`  ${projects.count} projects: ${projects.items.slice(0, 8).map((p) => p.name).join(", ")}`);

console.log("\n→ list_repositories()  [org-wide, all projects]");
const repos = await call("list_repositories", {});
console.log(`  ${repos.count} repos spanning ${new Set(repos.items.map((r) => r.project)).size} project(s)`);

const wiId = Number(process.env.ADO_TEST_WORKITEM_ID);
if (wiId) {
  console.log(`\n→ get_work_item(${wiId})  [live, browser session]`);
  const wi = await call("get_work_item", { id: wiId });
  console.log(`  "${wi.title}"  [${wi.type}/${wi.state}]  rev=${wi.rev}  relations=${wi.relations.length}`);
}

const repoId = process.env.ADO_TEST_REPO_ID;
const prId = Number(process.env.ADO_TEST_PR);
if (repoId && prId) {
  console.log(`\n→ get_pull_request(${repoId}/${prId})  [live, repo resolved by name]`);
  const pr = await call("get_pull_request", { repoId, prId });
  console.log(`  "${pr.title}"  [${pr.status}]  ${pr.sourceRefName} → ${pr.targetRefName}  reviewers=${pr.reviewers.length}  linkedWI=${pr.workItemRefs.length}`);
  const cm = await call("get_pull_request_comments", { repoId, prId });
  console.log(`  threads=${cm.threadCount}  (system=${cm.systemThreadCount}, human=${cm.humanThreadCount})`);
}

console.log("\n→ search_feeds()  [live, cross-host feeds.dev.azure.com]");
const feeds = await call("search_feeds", {});
console.log(`  ${feeds.feeds.length} feeds: ${feeds.feeds.slice(0, 6).map((f) => f.name).join(", ")}${feeds.feeds.length > 6 ? "…" : ""}`);

console.log("\n✓ Live MCP round-trip complete — real data through the real stdio server.");
await client.close();
