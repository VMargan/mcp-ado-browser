/**
 * Browser-stack gate — proves the restricted-env requirements (mission §2/§7):
 *  - we depend on playwright-core (no bundled browsers, no postinstall download),
 *  - launching uses channel:'chrome' (an already-installed browser),
 *  - NO Playwright browser download is triggered (the ms-playwright cache is
 *    unchanged across a launch),
 *  - the page can run JS via evaluate (the data-access mechanism).
 *
 * Needs a real Chrome (installed); it does NOT need an ADO session, so it is an
 * offline gate. If Chrome cannot launch in this environment, that is a real FAIL.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { GateRun } from "../report.js";
import { assert } from "../helpers.js";
import { BrowserSession } from "../../../src/browser/session.js";

const PKG = path.join(process.cwd(), "package.json");
const PW_CACHE = path.join(os.homedir(), "Library", "Caches", "ms-playwright");

function listCache(): string[] {
  try {
    return fs.readdirSync(PW_CACHE).sort();
  } catch {
    return [];
  }
}

export async function gateBrowser(g: GateRun): Promise<void> {
  // B.1 — dependency hygiene: playwright-core present, full playwright absent.
  g.check(
    "B.1 depends on playwright-core (no bundled-browser download path)",
    (() => {
      const pkg = JSON.parse(fs.readFileSync(PKG, "utf8"));
      const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
      const hasCore = "playwright-core" in deps;
      const hasFull = "playwright" in deps || "@playwright/test" in deps;
      return hasCore && !hasFull;
    })(),
    "playwright-core only",
  );

  // B.2 — launch via channel:'chrome' on an isolated temp profile, no download, evaluate works.
  await g.assert("B.2 launches channel:'chrome' on isolated profile, triggers NO browser download, evaluate works", async () => {
    const before = listCache();
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ado-verify-profile-"));
    const channel = (process.env.ADO_BROWSER_CHANNEL as "chrome" | "msedge") || "chrome";
    const session = new BrowserSession({ userDataDir, channel, org: "contoso" });
    try {
      await session.ensureLaunched(true); // headless
      const val = await session.currentPage().evaluate(() => 6 * 7);
      assert(val === 42, "page.evaluate did not run JS");
    } finally {
      await session.close();
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    }
    const after = listCache();
    assert(JSON.stringify(before) === JSON.stringify(after), `Playwright browser cache changed (a download was triggered): before=${before.length} after=${after.length} entries`);
    return `channel=${channel}, evaluate=42, ms-playwright cache unchanged (${after.length} entries)`;
  });
}
