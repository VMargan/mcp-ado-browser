/** Gate 3 — artifact download pipeline + archive integrity (offline). Live cross-host is in gateLive. */
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";
import { GateRun } from "../report.js";
import { assert, makeClient } from "../helpers.js";
import { startMock, IDS } from "../../mock-fixtures.js";
import { validateArchive } from "../../../src/ado/archive.js";

export async function gate3(g: GateRun): Promise<void> {
  const { server, baseUrl } = await startMock();
  const saveDir = path.join(os.tmpdir(), `ado-verify-artifacts-${process.pid}`);
  try {
    // 3.1 — .nupkg download: valid zip with .nuspec, size==Content-Length, stable sha256.
    await g.assert("3.1 nuget .nupkg downloads, size==Content-Length, valid zip w/ .nuspec, stable sha256", async () => {
      const r1 = await makeClient({ mockBaseUrl: baseUrl }).downloadArtifact({ feedId: IDS.feedGuid, packageName: "Contoso.Core", version: "1.1.0", protocol: "nuget", saveDir });
      assert(r1.archiveValid, `nupkg invalid: ${r1.archiveDetail}`);
      assert(r1.size === r1.contentLength, `size ${r1.size} != Content-Length ${r1.contentLength}`);
      assert(r1.archiveDetail.includes(".nuspec"), "archive detail does not confirm .nuspec");
      assert(fs.existsSync(r1.savedPath) && fs.statSync(r1.savedPath).size === r1.size, "saved file size mismatch");
      const r2 = await makeClient({ mockBaseUrl: baseUrl }).downloadArtifact({ feedId: IDS.feedGuid, packageName: "Contoso.Core", version: "1.1.0", protocol: "nuget", saveDir });
      assert(r1.sha256 === r2.sha256, "sha256 unstable across downloads");
      return `size=${r1.size} sha256=${r1.sha256.slice(0, 12)}…`;
    });

    // 3.2 — .tgz download: valid gzip tar with package.json.
    await g.assert("3.2 npm .tgz downloads, valid gzip+tar containing package.json", async () => {
      const r = await makeClient({ mockBaseUrl: baseUrl }).downloadArtifact({ feedId: IDS.feedGuid, packageName: "contoso-ui", version: "2.0.0", protocol: "npm", saveDir });
      assert(r.archiveValid, `tgz invalid: ${r.archiveDetail}`);
      assert(r.size === r.contentLength, "size != Content-Length");
      assert(r.archiveDetail.includes("package.json"), "archive detail does not confirm package.json");
      return `size=${r.size} ${r.archiveDetail}`;
    });

    // 3.3 — validator rejects corrupt archives (no false positives).
    await g.assert("3.3 archive validator rejects corrupt data", () => {
      const bad = Buffer.from("this is not an archive at all", "utf8");
      assert(!validateArchive("nuget", bad).valid, "garbage accepted as nupkg");
      assert(!validateArchive("npm", bad).valid, "garbage accepted as tgz");
      return "corrupt input correctly rejected";
    });
  } finally {
    try {
      fs.rmSync(saveDir, { recursive: true, force: true });
    } catch {}
    await server.stop();
  }
}
