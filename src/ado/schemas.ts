/**
 * Declared OUTPUT schemas (zod). Every tool validates its normalized output here
 * before returning. A missing/mistyped field => ValidationError => a failing gate
 * (schema-drift detection, mission §7).
 *
 * Outputs are NORMALIZED shapes (not raw ADO blobs): tools map raw ADO JSON into
 * these, keeping the full raw payload under `raw`/`rawFields` for completeness.
 */
import { z } from "zod";
import { ValidationError } from "../errors.js";

export const RelationSchema = z.object({
  rel: z.string(),
  url: z.string(),
  attributes: z.record(z.unknown()).optional(),
  /** Parsed PR reference when rel is an ArtifactLink to a Git pull request. */
  pullRequest: z
    .object({ projectId: z.string(), repositoryId: z.string(), pullRequestId: z.number() })
    .optional(),
  /** Linked work item id when the relation points at another work item. */
  workItemId: z.number().optional(),
});
export type Relation = z.infer<typeof RelationSchema>;

export const WorkItemSchema = z.object({
  id: z.number(),
  rev: z.number(),
  url: z.string(),
  type: z.string(), // System.WorkItemType
  title: z.string(), // System.Title
  state: z.string(), // System.State
  fields: z.record(z.unknown()),
  relations: z.array(RelationSchema),
});
export type WorkItem = z.infer<typeof WorkItemSchema>;

export const WorkItemSummarySchema = z.object({
  id: z.number(),
  type: z.string().nullable(),
  title: z.string().nullable(),
  state: z.string().nullable(),
  fields: z.record(z.unknown()).optional(),
});
export const WorkItemSearchResultSchema = z.object({
  count: z.number(),
  items: z.array(WorkItemSummarySchema),
  /** "wiql" | "almsearch" — which backend served the result. */
  backend: z.string(),
});
export type WorkItemSearchResult = z.infer<typeof WorkItemSearchResultSchema>;

export const CommentSchema = z.object({
  id: z.number(),
  text: z.string(),
  createdBy: z.string().nullable(),
  createdDate: z.string().nullable(),
  modifiedDate: z.string().nullable().optional(),
});
export const WorkItemCommentsSchema = z.object({
  workItemId: z.number(),
  totalCount: z.number(),
  count: z.number(),
  comments: z.array(CommentSchema),
});
export type WorkItemComments = z.infer<typeof WorkItemCommentsSchema>;

export const AttachmentRefSchema = z.object({
  guid: z.string(),
  name: z.string(),
  url: z.string(),
  /** Where the reference came from: a work-item relation or a comment body. */
  source: z.enum(["relation", "comment-body"]),
});
export const DownloadedAttachmentSchema = AttachmentRefSchema.extend({
  size: z.number(),
  contentLength: z.number().nullable(),
  sha256: z.string(),
  savedPath: z.string().nullable(),
});
export const CommentDetailsSchema = z.object({
  workItemId: z.number(),
  comment: CommentSchema.nullable(),
  attachments: z.array(DownloadedAttachmentSchema),
});
export type CommentDetails = z.infer<typeof CommentDetailsSchema>;

export const PullRequestSummarySchema = z.object({
  pullRequestId: z.number(),
  title: z.string().nullable(),
  status: z.string().nullable(),
  createdBy: z.string().nullable(),
  sourceRefName: z.string().nullable(),
  targetRefName: z.string().nullable(),
  repositoryId: z.string().nullable(),
  repositoryName: z.string().nullable(),
});
export const PullRequestSearchResultSchema = z.object({
  count: z.number(),
  items: z.array(PullRequestSummarySchema),
});
export type PullRequestSearchResult = z.infer<typeof PullRequestSearchResultSchema>;

export const PullRequestSchema = z.object({
  pullRequestId: z.number(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  status: z.string().nullable(),
  createdBy: z.string().nullable(),
  sourceRefName: z.string().nullable(),
  targetRefName: z.string().nullable(),
  repositoryId: z.string().nullable(),
  repositoryName: z.string().nullable(),
  reviewers: z.array(z.object({ id: z.string().nullable(), displayName: z.string().nullable(), vote: z.number().nullable() })),
  workItemRefs: z.array(z.object({ id: z.string(), url: z.string() })),
  raw: z.record(z.unknown()),
});
export type PullRequest = z.infer<typeof PullRequestSchema>;

export const ThreadCommentSchema = z.object({
  id: z.number(),
  content: z.string().nullable(),
  author: z.string().nullable(),
  commentType: z.string().nullable(),
  publishedDate: z.string().nullable(),
});
export const PrThreadSchema = z.object({
  id: z.number(),
  kind: z.enum(["system", "human"]),
  status: z.string().nullable(),
  comments: z.array(ThreadCommentSchema),
});
export const PullRequestCommentsSchema = z.object({
  pullRequestId: z.number(),
  threadCount: z.number(),
  systemThreadCount: z.number(),
  humanThreadCount: z.number(),
  threads: z.array(PrThreadSchema),
});
export type PullRequestComments = z.infer<typeof PullRequestCommentsSchema>;

export const PackageVersionSchema = z.object({ id: z.string().nullable(), version: z.string(), isLatest: z.boolean().nullable() });
export const PackageSchema = z.object({
  id: z.string(),
  name: z.string(),
  protocolType: z.string().nullable(),
  versions: z.array(PackageVersionSchema),
});
export const FeedSchema = z.object({ id: z.string(), name: z.string(), url: z.string().nullable() });
export const FeedsBrowseSchema = z.object({
  feeds: z.array(FeedSchema),
  /** Present when a specific feedId was browsed for its packages. */
  packages: z.array(PackageSchema).optional(),
});
export type FeedsBrowse = z.infer<typeof FeedsBrowseSchema>;

export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string().nullable(),
  description: z.string().nullable(),
  lastUpdateTime: z.string().nullable(),
});
export const ProjectsListSchema = z.object({ count: z.number(), items: z.array(ProjectSchema) });
export type ProjectsList = z.infer<typeof ProjectsListSchema>;

export const RepositorySchema = z.object({
  id: z.string(),
  name: z.string(),
  project: z.string().nullable(),
  defaultBranch: z.string().nullable(),
  webUrl: z.string().nullable(),
  isDisabled: z.boolean().nullable(),
});
export const RepositoriesListSchema = z.object({ count: z.number(), items: z.array(RepositorySchema) });
export type RepositoriesList = z.infer<typeof RepositoriesListSchema>;

export const DownloadedArtifactSchema = z.object({
  feedId: z.string(),
  packageName: z.string(),
  version: z.string(),
  protocol: z.enum(["nuget", "npm"]),
  size: z.number(),
  contentLength: z.number().nullable(),
  sha256: z.string(),
  savedPath: z.string(),
  archiveValid: z.boolean(),
  archiveDetail: z.string(),
});
export type DownloadedArtifact = z.infer<typeof DownloadedArtifactSchema>;

/** Validate `value` against `schema`, raising a ValidationError on drift. */
export function validateOutput<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new ValidationError(`${label} output failed schema validation`, r.error.issues);
  }
  return r.data;
}
