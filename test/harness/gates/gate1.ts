/** Gate 1 — all read tools (features 1..8) against fixtures, with §5 specifics. */
import * as os from "node:os";
import * as path from "node:path";
import { GateRun } from "../report.js";
import { assert, makeClient } from "../helpers.js";
import { startMock, IDS } from "../../mock-fixtures.js";
import { AuthRequiredError, NotFoundError } from "../../../src/errors.js";

export async function gate1(g: GateRun): Promise<void> {
  const { server, baseUrl } = await startMock();
  const client = () => makeClient({ mockBaseUrl: baseUrl });
  try {
    // 1 — search_work_items (WIQL backend + almsearch backend)
    await g.assert("1.1 search_work_items (WIQL) returns ids + summary fields, schema-valid", async () => {
      const r = await client().searchWorkItems({ top: 10 });
      assert(r.backend === "wiql" && r.count >= 2, `backend=${r.backend} count=${r.count}`);
      assert(r.items.some((i) => i.id === 101 && i.title === "Login button misaligned on mobile"), "summary fields missing");
      return `wiql count=${r.count}`;
    });
    await g.assert("1.1b search_work_items (almsearch full-text) path works", async () => {
      const r = await client().searchWorkItems({ text: "login", top: 10 });
      assert(r.backend === "almsearch" && r.items[0]?.id === 101, `backend=${r.backend}`);
      return "almsearch ok";
    });

    // 2 — get_work_item relations populated (hierarchy, Related, PR ArtifactLink)
    await g.assert("2.1 get_work_item populates relations: hierarchy + Related + ArtifactLink(PR) + AttachedFile", async () => {
      const wi = await client().getWorkItem(101, { bypassCache: true });
      const rels = wi.relations;
      assert(rels.some((r) => r.rel.includes("Hierarchy-Forward") && r.workItemId === 102), "missing child link");
      assert(rels.some((r) => r.rel.includes("Related") && r.workItemId === 103), "missing related link");
      const pr = rels.find((r) => r.pullRequest);
      assert(pr?.pullRequest?.pullRequestId === IDS.prId && pr.pullRequest.repositoryId === IDS.repoGuid, "PR artifact link not resolved");
      assert(rels.some((r) => r.rel === "AttachedFile"), "missing AttachedFile relation");
      return `relations=${rels.length}, PR=${pr!.pullRequest!.pullRequestId}`;
    });

    // 3 — get_work_item_comments via the SEPARATE comments endpoint
    await g.assert("3.1 get_work_item_comments uses the separate comments endpoint (not $expand)", async () => {
      const c = makeClient({ mockBaseUrl: baseUrl });
      const r = await c.getWorkItemComments(101);
      assert(r.count === 2 && r.comments[0].text.includes("Reproduced"), "comments not returned");
      // assert the dedicated comments URL was actually called
      const calledComments = (c.transport as any).calledUrls.some((u: string) => /\/workItems\/101\/comments/i.test(u));
      assert(calledComments, "did not call the dedicated comments endpoint");
      return `comments=${r.count}`;
    });

    // 4 — get_comment_details downloads attachments; size==Content-Length; stable checksum
    await g.assert("4.1 get_comment_details downloads attachments (size==Content-Length, stable sha256 across runs)", async () => {
      const saveDir = path.join(os.tmpdir(), "ado-verify-att");
      const run1 = await client().getCommentDetails({ workItemId: 101, commentId: 2, saveDir });
      assert(run1.attachments.length >= 2, `expected >=2 attachments (relation + comment-body), got ${run1.attachments.length}`);
      for (const a of run1.attachments) {
        assert(a.size > 0, `attachment ${a.guid} empty`);
        assert(a.contentLength === a.size, `size ${a.size} != Content-Length ${a.contentLength} for ${a.guid}`);
      }
      assert(run1.attachments.some((a) => a.source === "relation"), "no relation-sourced attachment");
      assert(run1.attachments.some((a) => a.source === "comment-body"), "no comment-body-sourced attachment");
      const run2 = await client().getCommentDetails({ workItemId: 101, commentId: 2, saveDir });
      const m1 = Object.fromEntries(run1.attachments.map((a) => [a.guid, a.sha256]));
      const m2 = Object.fromEntries(run2.attachments.map((a) => [a.guid, a.sha256]));
      for (const k of Object.keys(m1)) assert(m1[k] === m2[k], `checksum unstable for ${k}`);
      return `attachments=${run1.attachments.length}, checksums stable`;
    });

    // 5 — search_pull_requests
    await g.assert("5.1 search_pull_requests returns PRs (project + repo scope), schema-valid", async () => {
      const proj = await client().searchPullRequests({ status: "active", top: 10 });
      assert(proj.count === 1 && proj.items[0].pullRequestId === IDS.prId, "project-level PR search failed");
      const repo = await client().searchPullRequests({ repoId: IDS.repoGuid, status: "active" });
      assert(repo.items[0].repositoryId === IDS.repoGuid, "repo-level PR search failed");
      return `prs=${proj.count}`;
    });

    // 6 — get_pull_request with reviewers + linked work items
    await g.assert("6.1 get_pull_request returns metadata, branches, reviewers, linked work items", async () => {
      const pr = await client().getPullRequest({ repoId: IDS.repoGuid, prId: IDS.prId });
      assert(pr.pullRequestId === IDS.prId && pr.targetRefName === "refs/heads/main", "branches missing");
      assert(pr.reviewers.length === 1 && pr.reviewers[0].vote === 10, "reviewers missing");
      assert(pr.workItemRefs.some((w) => w.id === "101"), "linked work items missing");
      return `reviewers=${pr.reviewers.length}, wiRefs=${pr.workItemRefs.length}`;
    });

    // 7 — get_pull_request_comments distinguishes system vs human threads
    await g.assert("7.1 get_pull_request_comments distinguishes system vs human threads", async () => {
      const r = await client().getPullRequestComments({ repoId: IDS.repoGuid, prId: IDS.prId });
      assert(r.threadCount === 2 && r.systemThreadCount === 1 && r.humanThreadCount === 1, `system=${r.systemThreadCount} human=${r.humanThreadCount}`);
      const human = r.threads.find((t) => t.kind === "human");
      assert(human?.comments.length === 2, "human thread comments missing");
      return `system=${r.systemThreadCount} human=${r.humanThreadCount}`;
    });

    // 8 — search_feeds -> feeds + packages + versions
    await g.assert("8.1 search_feeds returns feeds, then packages + versions for a feed", async () => {
      const feeds = await client().searchFeeds();
      assert(feeds.feeds.length === 1 && feeds.feeds[0].id === IDS.feedGuid, "feeds missing");
      const browse = await client().searchFeeds({ feedId: IDS.feedGuid });
      assert((browse.packages?.length ?? 0) === 2, "packages missing");
      const nuget = browse.packages!.find((p) => p.name === "Contoso.Core");
      assert(!!nuget?.versions.some((v) => v.version === "1.1.0" && v.isLatest === true), "versions missing");
      return `feeds=${feeds.feeds.length} packages=${browse.packages!.length}`;
    });

    // 0/9 — org-wide discovery tools
    await g.assert("9.1 list_projects returns all accessible projects (org-level)", async () => {
      const r = await client().listProjects();
      assert(r.count >= 1 && r.items.some((p) => p.name === "demo"), "projects not listed");
      return `projects=${r.count}`;
    });
    await g.assert("9.2 list_repositories returns repos across projects (org-level)", async () => {
      const r = await client().listRepositories();
      assert(r.count >= 2 && r.items.some((x) => x.name === "web-app" && x.project === "demo"), "repos not listed with project");
      return `repos=${r.count}`;
    });
    await g.assert("9.3 PR tools resolve a repository NAME to its id (org-wide)", async () => {
      // pass the repo NAME, not the GUID -> must resolve via list_repositories
      const pr = await client().getPullRequest({ repoId: "web-app", prId: IDS.prId });
      assert(pr.pullRequestId === IDS.prId, "repo name resolution failed");
      return "name 'web-app' -> id resolved";
    });

    // (e) — every tool maps 401 -> AUTH_REQUIRED
    await g.assert("1.x every read tool maps 401 -> AUTH_REQUIRED", async () => {
      server.failAuth = true;
      try {
        const c = client();
        const calls: Array<() => Promise<unknown>> = [
          () => c.searchWorkItems({ top: 1 }),
          () => c.getWorkItem(101, { bypassCache: true }),
          () => c.getWorkItemComments(101),
          () => c.getCommentDetails({ workItemId: 101 }),
          () => c.searchPullRequests({}),
          () => c.getPullRequest({ repoId: IDS.repoGuid, prId: IDS.prId }),
          () => c.getPullRequestComments({ repoId: IDS.repoGuid, prId: IDS.prId }),
          () => c.searchFeeds(),
        ];
        for (const call of calls) {
          let threw: unknown;
          try {
            await call();
          } catch (e) {
            threw = e;
          }
          assert(threw instanceof AuthRequiredError, `a tool did not map 401 -> AUTH_REQUIRED (${threw})`);
        }
        return "8/8 tools -> AUTH_REQUIRED";
      } finally {
        server.failAuth = false;
      }
    });

    // (f) — NOT_FOUND on missing resources
    await g.assert("1.y missing resources -> NOT_FOUND (work item, PR)", async () => {
      const c = client();
      let a: unknown, b: unknown;
      try {
        await c.getWorkItem(99999, { bypassCache: true });
      } catch (e) {
        a = e;
      }
      try {
        await c.getPullRequest({ repoId: IDS.repoGuid, prId: 99999 });
      } catch (e) {
        b = e;
      }
      assert(a instanceof NotFoundError && b instanceof NotFoundError, "missing resource did not map to NOT_FOUND");
      return "NOT_FOUND for WI + PR";
    });
  } finally {
    await server.stop();
  }
}
