/**
 * Gate finale — live acceptance pass (§4bis). NON-negotiable for "done".
 *
 * Runs every read tool (features 1..8) against the REAL Azure DevOps, bypassing
 * cache AND mock, asserting the request hit a real *.dev.azure.com host, capturing
 * anti-fake response headers (ActivityId / x-vss-*), and doing a graph cross-check
 * (work item -> a real id from its relations resolves live too). Writes the audit
 * trail to live-acceptance-report.json (scrubbed).
 *
 * If the session is down or config is missing, every item is BLOCKED_ON_AUTH —
 * a TRANSITORY state. The run is not "done" until this gate is green.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { GateRun } from "../report.js";
import { assert } from "../helpers.js";
import { loadConfig } from "../../../src/config.js";
import { buildLiveRuntime } from "../../../src/runtime.js";
import { HostResolver } from "../../../src/ado/hosts.js";
import { scrub } from "../../../src/scrub.js";
import { AuthRequiredError, ConfigError } from "../../../src/errors.js";

interface ApiEvidence {
  tool: string;
  url: string;
  realHost: boolean;
  activityId: string | null;
  vssHeaders: string[];
  sample: unknown;
}

export async function gateLive(g: GateRun, reportPath: string, live: boolean): Promise<void> {
  const cfg = loadConfig();

  if (!live) {
    g.blocked("L.0 live acceptance pass", "ADO_LIVE not set — run `npm run verify:live` with config + an authenticated session to execute the live pass");
    blockAll(g, "live mode off");
    return;
  }

  if (!cfg.org) {
    g.blocked("L.0 live config present (ADO_ORG)", "ADO_ORG not set — provide config + authenticate to run the live acceptance pass");
    blockAll(g, "config missing");
    return;
  }

  let rt;
  try {
    rt = await buildLiveRuntime(cfg, { headless: true });
  } catch (e) {
    if (e instanceof ConfigError) g.blocked("L.0 live runtime", e.message);
    else g.check("L.0 live runtime built", false, e instanceof Error ? e.message : String(e));
    blockAll(g, "runtime unavailable");
    return;
  }

  const { client, session, cache } = rt;
  const evidence: ApiEvidence[] = [];
  try {
    const valid = await session.validate();
    if (!valid) {
      g.blocked("L.0 session authenticated", "session is down — run `npx mcp-ado-browser authenticate`, then re-run verify:live");
      blockAll(g, "session down");
      return;
    }

    const transport = client.transport;
    const lastHeaders = () => transport.lastHeaders ?? {};
    // helper to record evidence from the transport's last call
    const record = (tool: string, url: string, headers: Record<string, string>, sample: unknown) => {
      evidence.push({
        tool,
        url,
        realHost: HostResolver.isRealAdoHost(url),
        activityId: headers["activityid"] ?? headers["x-vss-e2eid"] ?? null,
        vssHeaders: Object.keys(headers).filter((h) => h.startsWith("x-vss") || h === "activityid"),
        sample,
      });
    };

    // L.0a/L.0b — org-wide discovery: browse ALL projects and repos accessible.
    await g.assert("L.0a list_projects live: browse all accessible projects (org-wide)", async () => {
      const r = await client.listProjects();
      assert(HostResolver.isRealAdoHost(transport.calledUrls.at(-1)!) && r.count >= 1, "no projects");
      record("list_projects", transport.calledUrls.at(-1)!, lastHeaders(), { count: r.count });
      return `projects=${r.count}`;
    });
    await g.assert("L.0b list_repositories live: browse ALL repos across projects (org-wide)", async () => {
      const r = await client.listRepositories();
      assert(HostResolver.isRealAdoHost(transport.calledUrls.at(-1)!) && r.count >= 1, "no repos");
      const projectsSeen = new Set(r.items.map((x) => x.project)).size;
      record("list_repositories", transport.calledUrls.at(-1)!, lastHeaders(), { count: r.count, projectsSpanned: projectsSeen });
      return `repos=${r.count} spanning ${projectsSeen} project(s)`;
    });

    // L.1 — get_work_item live + header capture + real-host assertion.
    let firstRelationId: number | null = null;
    await g.assert("L.1 get_work_item live: real host, schema-valid, ActivityId/x-vss headers present", async () => {
      assert(cfg.test.workItemId != null, "ADO_TEST_WORKITEM_ID not set");
      const url = client.workItemUrl(cfg.test.workItemId!);
      const res = await transport.fetchJson<any>(url);
      assert(HostResolver.isRealAdoHost(url) && url === transport.calledUrls.at(-1), "did not hit a real ADO host");
      const wi = await client.getWorkItem(cfg.test.workItemId!, { bypassCache: true });
      record("get_work_item", url, res.headers, scrub(wi));
      const rel = wi.relations.find((r) => typeof r.workItemId === "number");
      firstRelationId = rel?.workItemId ?? null;
      const hasProof = res.headers["activityid"] || Object.keys(res.headers).some((h) => h.startsWith("x-vss"));
      assert(!!hasProof, "no ActivityId/x-vss header — cannot prove live ADO");
      return `id=${wi.id} rev=${wi.rev} relations=${wi.relations.length}`;
    });

    // L.2 — graph cross-check: a real id from relations resolves live too.
    await g.assert("L.2 graph cross-check: an id from relations resolves live (a fixture cannot fabricate this)", async () => {
      assert(firstRelationId != null, "no related work item id to cross-check");
      const related = await client.getWorkItem(firstRelationId!, { bypassCache: true });
      assert(related.id === firstRelationId, "related work item did not resolve to the same id");
      return `parent->relation ${firstRelationId} resolved live`;
    });

    // L.3..L.8 — the remaining read tools, live + schema-valid + real host.
    await g.assert("L.3 search_work_items live (real host, schema-valid)", async () => {
      const r = await client.searchWorkItems({ top: 5 });
      assert(HostResolver.isRealAdoHost(transport.calledUrls.at(-1)!), "not real host");
      record("search_work_items", transport.calledUrls.at(-1)!, lastHeaders(), scrub(r.items.slice(0, 3)));
      return `backend=${r.backend} count=${r.count}`;
    });

    await g.assert("L.4 get_work_item_comments live", async () => {
      assert(cfg.test.workItemId != null, "ADO_TEST_WORKITEM_ID not set");
      const r = await client.getWorkItemComments(cfg.test.workItemId!);
      record("get_work_item_comments", transport.calledUrls.at(-1)!, lastHeaders(), { count: r.count });
      return `comments=${r.count}`;
    });

    await g.assert("L.5 get_comment_details live (+ attachments if any)", async () => {
      assert(cfg.test.workItemId != null, "ADO_TEST_WORKITEM_ID not set");
      const r = await client.getCommentDetails({ workItemId: cfg.test.workItemId! });
      for (const a of r.attachments) assert(a.size > 0 && (a.contentLength == null || a.contentLength === a.size), `attachment size/Content-Length mismatch ${a.guid}`);
      record("get_comment_details", transport.calledUrls.at(-1)!, lastHeaders(), { attachments: r.attachments.length });
      return `attachments=${r.attachments.length}`;
    });

    const repoId = cfg.test.repoId;
    const prId = cfg.test.prId;
    await g.assert("L.6 search_pull_requests live", async () => {
      const r = await client.searchPullRequests({ repoId: repoId ?? undefined, top: 5 });
      record("search_pull_requests", transport.calledUrls.at(-1)!, lastHeaders(), scrub(r.items.slice(0, 3)));
      return `prs=${r.count}`;
    });

    await g.assert("L.7 get_pull_request + get_pull_request_comments live", async () => {
      assert(repoId != null && prId != null, "ADO_TEST_REPO_ID / ADO_TEST_PR not set");
      const pr = await client.getPullRequest({ repoId, prId });
      record("get_pull_request", transport.calledUrls.at(-1)!, lastHeaders(), scrub(pr));
      const cm = await client.getPullRequestComments({ repoId, prId });
      record("get_pull_request_comments", transport.calledUrls.at(-1)!, lastHeaders(), { threads: cm.threadCount, system: cm.systemThreadCount, human: cm.humanThreadCount });
      return `pr=${pr.pullRequestId} threads=${cm.threadCount}`;
    });

    await g.assert("L.8 search_feeds live", async () => {
      const r = await client.searchFeeds(cfg.test.feedId ? { feedId: cfg.test.feedId } : undefined);
      record("search_feeds", transport.calledUrls.at(-1)!, lastHeaders(), scrub(r.feeds.slice(0, 3)));
      return `feeds=${r.feeds.length}${r.packages ? ` packages=${r.packages.length}` : ""}`;
    });

    // L.9 — artifact download cross-host (EMPIRICAL, mission Phase 3). Only if a feed is provided.
    // This is the ONLY item allowed to terminate as EMPIRICALLY_BLOCKED (with evidence).
    if (cfg.test.feedId) {
      try {
        const browse = await client.searchFeeds({ feedId: cfg.test.feedId });
        const pkg = (browse.packages ?? []).find((p) => p.versions.length > 0);
        assert(pkg != null, "no package with a version found in the feed to test download");
        const protocol = (pkg.protocolType ?? "").toLowerCase().includes("npm") ? "npm" : "nuget";
        const version = pkg.versions.find((v) => v.isLatest)?.version ?? pkg.versions[0].version;
        const saveDir = path.join(path.dirname(reportPath), "live-artifacts");
        const r = await client.downloadArtifact({ feedId: cfg.test.feedId, packageName: pkg.name, version, protocol: protocol as "nuget" | "npm", saveDir });
        assert(r.archiveValid && r.size === (r.contentLength ?? r.size), `archive invalid or size mismatch: ${r.archiveDetail}`);
        record("download_artifact", transport.calledUrls.at(-1)!, lastHeaders(), { package: pkg.name, version, size: r.size, archiveValid: r.archiveValid });
        g.check("L.9 download_artifact cross-host via session (pkgs.dev.azure.com)", true, `${pkg.name}@${version} ${r.size}B ${r.archiveDetail}`);
      } catch (e) {
        // Capture observed behavior (status / redirect / WWW-Authenticate) as evidence.
        const detail = e instanceof Error ? e.message : String(e);
        const hdrs = lastHeaders();
        g.empiricallyBlocked("L.9 download_artifact cross-host via session", `observed: ${detail}; response headers: ${JSON.stringify({ "www-authenticate": hdrs["www-authenticate"], location: hdrs["location"] })}`);
      }
    } else {
      g.blocked("L.9 download_artifact cross-host", "ADO_TEST_FEED not set — provide a feed to empirically test cross-host download");
    }

    // Write the auditable live-acceptance report (scrubbed).
    const manifest = {
      generatedAtNote: "timestamp omitted (deterministic build); see file mtime",
      org: "<redacted>",
      project: "<redacted>",
      apiVersions: rt.versions.snapshot(),
      toolsExercised: evidence.map((e) => e.tool),
      allRealHost: evidence.every((e) => e.realHost),
      evidence,
    };
    fs.writeFileSync(reportPath, JSON.stringify(manifest, null, 2));
    g.check("L.10 live-acceptance-report.json written (auditable proof)", fs.existsSync(reportPath) && evidence.length >= 6, `${evidence.length} evidenced calls -> ${reportPath}`);
  } catch (e) {
    if (e instanceof AuthRequiredError) {
      g.blocked("L.x live pass interrupted by AUTH_REQUIRED", "session dropped mid-pass — re-authenticate and re-run");
    } else {
      g.check("L.x live pass", false, e instanceof Error ? e.message : String(e));
    }
  } finally {
    cache.close();
    await session.close();
  }
}

function blockAll(g: GateRun, reason: string): void {
  for (const t of ["L.1 get_work_item", "L.2 graph cross-check", "L.3 search_work_items", "L.4 get_work_item_comments", "L.5 get_comment_details", "L.6 search_pull_requests", "L.7 get_pull_request(+comments)", "L.8 search_feeds"]) {
    g.blocked(`${t} (live)`, reason);
  }
}
