/**
 * Robustness gate — source contains no hardcoded org/project/ids/api-versions.
 * The api-version registry (versions.ts) is the single allowed home for version
 * literals and is excluded from that scan by design.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { GateRun } from "../report.js";
import { assert } from "../helpers.js";
import { loadConfig } from "../../../src/config.js";

// Scan the real TypeScript SOURCE tree (verify runs from the repo root), not dist/.
const SRC_DIR = path.join(process.cwd(), "src");

function listTs(dir: string): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...listTs(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}

export async function gateGrep(g: GateRun): Promise<void> {
  const files = listTs(SRC_DIR);

  g.check("R.0 source tree found and non-empty", files.length > 5, `${files.length} .ts files scanned`);

  // 1 — no api-version=<literal> outside versions.ts (we use withApiVersion()).
  await g.assert("R.1 no hardcoded api-version literal outside versions.ts", () => {
    const offenders: string[] = [];
    for (const f of files) {
      if (path.basename(f) === "versions.ts") continue;
      const src = fs.readFileSync(f, "utf8");
      if (/api-version=\d/.test(src)) offenders.push(path.relative(SRC_DIR, f));
    }
    assert(offenders.length === 0, `api-version literals found in: ${offenders.join(", ")}`);
    return "none";
  });

  // 2 — no hardcoded org slug in a dev.azure.com path (host templates live in hosts.ts).
  await g.assert("R.2 no hardcoded org/project segment in any dev.azure.com URL", () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8");
      // match dev.azure.com/<literal-segment>/_apis where segment is not a template (${...})
      const re = /dev\.azure\.com\/(?!\$\{)[A-Za-z0-9][A-Za-z0-9._-]*\/_apis/g;
      if (re.test(src)) offenders.push(path.relative(SRC_DIR, f));
    }
    assert(offenders.length === 0, `hardcoded org/project segment in: ${offenders.join(", ")}`);
    return "org/project always injected";
  });

  // 3 — if real org/project/ids are configured, they must NOT appear in source.
  //     We scan for the configured VALUES, after removing the Microsoft product
  //     brand phrases ("Azure DevOps", "Azure Artifacts"): a project whose name is a
  //     common word or brand token would otherwise collide with the brand mentioned
  //     in doc comments. The value used as a real path/config segment never lives
  //     inside that phrase, so removing the brand removes false positives without
  //     hiding real hardcoding.
  await g.assert("R.3 configured org/project/ids do not appear in source", () => {
    const cfg = loadConfig();
    const raw = [cfg.org, cfg.project, cfg.test.repoId, cfg.test.feedId, cfg.test.workItemId != null ? String(cfg.test.workItemId) : null, cfg.test.prId != null ? String(cfg.test.prId) : null];
    const needles = raw.filter((x): x is string => !!x && x.length > 2);
    if (needles.length === 0) return "no live org/project/ids configured — vacuously clean";
    const offenders: string[] = [];
    for (const f of files) {
      const src = fs.readFileSync(f, "utf8").replace(/Azure DevOps/g, "").replace(/Azure Artifacts/g, "");
      for (const n of needles) if (src.includes(n)) offenders.push(`${path.relative(SRC_DIR, f)} contains '${n}'`);
    }
    assert(offenders.length === 0, offenders.join("; "));
    return `checked ${needles.join(", ")} across ${files.length} files`;
  });
}
