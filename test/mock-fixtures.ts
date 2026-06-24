/**
 * Fixture data + a configured MockAdoServer for offline, deterministic gates.
 *
 * Routes are matched by real host + a pathname regex that ignores the org/project
 * prefix (those are configurable, never asserted). Dynamic handlers (workitemsbatch
 * freshness, auth toggling) let cache and auth gates mutate state between calls.
 *
 * Also builds genuinely valid .nupkg (STORED zip w/ .nuspec) and .tgz (gzip tar w/
 * package.json) buffers so the Phase 3 archive-integrity gate runs offline.
 */
import * as zlib from "node:zlib";
import * as fs from "node:fs";
import * as path from "node:path";
import { MockAdoServer } from "../src/mock/mock-ado-server.js";
import { scrub } from "../src/scrub.js";

export const IDS = {
  projectGuid: "11111111-1111-1111-1111-111111111111",
  repoGuid: "22222222-2222-2222-2222-222222222222",
  feedGuid: "33333333-3333-3333-3333-333333333333",
  att1: "aaaaaaaa-1111-2222-3333-444444444444", // spec.txt via relation
  att2: "bbbbbbbb-5555-6666-7777-888888888888", // log.txt via comment body
  prId: 42,
};

export const ATTACHMENT_CONTENT: Record<string, Buffer> = {
  [IDS.att1]: Buffer.from("SPEC FILE CONTENT v1\nline2\nline3\n", "utf8"),
  [IDS.att2]: Buffer.from("LOG: build started\nLOG: build ok\n", "utf8"),
};

const CORE = "dev.azure.com";
const FEEDS = "feeds.dev.azure.com";
const PKGS = "pkgs.dev.azure.com";
const SEARCH = "almsearch.dev.azure.com";

/** Mutable work-item revs so the freshness gate can bump them. */
export const revState: Record<number, number> = { 101: 3, 102: 1, 103: 1 };

export function workItem101() {
  return {
    id: 101,
    rev: revState[101],
    url: `https://${CORE}/contoso/_apis/wit/workItems/101`,
    fields: {
      "System.Id": 101,
      "System.Title": "Login button misaligned on mobile",
      "System.State": "Active",
      "System.WorkItemType": "Bug",
      "System.TeamProject": "demo",
      "System.Rev": revState[101],
      "System.ChangedDate": "2026-06-20T10:00:00Z",
      "System.AssignedTo": { displayName: "Jane Doe", uniqueName: "jane.doe@contoso.com" },
    },
    relations: [
      { rel: "System.LinkTypes.Hierarchy-Forward", url: `https://${CORE}/contoso/_apis/wit/workItems/102`, attributes: { name: "Child" } },
      { rel: "System.LinkTypes.Related", url: `https://${CORE}/contoso/_apis/wit/workItems/103`, attributes: { name: "Related" } },
      { rel: "ArtifactLink", url: `vstfs:///Git/PullRequestId/${IDS.projectGuid}%2F${IDS.repoGuid}%2F${IDS.prId}`, attributes: { name: "Pull Request" } },
      { rel: "AttachedFile", url: `https://${CORE}/contoso/_apis/wit/attachments/${IDS.att1}?fileName=spec.txt`, attributes: { name: "spec.txt", resourceSize: ATTACHMENT_CONTENT[IDS.att1].length } },
    ],
  };
}

export function workItem102() {
  return {
    id: 102,
    rev: revState[102],
    url: `https://${CORE}/contoso/_apis/wit/workItems/102`,
    fields: {
      "System.Id": 102,
      "System.Title": "Mobile layout regression",
      "System.State": "Closed",
      "System.WorkItemType": "Task",
      "System.TeamProject": "demo",
      "System.Rev": revState[102],
      "System.ChangedDate": "2026-06-19T08:00:00Z",
    },
    relations: [{ rel: "System.LinkTypes.Hierarchy-Reverse", url: `https://${CORE}/contoso/_apis/wit/workItems/101`, attributes: { name: "Parent" } }],
  };
}

function workItem103() {
  return {
    id: 103,
    rev: revState[103],
    url: `https://${CORE}/contoso/_apis/wit/workItems/103`,
    fields: { "System.Id": 103, "System.Title": "Related styling cleanup", "System.State": "New", "System.WorkItemType": "Task", "System.TeamProject": "demo", "System.Rev": revState[103] },
    relations: [],
  };
}

const WORK_ITEMS: Record<number, () => any> = { 101: workItem101, 102: workItem102, 103: workItem103 };

export function comments101() {
  return {
    totalCount: 2,
    count: 2,
    comments: [
      { id: 1, text: "Reproduced on iPhone 14.", createdBy: { displayName: "Jane Doe", uniqueName: "jane.doe@contoso.com" }, createdDate: "2026-06-20T11:00:00Z" },
      {
        id: 2,
        text: `Attaching the log: <a href="https://${CORE}/contoso/_apis/wit/attachments/${IDS.att2}?fileName=log.txt">log.txt</a>`,
        createdBy: { displayName: "John Smith", uniqueName: "john.smith@contoso.com" },
        createdDate: "2026-06-20T12:00:00Z",
      },
    ],
  };
}

function pullRequest42() {
  return {
    pullRequestId: 42,
    title: "Fix login button alignment",
    description: "Resolves the mobile misalignment.",
    status: "active",
    createdBy: { displayName: "Jane Doe", uniqueName: "jane.doe@contoso.com" },
    sourceRefName: "refs/heads/fix/login-align",
    targetRefName: "refs/heads/main",
    repository: { id: IDS.repoGuid, name: "web-app" },
    reviewers: [{ id: "rev-1", displayName: "John Smith", vote: 10 }],
  };
}

function prThreads() {
  return {
    value: [
      // System thread: status change, no human commentType
      { id: 900, status: "active", comments: [{ id: 1, content: "Jane Doe voted Approved", author: { displayName: "Azure DevOps" }, commentType: "system", publishedDate: "2026-06-21T09:00:00Z" }] },
      // Human thread
      {
        id: 901,
        status: "active",
        comments: [
          { id: 1, content: "Please add a unit test.", author: { displayName: "John Smith", uniqueName: "john.smith@contoso.com" }, commentType: "text", publishedDate: "2026-06-21T10:00:00Z" },
          { id: 2, content: "Done.", author: { displayName: "Jane Doe", uniqueName: "jane.doe@contoso.com" }, commentType: "text", publishedDate: "2026-06-21T11:00:00Z" },
        ],
      },
    ],
  };
}

function feeds() {
  return { count: 1, value: [{ id: IDS.feedGuid, name: "demo-feed", url: `https://${FEEDS}/contoso/_apis/packaging/feeds/${IDS.feedGuid}` }] };
}

function feedPackages() {
  return {
    count: 2,
    value: [
      { id: "pkg-nuget-1", name: "Contoso.Core", protocolType: "NuGet", versions: [{ id: "v1", version: "1.0.0", isLatest: false }, { id: "v2", version: "1.1.0", isLatest: true }] },
      { id: "pkg-npm-1", name: "contoso-ui", protocolType: "Npm", versions: [{ id: "v1", version: "2.0.0", isLatest: true }] },
    ],
  };
}

export const NUPKG = makeNupkg();
export const TGZ = makeTgz();

/**
 * Write the fixture corpus to disk (the `fixtures/` deliverable), SCRUBBED of any
 * personal identifiers — demonstrating the deterministic anonymization pass that
 * the auto-capture flow applies to real responses while the session is hot.
 */
export function dumpFixtures(dir: string): string[] {
  fs.mkdirSync(dir, { recursive: true });
  const files: Array<[string, unknown]> = [
    ["connectionData.json", { authenticatedUser: { id: "user-guid-1", providerDisplayName: "Jane Doe", subjectDescriptor: "aad.abc" } }],
    ["workitem-101.json", workItem101()],
    ["workitem-102.json", workItem102()],
    ["workitem-comments-101.json", comments101()],
    ["pullrequest-42.json", { value: [pullRequest42()] }],
    ["pullrequest-42-threads.json", prThreads()],
    ["feeds.json", feeds()],
    ["feed-packages.json", feedPackages()],
    ["wiql.json", { workItems: [{ id: 101 }, { id: 102 }, { id: 103 }] }],
  ];
  const written: string[] = [];
  for (const [name, data] of files) {
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(scrub(data), null, 2));
    written.push(name);
  }
  // binary attachment fixtures (not scrubbed — opaque bytes)
  for (const [guid, buf] of Object.entries(ATTACHMENT_CONTENT)) {
    const p = path.join(dir, `attachment-${guid}.bin`);
    fs.writeFileSync(p, buf);
    written.push(path.basename(p));
  }
  fs.writeFileSync(path.join(dir, "package.nupkg"), NUPKG);
  fs.writeFileSync(path.join(dir, "package.tgz"), TGZ);
  written.push("package.nupkg", "package.tgz");
  return written;
}

export interface ConfiguredMock {
  server: MockAdoServer;
  baseUrl: string;
}

export async function startMock(): Promise<ConfiguredMock> {
  const server = new MockAdoServer();
  configureRoutes(server);
  const baseUrl = await server.start();
  return { server, baseUrl };
}

export function projects() {
  return {
    count: 2,
    value: [
      { id: "proj-1", name: "demo", state: "wellFormed", description: "Demo project", lastUpdateTime: "2026-06-01T00:00:00Z" },
      { id: "proj-2", name: "platform", state: "wellFormed", description: null, lastUpdateTime: "2026-05-01T00:00:00Z" },
    ],
  };
}

export function repositories() {
  return {
    count: 2,
    value: [
      { id: IDS.repoGuid, name: "web-app", project: { id: "proj-1", name: "demo" }, defaultBranch: "refs/heads/main", webUrl: "https://dev.azure.com/contoso/demo/_git/web-app", isDisabled: false },
      { id: "44444444-4444-4444-4444-444444444444", name: "api", project: { id: "proj-2", name: "platform" }, defaultBranch: "refs/heads/main", webUrl: "https://dev.azure.com/contoso/platform/_git/api", isDisabled: false },
    ],
  };
}

export function configureRoutes(server: MockAdoServer): void {
  // org-level discovery
  server.on("GET", CORE, /\/_apis\/projects$/i, () => ({ json: projects() }));
  server.on("GET", CORE, /\/_apis\/git\/repositories$/i, () => ({ json: repositories() }));

  // connectionData (authenticated identity)
  server.on("GET", CORE, /\/_apis\/connectionData$/, () => ({
    json: { authenticatedUser: { id: "user-guid-1", providerDisplayName: "Jane Doe", subjectDescriptor: "aad.abc", properties: {} }, instanceId: "inst-1" },
  }));

  // single work item (full)
  server.on("GET", CORE, /\/_apis\/wit\/workitems\/(\d+)$/i, (req) => {
    const id = Number(/workitems\/(\d+)/i.exec(req.pathname)![1]);
    const f = WORK_ITEMS[id];
    if (!f) return { status: 404, json: { message: `work item ${id} not found` } };
    return { json: f() };
  });

  // workItems/{id}/comments (separate endpoint)
  server.on("GET", CORE, /\/_apis\/wit\/workItems\/101\/comments$/i, () => ({ json: comments101() }));
  server.on("GET", CORE, /\/_apis\/wit\/workItems\/(\d+)\/comments$/i, (req) => {
    const id = Number(/workItems\/(\d+)\/comments/i.exec(req.pathname)![1]);
    if (!WORK_ITEMS[id]) return { status: 404, json: { message: "not found" } };
    return { json: { totalCount: 0, count: 0, comments: [] } };
  });

  // workitemsbatch: serves BOTH freshness (System.Rev) and summary (System.Title) shapes
  server.on("POST", CORE, /\/_apis\/wit\/workitemsbatch$/i, (req) => {
    const body = JSON.parse(req.body || "{}");
    const ids: number[] = body.ids ?? [];
    const fields: string[] = body.fields ?? [];
    const value = ids
      .filter((id) => WORK_ITEMS[id])
      .map((id) => {
        const wi = WORK_ITEMS[id]();
        const out: Record<string, unknown> = {};
        for (const fld of fields) if (fld in wi.fields) out[fld] = wi.fields[fld];
        return { id, rev: wi.rev, fields: out };
      });
    return { json: { count: value.length, value } };
  });

  // wiql
  server.on("POST", CORE, /\/_apis\/wit\/wiql$/i, () => ({ json: { workItems: [{ id: 101 }, { id: 102 }, { id: 103 }] } }));

  // almsearch full-text
  server.on("POST", SEARCH, /\/_apis\/search\/workitemsearchresults$/i, () => ({
    json: { count: 1, results: [{ fields: { "system.id": "101", "system.title": "Login button misaligned on mobile", "system.state": "Active", "system.workitemtype": "Bug" } }] },
  }));

  // attachments download (binary)
  server.on("GET", CORE, /\/_apis\/wit\/attachments\/([0-9a-fA-F-]{36})/i, (req) => {
    const guid = /attachments\/([0-9a-fA-F-]{36})/i.exec(req.pathname)![1];
    const buf = ATTACHMENT_CONTENT[guid];
    if (!buf) return { status: 404, json: { message: "attachment not found" } };
    return { buffer: buf, headers: { "content-type": "application/octet-stream" } };
  });

  // pull requests search (project-level and repo-level)
  server.on("GET", CORE, /\/_apis\/git\/pullrequests$/i, () => ({ json: { count: 1, value: [pullRequest42()] } }));
  server.on("GET", CORE, /\/_apis\/git\/repositories\/[^/]+\/pullrequests$/i, () => ({ json: { count: 1, value: [pullRequest42()] } }));

  // single PR + linked work items + threads
  server.on("GET", CORE, /\/_apis\/git\/repositories\/[^/]+\/pullRequests\/(\d+)$/i, (req) => {
    const id = Number(/pullRequests\/(\d+)/i.exec(req.pathname)![1]);
    if (id !== IDS.prId) return { status: 404, json: { message: "pr not found" } };
    return { json: pullRequest42() };
  });
  server.on("GET", CORE, /\/_apis\/git\/repositories\/[^/]+\/pullRequests\/\d+\/workitems$/i, () => ({ json: { count: 1, value: [{ id: "101", url: `https://${CORE}/contoso/_apis/wit/workItems/101` }] } }));
  server.on("GET", CORE, /\/_apis\/git\/repositories\/[^/]+\/pullRequests\/\d+\/threads$/i, () => ({ json: prThreads() }));

  // feeds + packages
  server.on("GET", FEEDS, /\/_apis\/packaging\/feeds$/i, () => ({ json: feeds() }));
  server.on("GET", FEEDS, /\/_apis\/packaging\/feeds\/[^/]+\/packages$/i, () => ({ json: feedPackages() }));

  // artifact downloads (pkgs host)
  server.on("GET", PKGS, /\/_apis\/packaging\/feeds\/[^/]+\/nuget\/packages\/[^/]+\/versions\/[^/]+\/content$/i, () => ({ buffer: NUPKG, headers: { "content-type": "application/octet-stream" } }));
  server.on("GET", PKGS, /\/_packaging\/[^/]+\/npm\/.+\.tgz$/i, () => ({ buffer: TGZ, headers: { "content-type": "application/octet-stream" } }));
}

// ---- archive builders (genuinely valid STORED zip / gzip tar) ---------------

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}

function makeNupkg(): Buffer {
  const name = "demo.nuspec";
  const data = Buffer.from(`<?xml version="1.0"?><package><metadata><id>Contoso.Core</id><version>1.1.0</version></metadata></package>`, "utf8");
  const nameBuf = Buffer.from(name, "utf8");
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); // local file header sig
  local.writeUInt16LE(20, 4); // version needed
  local.writeUInt16LE(0, 6); // flags
  local.writeUInt16LE(0, 8); // method 0 = stored
  local.writeUInt16LE(0, 10); // time
  local.writeUInt16LE(0, 12); // date
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18); // compressed size
  local.writeUInt32LE(data.length, 22); // uncompressed size
  local.writeUInt16LE(nameBuf.length, 26);
  local.writeUInt16LE(0, 28); // extra len
  const localRec = Buffer.concat([local, nameBuf, data]);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // central dir sig
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0, 8);
  central.writeUInt16LE(0, 10);
  central.writeUInt16LE(0, 12);
  central.writeUInt16LE(0, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt16LE(0, 30);
  central.writeUInt16LE(0, 32);
  central.writeUInt16LE(0, 34);
  central.writeUInt16LE(0, 36);
  central.writeUInt32LE(0, 38);
  central.writeUInt32LE(0, 42); // local header offset
  const centralRec = Buffer.concat([central, nameBuf]);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); // end of central dir sig
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralRec.length, 12);
  end.writeUInt32LE(localRec.length, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([localRec, centralRec, end]);
}

function makeTgz(): Buffer {
  const name = "package/package.json";
  const data = Buffer.from(JSON.stringify({ name: "contoso-ui", version: "2.0.0" }, null, 2), "utf8");
  const header = Buffer.alloc(512);
  header.write(name, 0, "utf8");
  header.write("0000644", 100, "ascii"); // mode
  header.write("0000000", 108, "ascii"); // uid
  header.write("0000000", 116, "ascii"); // gid
  header.write(data.length.toString(8).padStart(11, "0"), 124, "ascii"); // size octal
  header.write("00000000000", 136, "ascii"); // mtime
  header.write("        ", 148, "ascii"); // checksum placeholder (spaces)
  header.write("0", 156, "ascii"); // typeflag normal file
  header.write("ustar\0", 257, "ascii");
  header.write("00", 263, "ascii");
  // checksum = sum of all header bytes with checksum field as spaces
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += header[i];
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");

  const dataPadded = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(dataPadded);
  const trailer = Buffer.alloc(1024); // two zero blocks
  const tar = Buffer.concat([header, dataPadded, trailer]);
  return zlib.gzipSync(tar);
}
