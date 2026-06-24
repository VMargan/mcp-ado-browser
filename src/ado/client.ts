/**
 * High-level Azure DevOps read client.
 *
 * - Builds CANONICAL real-host URLs (org/project/api-version all injected, never
 *   hardcoded) and delegates execution to an AdoTransport (browser or mock).
 * - Normalizes raw ADO JSON into the declared zod output shapes (schemas.ts).
 * - Optional cache (Phase 2) plugs in via the `CachePort` interface.
 *
 * Every method here is READ-ONLY.
 */
import * as crypto from "node:crypto";
import { HostResolver } from "./hosts.js";
import { VersionRegistry, withApiVersion } from "./versions.js";
import { AdoTransport } from "../transport/types.js";
import { NotFoundError } from "../errors.js";
import {
  CommentDetails,
  FeedsBrowse,
  ProjectsList,
  PullRequest,
  PullRequestComments,
  PullRequestSearchResult,
  RepositoriesList,
  Relation,
  WorkItem,
  WorkItemComments,
  WorkItemSearchResult,
} from "./schemas.js";
import { CachePort } from "../cache/types.js";

export interface ClientDeps {
  transport: AdoTransport;
  hosts: HostResolver;
  versions: VersionRegistry;
  /** Optional DEFAULT project scope. The client browses org-wide when null. */
  project?: string | null;
  cache?: CachePort | null;
}

export class AdoClient {
  readonly transport: AdoTransport;
  private readonly hosts: HostResolver;
  private readonly versions: VersionRegistry;
  /** Default project scope (optional). Most endpoints work org-wide without it. */
  private readonly defaultProject: string | null;
  private readonly cache: CachePort | null;
  /** Cached org-wide repository list, for name -> id resolution. */
  private repoIndex: Map<string, { id: string; name: string; project: string }> | null = null;

  constructor(deps: ClientDeps) {
    this.transport = deps.transport;
    this.hosts = deps.hosts;
    this.versions = deps.versions;
    this.defaultProject = deps.project ?? null;
    this.cache = deps.cache ?? null;
  }

  // ---- org-wide discovery (browse everything accessible) -------------------

  /** All projects the user can access (org-level). */
  async listProjects(): Promise<ProjectsList> {
    const url = withApiVersion(`${this.hosts.base("core")}/_apis/projects?$top=500`, this.versions.forArea("core"));
    const { data } = await this.transport.fetchJson<any>(url);
    const items = (data?.value ?? []).map((p: any) => ({ id: String(p.id), name: str(p.name) ?? String(p.id), state: str(p.state), description: str(p.description), lastUpdateTime: str(p.lastUpdateTime) }));
    return { count: items.length, items };
  }

  /** All repositories the user can access (org-level), optionally filtered to a project. */
  async listRepositories(args?: { project?: string }): Promise<RepositoriesList> {
    const project = args?.project ?? undefined;
    const base = project ? `${this.hosts.base("core")}/${enc(project)}/_apis/git/repositories` : `${this.hosts.base("core")}/_apis/git/repositories`;
    const url = withApiVersion(base, this.versions.forArea("git"));
    const { data } = await this.transport.fetchJson<any>(url);
    const items = (data?.value ?? []).map((r: any) => ({ id: String(r.id), name: str(r.name) ?? String(r.id), project: str(r.project?.name), defaultBranch: str(r.defaultBranch), webUrl: str(r.webUrl ?? r.remoteUrl), isDisabled: typeof r.isDisabled === "boolean" ? r.isDisabled : null }));
    return { count: items.length, items };
  }

  /** Resolve a repository identifier (GUID passes through; a name is looked up org-wide). */
  private async resolveRepoId(repoIdOrName: string): Promise<string> {
    if (/^[0-9a-fA-F-]{36}$/.test(repoIdOrName)) return repoIdOrName;
    if (!this.repoIndex) {
      const list = await this.listRepositories();
      this.repoIndex = new Map();
      for (const r of list.items) this.repoIndex.set(r.name.toLowerCase(), { id: r.id, name: r.name, project: r.project ?? "" });
    }
    const hit = this.repoIndex.get(repoIdOrName.toLowerCase());
    if (!hit) throw new NotFoundError("repository", repoIdOrName);
    return hit.id;
  }

  // ---- discovery -----------------------------------------------------------

  async connectionData(): Promise<any> {
    const url = withApiVersion(`${this.hosts.base("core")}/_apis/connectionData`, this.versions.forArea("core"));
    const { data } = await this.transport.fetchJson<any>(url);
    return data;
  }

  // ---- 1. search_work_items ------------------------------------------------

  async searchWorkItems(args: { wiql?: string; text?: string; top?: number; project?: string }): Promise<WorkItemSearchResult> {
    const top = args.top ?? 50;
    if (args.text && !args.wiql) {
      // Empirical full-text path (may require the Search extension). Falls back to WIQL on failure.
      try {
        return await this.searchWorkItemsAlmSearch(args.text, top);
      } catch {
        /* fall through to wiql */
      }
    }
    // WIQL runs ORG-WIDE (cross-project) by default; scope to a project only when one
    // is given. An unconstrained "all work items" query hits the WIQL hard limit
    // (VS402337: >20000 => HTTP 400), so the default is bounded to the caller's items.
    const project = args.project ?? this.defaultProject ?? undefined;
    const scope = project ? `[System.TeamProject] = @project AND ` : "";
    const wiql = args.wiql ?? `SELECT [System.Id] FROM WorkItems WHERE ${scope}[System.AssignedTo] = @Me ORDER BY [System.ChangedDate] DESC`;
    const base = project ? `${this.hosts.base("core")}/${enc(project)}/_apis/wit/wiql` : `${this.hosts.base("core")}/_apis/wit/wiql`;
    const url = withApiVersion(base, this.versions.forArea("wit"));
    const { data } = await this.transport.fetchJson<any>(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query: wiql }) });
    const refs: Array<{ id: number }> = (data?.workItems ?? []).slice(0, top);
    const ids = refs.map((r) => r.id);
    const items = ids.length ? await this.fetchSummaries(ids) : [];
    return { count: items.length, items, backend: "wiql" };
  }

  private async searchWorkItemsAlmSearch(text: string, top: number): Promise<WorkItemSearchResult> {
    const url = withApiVersion(`${this.hosts.base("search")}/_apis/search/workitemsearchresults`, this.versions.forArea("search"));
    const { data } = await this.transport.fetchJson<any>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ searchText: text, $top: top, $skip: 0 }),
    });
    const results: any[] = data?.results ?? [];
    const items = results.map((r) => {
      const f = r.fields ?? {};
      return {
        id: Number(f["system.id"] ?? f["System.Id"] ?? r.id),
        type: str(f["system.workitemtype"] ?? f["System.WorkItemType"]),
        title: str(f["system.title"] ?? f["System.Title"]),
        state: str(f["system.state"] ?? f["System.State"]),
        fields: f,
      };
    });
    return { count: items.length, items, backend: "almsearch" };
  }

  private async fetchSummaries(ids: number[]): Promise<WorkItemSearchResult["items"]> {
    const fields = ["System.Id", "System.Title", "System.State", "System.WorkItemType"];
    // workitemsbatch works org-wide (no project segment) — confirmed empirically.
    const url = withApiVersion(`${this.hosts.base("core")}/_apis/wit/workitemsbatch`, this.versions.forArea("wit"));
    const { data } = await this.transport.fetchJson<any>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, fields }),
    });
    return (data?.value ?? []).map((w: any) => ({
      id: w.id,
      type: str(w.fields?.["System.WorkItemType"]),
      title: str(w.fields?.["System.Title"]),
      state: str(w.fields?.["System.State"]),
      fields: w.fields,
    }));
  }

  // ---- 2. get_work_item ----------------------------------------------------

  /** Canonical URL for a work item with full expand (so `relations` are present). */
  workItemUrl(id: number): string {
    return withApiVersion(`${this.hosts.base("core")}/_apis/wit/workitems/${id}?$expand=all`, this.versions.forArea("wit"));
  }

  async getWorkItem(id: number, opts?: { bypassCache?: boolean }): Promise<WorkItem> {
    const kind = "workitem";
    const key = String(id);
    // TTL=0 disables caching for this resource: always a full refetch.
    const cachingOn = this.cache && !opts?.bypassCache && this.cache.ttlFor(kind) > 0;
    if (cachingOn) {
      const cached = this.cache!.get<WorkItem>(kind, key);
      if (cached) {
        const age = (Date.now() - cached.validatedAt) / 1000;
        if (age < this.cache!.ttlFor(kind)) return cached.value; // fresh hit: ZERO network
        // Stale: cheap freshness oracle via workitemsbatch (Rev). If unchanged, keep cache.
        const fresh = await this.freshnessByRev([id]);
        const rev = fresh.get(id);
        if (rev !== undefined && String(rev) === cached.version) {
          this.cache!.touch(kind, key); // refresh validation timestamp; NO full fetch
          return cached.value;
        }
      }
    }
    const wi = await this.fetchWorkItemFull(id);
    this.cache?.set(kind, key, wi, String(wi.rev));
    return wi;
  }

  private async fetchWorkItemFull(id: number): Promise<WorkItem> {
    const { data } = await this.transport.fetchJson<any>(this.workItemUrl(id));
    return normalizeWorkItem(data);
  }

  /** Batch freshness oracle: returns id -> current Rev using a single workitemsbatch call. */
  async freshnessByRev(ids: number[]): Promise<Map<number, number>> {
    const url = withApiVersion(`${this.hosts.base("core")}/_apis/wit/workitemsbatch`, this.versions.forArea("wit"));
    const { data } = await this.transport.fetchJson<any>(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ids, fields: ["System.Rev", "System.ChangedDate"] }),
    });
    const out = new Map<number, number>();
    for (const w of data?.value ?? []) out.set(w.id, w.rev);
    return out;
  }

  // ---- 3. get_work_item_comments ------------------------------------------

  /**
   * The comments endpoint is the ONLY work-item route that requires a project
   * segment (empirically: org-level => 404 "controller not found"). We derive the
   * project dynamically from the work item's System.TeamProject — so the caller
   * never has to know or pass it. `project`/`wi` let callers skip the lookup.
   */
  async getWorkItemComments(id: number, ctx?: { project?: string; wi?: WorkItem }): Promise<WorkItemComments> {
    const project = ctx?.project ?? str((ctx?.wi ?? (await this.getWorkItem(id))).fields["System.TeamProject"]) ?? this.defaultProject;
    if (!project) throw new NotFoundError("project for work item comments", id);
    const url = withApiVersion(
      `${this.hosts.base("core")}/${enc(project)}/_apis/wit/workItems/${id}/comments`,
      this.versions.forArea("wit-comments"),
    );
    const { data } = await this.transport.fetchJson<any>(url);
    const comments = (data?.comments ?? []).map(normalizeComment);
    return { workItemId: id, totalCount: data?.totalCount ?? comments.length, count: comments.length, comments };
  }

  // ---- 4. get_comment_details (+ attachments) ------------------------------

  /** Resolve a comment and download all related attachments (work-item AttachedFile + body refs). */
  async getCommentDetails(args: { workItemId: number; commentId?: number; saveDir?: string }): Promise<CommentDetails> {
    const wi = await this.fetchWorkItemFull(args.workItemId);
    let comment = null as CommentDetails["comment"];
    if (args.commentId !== undefined) {
      const list = await this.getWorkItemComments(args.workItemId, { wi }); // reuse wi to derive project, no refetch
      comment = list.comments.find((c) => c.id === args.commentId) ?? null;
      if (!comment) throw new NotFoundError("comment", args.commentId);
    }

    const refs = collectAttachmentRefs(wi, comment?.text ?? "");
    const attachments: CommentDetails["attachments"] = [];
    for (const ref of refs) {
      const bin = await this.transport.fetchBuffer(withApiVersion(ref.url, this.versions.forArea("wit")));
      const sha256 = crypto.createHash("sha256").update(bin.data).digest("hex");
      let savedPath: string | null = null;
      if (args.saveDir) {
        const fs = await import("node:fs/promises");
        const path = await import("node:path");
        await fs.mkdir(args.saveDir, { recursive: true });
        savedPath = path.join(args.saveDir, `${ref.guid}-${ref.name.replace(/[/\\]+/g, "_")}`);
        await fs.writeFile(savedPath, bin.data);
      }
      attachments.push({ ...ref, size: bin.data.length, contentLength: bin.contentLength, sha256, savedPath });
    }
    return { workItemId: args.workItemId, comment, attachments };
  }

  // ---- 5. search_pull_requests --------------------------------------------

  async searchPullRequests(args: { repoId?: string; project?: string; status?: string; creatorId?: string; targetRef?: string; top?: number }): Promise<PullRequestSearchResult> {
    const top = args.top ?? 50;
    const q: string[] = [`$top=${top}`];
    if (args.status) q.push(`searchCriteria.status=${enc(args.status)}`);
    if (args.creatorId) q.push(`searchCriteria.creatorId=${enc(args.creatorId)}`);
    if (args.targetRef) q.push(`searchCriteria.targetRefName=${enc(args.targetRef)}`);
    const project = args.project ?? this.defaultProject ?? undefined;
    // Precedence: a repo (org-level by id) > a project scope > ORG-WIDE search.
    let base: string;
    if (args.repoId) {
      const repoId = await this.resolveRepoId(args.repoId);
      base = `${this.hosts.base("core")}/_apis/git/repositories/${enc(repoId)}/pullrequests`;
    } else if (project) {
      base = `${this.hosts.base("core")}/${enc(project)}/_apis/git/pullrequests`;
    } else {
      base = `${this.hosts.base("core")}/_apis/git/pullrequests`;
    }
    const url = withApiVersion(`${base}?${q.join("&")}`, this.versions.forArea("git"));
    const { data } = await this.transport.fetchJson<any>(url);
    const items = (data?.value ?? []).map(normalizePrSummary);
    return { count: items.length, items };
  }

  // ---- 6. get_pull_request -------------------------------------------------

  async getPullRequest(args: { repoId: string; prId: number }): Promise<PullRequest> {
    const repoId = await this.resolveRepoId(args.repoId);
    const url = withApiVersion(
      `${this.hosts.base("core")}/_apis/git/repositories/${enc(repoId)}/pullRequests/${args.prId}?$expand=all`,
      this.versions.forArea("git"),
    );
    const { data } = await this.transport.fetchJson<any>(url);
    let workItemRefs: Array<{ id: string; url: string }> = [];
    try {
      const wiUrl = withApiVersion(
        `${this.hosts.base("core")}/_apis/git/repositories/${enc(repoId)}/pullRequests/${args.prId}/workitems`,
        this.versions.forArea("git"),
      );
      const { data: wir } = await this.transport.fetchJson<any>(wiUrl);
      workItemRefs = (wir?.value ?? []).map((w: any) => ({ id: String(w.id), url: str(w.url) ?? "" }));
    } catch {
      /* work-item refs are best-effort */
    }
    return normalizePullRequest(data, workItemRefs);
  }

  // ---- 7. get_pull_request_comments ---------------------------------------

  async getPullRequestComments(args: { repoId: string; prId: number }): Promise<PullRequestComments> {
    const repoId = await this.resolveRepoId(args.repoId);
    const url = withApiVersion(
      `${this.hosts.base("core")}/_apis/git/repositories/${enc(repoId)}/pullRequests/${args.prId}/threads`,
      this.versions.forArea("git"),
    );
    const { data } = await this.transport.fetchJson<any>(url);
    const threads = (data?.value ?? []).map(normalizeThread);
    const systemThreadCount = threads.filter((t: any) => t.kind === "system").length;
    return {
      pullRequestId: args.prId,
      threadCount: threads.length,
      systemThreadCount,
      humanThreadCount: threads.length - systemThreadCount,
      threads,
    };
  }

  // ---- 8. search_feeds -----------------------------------------------------

  async searchFeeds(args?: { feedId?: string }): Promise<FeedsBrowse> {
    const feedsUrl = withApiVersion(`${this.hosts.base("feeds")}/_apis/packaging/feeds`, this.versions.forArea("packaging-feeds"));
    const { data } = await this.transport.fetchJson<any>(feedsUrl);
    const feeds = (data?.value ?? []).map((f: any) => ({ id: String(f.id), name: str(f.name) ?? String(f.id), url: str(f.url) }));
    if (!args?.feedId) return { feeds };

    const pkgUrl = withApiVersion(
      `${this.hosts.base("feeds")}/_apis/packaging/feeds/${enc(args.feedId)}/packages?includeAllVersions=true`,
      this.versions.forArea("packaging-feeds"),
    );
    const { data: pkgData } = await this.transport.fetchJson<any>(pkgUrl);
    const packages = (pkgData?.value ?? []).map((p: any) => ({
      id: String(p.id),
      name: str(p.name) ?? String(p.id),
      protocolType: str(p.protocolType),
      versions: (p.versions ?? []).map((v: any) => ({ id: str(v.id), version: str(v.version) ?? "", isLatest: typeof v.isLatest === "boolean" ? v.isLatest : null })),
    }));
    return { feeds, packages };
  }

  // ---- 9. download_artifact (Phase 3, cross-host via session) ---------------

  /** Canonical pkgs.dev.azure.com download URL for a package version. */
  artifactUrl(args: { feedId: string; packageName: string; version: string; protocol: "nuget" | "npm" }): string {
    if (args.protocol === "npm") {
      // npm tarball download (EMPIRICALLY validated against a live feed):
      //   {org}/_packaging/{feed}/npm/registry/{name}/-/{unscopedName}-{version}.tgz
      // The '/npm/registry/' segment is required, the route is ORG-scoped (project-
      // scoped returns "feed doesn't exist"), and the FILENAME uses only the unscoped
      // name ('@scope/name' -> 'name'). The path keeps the scoped name with a literal '/'.
      const n = args.packageName;
      const filename = n.includes("/") ? n.slice(n.lastIndexOf("/") + 1) : n;
      return `${this.hosts.base("pkgs")}/_packaging/${enc(args.feedId)}/npm/registry/${n}/-/${filename}-${enc(args.version)}.tgz`;
    }
    // nuget content endpoint, ORG-scoped (consistent with the validated npm route;
    // feeds are org-level). Unvalidated against a live NuGet feed — npm is the path
    // exercised end-to-end. Falls back to a project segment if one is configured.
    const scope = this.defaultProject ? `/${enc(this.defaultProject)}` : "";
    return withApiVersion(
      `${this.hosts.base("pkgs")}${scope}/_apis/packaging/feeds/${enc(args.feedId)}/nuget/packages/${enc(args.packageName)}/versions/${enc(args.version)}/content`,
      this.versions.forArea("packaging-pkgs"),
    );
  }

  async downloadArtifact(args: { feedId: string; packageName: string; version: string; protocol: "nuget" | "npm"; saveDir: string }): Promise<import("./schemas.js").DownloadedArtifact> {
    const url = this.artifactUrl(args);
    const bin = await this.transport.fetchBuffer(url);
    const sha256 = crypto.createHash("sha256").update(bin.data).digest("hex");
    const { validateArchive } = await import("./archive.js");
    const check = validateArchive(args.protocol, bin.data);
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(args.saveDir, { recursive: true });
    const ext = args.protocol === "npm" ? "tgz" : "nupkg";
    // Sanitize the filename: scoped names (@scope/name) contain '/' which would
    // otherwise be treated as a directory and fail the write.
    const safeName = args.packageName.replace(/[/\\@]+/g, "_").replace(/^_+/, "");
    const savedPath = path.join(args.saveDir, `${safeName}.${args.version}.${ext}`);
    await fs.writeFile(savedPath, bin.data);
    return {
      feedId: args.feedId,
      packageName: args.packageName,
      version: args.version,
      protocol: args.protocol,
      size: bin.data.length,
      contentLength: bin.contentLength,
      sha256,
      savedPath,
      archiveValid: check.valid,
      archiveDetail: check.detail,
    };
  }
}

// ---- helpers / normalizers -------------------------------------------------

function enc(s: string): string {
  return encodeURIComponent(s);
}
function str(v: unknown): string | null {
  return typeof v === "string" ? v : v == null ? null : String(v);
}

/** Parse a PR artifact link: vstfs:///Git/PullRequestId/{projectId}%2F{repoId}%2F{prId} */
export function parsePrArtifact(url: string): Relation["pullRequest"] | undefined {
  const idx = url.indexOf("PullRequestId/");
  if (idx === -1) return undefined;
  const tail = decodeURIComponent(url.slice(idx + "PullRequestId/".length));
  const parts = tail.split("/");
  if (parts.length < 3) return undefined;
  const prId = Number(parts[2]);
  if (!Number.isFinite(prId)) return undefined;
  return { projectId: parts[0], repositoryId: parts[1], pullRequestId: prId };
}

export function normalizeWorkItem(raw: any): WorkItem {
  const fields = raw?.fields ?? {};
  const relations: Relation[] = (raw?.relations ?? []).map((r: any) => {
    const rel: Relation = { rel: r.rel, url: r.url, attributes: r.attributes };
    if (typeof r.url === "string") {
      if (r.url.includes("PullRequestId")) {
        const pr = parsePrArtifact(r.url);
        if (pr) rel.pullRequest = pr;
      }
      const m = /\/workItems\/(\d+)(?:$|\?)/i.exec(r.url);
      if (m) rel.workItemId = Number(m[1]);
    }
    return rel;
  });
  return {
    id: raw.id,
    rev: raw.rev,
    url: str(raw.url) ?? "",
    type: str(fields["System.WorkItemType"]) ?? "",
    title: str(fields["System.Title"]) ?? "",
    state: str(fields["System.State"]) ?? "",
    fields,
    relations,
  };
}

function normalizeComment(c: any) {
  return {
    id: c.id,
    text: str(c.text) ?? "",
    createdBy: str(c.createdBy?.displayName ?? c.createdBy?.uniqueName),
    createdDate: str(c.createdDate),
    modifiedDate: str(c.modifiedDate),
  };
}

/** Collect attachment references: work-item AttachedFile relations + comment-body src/href links. */
export function collectAttachmentRefs(wi: WorkItem, commentText: string): Array<{ guid: string; name: string; url: string; source: "relation" | "comment-body" }> {
  const out: Array<{ guid: string; name: string; url: string; source: "relation" | "comment-body" }> = [];
  const seen = new Set<string>();
  for (const r of wi.relations) {
    if (r.rel === "AttachedFile" && typeof r.url === "string") {
      const guid = guidFromAttachmentUrl(r.url);
      const name = (r.attributes?.["name"] as string) ?? guid;
      if (guid && !seen.has(guid)) {
        seen.add(guid);
        out.push({ guid, name, url: r.url, source: "relation" });
      }
    }
  }
  // attachments referenced inside the comment body: .../_apis/wit/attachments/{guid}
  const re = /_apis\/wit\/attachments\/([0-9a-fA-F-]{36})(?:[^"'\s)]*)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(commentText)) !== null) {
    const guid = m[1];
    if (!seen.has(guid)) {
      seen.add(guid);
      const fileNameMatch = /fileName=([^&"'\s]+)/.exec(m[0]);
      out.push({ guid, name: fileNameMatch ? decodeURIComponent(fileNameMatch[1]) : guid, url: `https://dev.azure.com/_apis/wit/attachments/${guid}`, source: "comment-body" });
    }
  }
  return out;
}

function guidFromAttachmentUrl(url: string): string {
  const m = /attachments\/([0-9a-fA-F-]{36})/.exec(url);
  return m ? m[1] : "";
}

function normalizePrSummary(p: any) {
  return {
    pullRequestId: p.pullRequestId,
    title: str(p.title),
    status: str(p.status),
    createdBy: str(p.createdBy?.displayName ?? p.createdBy?.uniqueName),
    sourceRefName: str(p.sourceRefName),
    targetRefName: str(p.targetRefName),
    repositoryId: str(p.repository?.id),
    repositoryName: str(p.repository?.name),
  };
}

function normalizePullRequest(p: any, workItemRefs: Array<{ id: string; url: string }>): PullRequest {
  return {
    pullRequestId: p.pullRequestId,
    title: str(p.title),
    description: str(p.description),
    status: str(p.status),
    createdBy: str(p.createdBy?.displayName ?? p.createdBy?.uniqueName),
    sourceRefName: str(p.sourceRefName),
    targetRefName: str(p.targetRefName),
    repositoryId: str(p.repository?.id),
    repositoryName: str(p.repository?.name),
    reviewers: (p.reviewers ?? []).map((r: any) => ({ id: str(r.id), displayName: str(r.displayName), vote: typeof r.vote === "number" ? r.vote : null })),
    workItemRefs,
    raw: p,
  };
}

function normalizeThread(t: any) {
  const comments = (t.comments ?? []).map((c: any) => ({
    id: c.id,
    content: str(c.content),
    author: str(c.author?.displayName ?? c.author?.uniqueName),
    commentType: str(c.commentType),
    publishedDate: str(c.publishedDate),
  }));
  // A thread is "system" when ALL its comments are system-generated (commentType 'system'),
  // or it carries no human content (properties-only status threads).
  const hasHuman = comments.some((c: any) => c.commentType && c.commentType !== "system");
  return {
    id: t.id,
    kind: (hasHuman ? "human" : "system") as "system" | "human",
    status: str(t.status),
    comments,
  };
}
