/**
 * The 9 read tools (mission §5). Each declares a zod INPUT shape (for tools/list
 * + input validation) and a zod OUTPUT schema (drift detection). Handlers map
 * arguments onto AdoClient calls and validate the result before returning.
 *
 * The same defs power both the live MCP server and the offline verify harness,
 * so what the harness asserts is exactly what ships.
 */
import { z, ZodRawShape, ZodType } from "zod";
import { AdoClient } from "../ado/client.js";
import {
  CommentDetailsSchema,
  DownloadedArtifactSchema,
  FeedsBrowseSchema,
  ProjectsListSchema,
  PullRequestCommentsSchema,
  PullRequestSchema,
  PullRequestSearchResultSchema,
  RepositoriesListSchema,
  WorkItemCommentsSchema,
  WorkItemSchema,
  WorkItemSearchResultSchema,
  validateOutput,
} from "../ado/schemas.js";

export interface ToolDef<I extends ZodRawShape = ZodRawShape, O = unknown> {
  name: string;
  description: string;
  inputShape: I;
  outputSchema: ZodType<O>;
  run(client: AdoClient, args: z.objectOutputType<I, ZodType>): Promise<O>;
}

function def<I extends ZodRawShape, O>(d: ToolDef<I, O>): ToolDef<I, O> {
  return d;
}

export const TOOL_DEFS: ToolDef[] = [
  def({
    name: "list_projects",
    description: "List ALL Azure DevOps projects the user can access in the organization (GET _apis/projects). Use this to discover projects to browse.",
    inputShape: {},
    outputSchema: ProjectsListSchema,
    run: (c) => c.listProjects().then((r) => validateOutput(ProjectsListSchema, r, "list_projects")),
  }),

  def({
    name: "list_repositories",
    description: "List ALL Git repositories the user can access across the organization (GET _apis/git/repositories), or within one project. Returns id, name and owning project for each repo.",
    inputShape: {
      project: z.string().optional().describe("Restrict to a single project (optional; omit for org-wide)."),
    },
    outputSchema: RepositoriesListSchema,
    run: (c, a) => c.listRepositories(a).then((r) => validateOutput(RepositoriesListSchema, r, "list_repositories")),
  }),

  def({
    name: "search_work_items",
    description:
      "Search/browse work items ORG-WIDE (cross-project) by default. Backend is WIQL (POST _apis/wit/wiql); pass `text` for full-text Search (almsearch), or `project` to scope to one project. Returns id + summary fields.",
    inputShape: {
      wiql: z.string().optional().describe("Raw WIQL query. If omitted, a bounded recent-items query (@Me) is used."),
      text: z.string().optional().describe("Full-text search string (uses almsearch; falls back to WIQL)."),
      project: z.string().optional().describe("Restrict to a single project (optional; omit for org-wide)."),
      top: z.number().int().positive().max(200).optional().describe("Max results (default 50)."),
    },
    outputSchema: WorkItemSearchResultSchema,
    run: (c, a) => c.searchWorkItems(a).then((r) => validateOutput(WorkItemSearchResultSchema, r, "search_work_items")),
  }),

  def({
    name: "get_work_item",
    description: "Get a single work item with $expand=all, including `relations` (hierarchy, Related, and ArtifactLink PR references resolved).",
    inputShape: {
      id: z.number().int().positive().describe("Work item id."),
      bypassCache: z.boolean().optional().describe("Force a fresh fetch, ignoring the cache."),
    },
    outputSchema: WorkItemSchema,
    run: (c, a) => c.getWorkItem(a.id, { bypassCache: a.bypassCache }).then((r) => validateOutput(WorkItemSchema, r, "get_work_item")),
  }),

  def({
    name: "get_work_item_comments",
    description: "Get the full discussion for a work item (GET _apis/wit/workItems/{id}/comments — a SEPARATE endpoint, not part of $expand).",
    inputShape: { id: z.number().int().positive().describe("Work item id.") },
    outputSchema: WorkItemCommentsSchema,
    run: (c, a) => c.getWorkItemComments(a.id).then((r) => validateOutput(WorkItemCommentsSchema, r, "get_work_item_comments")),
  }),

  def({
    name: "get_comment_details",
    description: "Resolve a work item (and optionally a specific comment) AND download all related attachments (work-item AttachedFile relations + attachments referenced in the comment body). Returns metadata + downloaded content stats (size, sha256).",
    inputShape: {
      workItemId: z.number().int().positive().describe("Work item id."),
      commentId: z.number().int().positive().optional().describe("Specific comment id to resolve (optional)."),
      saveDir: z.string().optional().describe("Directory to write downloaded attachment files to (optional)."),
    },
    outputSchema: CommentDetailsSchema,
    run: (c, a) => c.getCommentDetails(a).then((r) => validateOutput(CommentDetailsSchema, r, "get_comment_details")),
  }),

  def({
    name: "search_pull_requests",
    description: "Search pull requests ORG-WIDE by default, or within a repo (repoId) or a project. Filters: status, creatorId, targetRef. (GET _apis/git/pullrequests)",
    inputShape: {
      repoId: z.string().optional().describe("Repository id (GUID) or name (omit for org-wide / project-wide search)."),
      project: z.string().optional().describe("Restrict to a single project (optional)."),
      status: z.string().optional().describe("active | completed | abandoned | all."),
      creatorId: z.string().optional().describe("Creator identity id."),
      targetRef: z.string().optional().describe("Target branch ref name, e.g. refs/heads/main."),
      top: z.number().int().positive().max(200).optional(),
    },
    outputSchema: PullRequestSearchResultSchema,
    run: (c, a) => c.searchPullRequests(a).then((r) => validateOutput(PullRequestSearchResultSchema, r, "search_pull_requests")),
  }),

  def({
    name: "get_pull_request",
    description: "Get a pull request with metadata, branches, reviewers and linked work items. Resolved org-wide — repoId may be a GUID or a repository name.",
    inputShape: {
      repoId: z.string().describe("Repository id (GUID) or name."),
      prId: z.number().int().positive().describe("Pull request id."),
    },
    outputSchema: PullRequestSchema,
    run: (c, a) => c.getPullRequest(a).then((r) => validateOutput(PullRequestSchema, r, "get_pull_request")),
  }),

  def({
    name: "get_pull_request_comments",
    description: "Get PR threads (system vs human). Resolved org-wide — repoId may be a GUID or a repository name.",
    inputShape: {
      repoId: z.string().describe("Repository id (GUID) or name."),
      prId: z.number().int().positive().describe("Pull request id."),
    },
    outputSchema: PullRequestCommentsSchema,
    run: (c, a) => c.getPullRequestComments(a).then((r) => validateOutput(PullRequestCommentsSchema, r, "get_pull_request_comments")),
  }),

  def({
    name: "search_feeds",
    description: "Browse Azure Artifacts feeds (GET feeds.dev.azure.com/_apis/packaging/feeds). Pass feedId to also list packages + versions.",
    inputShape: { feedId: z.string().optional().describe("Feed id to browse for packages (optional).") },
    outputSchema: FeedsBrowseSchema,
    run: (c, a) => c.searchFeeds(a).then((r) => validateOutput(FeedsBrowseSchema, r, "search_feeds")),
  }),

  def({
    name: "download_artifact",
    description: "Download a package artifact (.nupkg / .tgz) from a feed via the browser session (pkgs.dev.azure.com). Validates archive integrity (size, sha256, valid zip/tgz) for re-hosting.",
    inputShape: {
      feedId: z.string().describe("Feed id (or name)."),
      packageName: z.string().describe("Package name."),
      version: z.string().describe("Exact version to download."),
      protocol: z.enum(["nuget", "npm"]).describe("Package protocol."),
      saveDir: z.string().describe("Directory to write the downloaded artifact to."),
    },
    outputSchema: DownloadedArtifactSchema,
    run: (c, a) => c.downloadArtifact(a).then((r) => validateOutput(DownloadedArtifactSchema, r, "download_artifact")),
  }),
];

export function toolByName(name: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.name === name);
}
