/**
 * `npm run verify` — runs ALL gates and prints a detailed pass/fail report.
 *
 * Offline gates (browser stack, MCP, tools, cache, artifacts, no-hardcoding) must
 * be 100% green. The live acceptance gate runs only with ADO_LIVE=1; otherwise it
 * reports BLOCKED_ON_AUTH (transitory) — the run is not "done" until it is green.
 *
 * Exit codes: 1 = FAIL (fix and re-run); 2 = live BLOCKED_ON_AUTH (authenticate);
 * 0 = all offline green (and live green when run with ADO_LIVE=1).
 */
import * as path from "node:path";
import { Reporter } from "./report.js";
import { gate0 } from "./gates/gate0.js";
import { gate1 } from "./gates/gate1.js";
import { gate2 } from "./gates/gate2.js";
import { gate3 } from "./gates/gate3.js";
import { gateGrep } from "./gates/gate-grep.js";
import { gateBrowser } from "./gates/gate-browser.js";
import { gateLive } from "./gates/gate-live.js";
import { dumpFixtures } from "../mock-fixtures.js";

async function main(): Promise<void> {
  const live = process.env.ADO_LIVE === "1";
  const repoRoot = path.resolve(process.cwd());
  const reporter = new Reporter();

  // Materialize the fixtures/ deliverable (scrubbed).
  const fixturesDir = path.join(repoRoot, "fixtures");
  const written = dumpFixtures(fixturesDir);
  process.stderr.write(`Fixtures written to fixtures/ (${written.length} files, scrubbed)\n`);

  await reporter.gate("Browser stack — restricted-env (no Playwright download, channel chrome)", gateBrowser);
  await reporter.gate("Gate 0 — Foundations + get_work_item end-to-end (mock)", gate0);
  await reporter.gate("Gate 1 — All read tools (features 1..8) against fixtures", gate1);
  await reporter.gate("Gate 2 — SQLite cache + freshness (fetchCount + URL spy)", gate2);
  await reporter.gate("Gate 3 — Artifact download pipeline + archive integrity", gate3);
  await reporter.gate("Robustness — no hardcoded org/project/ids/api-versions", gateGrep);
  await reporter.gate("Gate finale — Live acceptance pass (§4bis)", (g) => gateLive(g, path.join(repoRoot, "live-acceptance-report.json"), live));

  process.exitCode = reporter.finish(live);
}

main().catch((e) => {
  process.stderr.write(`verify crashed: ${e instanceof Error ? e.stack : String(e)}\n`);
  process.exit(1);
});
