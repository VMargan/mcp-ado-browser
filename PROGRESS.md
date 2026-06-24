# PROGRESS — mcp-ado-browser

Engineering journal. All values below are generic placeholders (`<org>`, `<project>`,
`<repo>`, `<feed>`, `<id>`) — no real organization/project/repo/feed/ids are recorded
here, and a pre-push secret scan (`npm run scan:secrets`) enforces that.

## Status

- `npm run verify` (offline): **GREEN** — browser stack, MCP conformance, all tools
  against fixtures, SQLite cache + freshness, artifact integrity, no-hardcoding grep.
- `npm run verify:live` (live, with `<org>` + an authenticated session): **GREEN** —
  every tool against real Azure DevOps, org-wide, with `live-acceptance-report.json`
  produced (real-host + `ActivityId`/`x-vss-*` evidence + a live graph cross-check).

## Capabilities

- **Org-wide by default.** Only the organization is required; `project` is optional.
  The server browses every project, repo and feed the user can access.
- Tools (`tools/list`): `list_projects`, `list_repositories`, `search_work_items`,
  `get_work_item`, `get_work_item_comments`, `get_comment_details`,
  `search_pull_requests`, `get_pull_request`, `get_pull_request_comments`,
  `search_feeds`, `download_artifact`.

## Architecture decisions

- **Runtime**: Node ≥ 22.5 → `node:sqlite` (built-in) for the cache. Zero native
  build; nothing a restricted environment can block at install time.
- **Browser**: `playwright-core` + `channel:'chrome'`/`'msedge'` drives an already
  installed browser — never downloads a Playwright Chromium. Isolated persistent
  profile; work runs headless, the window is visible only during sign-in.
- **Auth window**: opens chromeless (Chrome `--app` mode) in headful; sandbox enabled
  there to avoid the `--no-sandbox` banner (`ADO_NO_SANDBOX=1` to override).
- **Hosts**: ADO service topology parameterized solely by `<org>` (`dev.azure.com`,
  `feeds.dev.azure.com`, `pkgs.dev.azure.com`, `almsearch.dev.azure.com`,
  `analytics.dev.azure.com`). No hardcoded org/project/ids/api-versions.
- **Data path**: `page.evaluate(fetch)` same-origin for the core host (work items,
  PRs, comments, attachments), landing on a stable JSON page to avoid SPA context
  destruction (+ retry). Cross-host services (feeds/pkgs) use the same browser
  cookie jar via `context.request`. Always the browser session — no PAT.

## Empirical findings (validated live)

- `connectionData` is a PREVIEW resource: a non-preview api-version → HTTP 400; the
  core area uses `7.1-preview`.
- Sign-in must target the org-scoped URL (`dev.azure.com/<org>`); the bare root
  redirects to the marketing page. Login detected by polling `connectionData` via
  the shared cookie jar.
- Most work-item / git endpoints work ORG-WIDE without a project segment
  (`workitems/{id}`, `workitemsbatch`, `git/repositories`, repo-scoped PRs by GUID,
  org-wide `git/pullrequests`, cross-project WIQL). The ONE exception is work-item
  **comments**, which require the project segment — derived dynamically from the work
  item's `System.TeamProject` (the caller never supplies it).
- Cross-host artifact download works via the session: npm tarballs at
  `pkgs.dev.azure.com/<org>/_packaging/<feed>/npm/registry/<name>/-/<unscoped>-<version>.tgz`
  (org-scoped; `/npm/registry/` required).
- WIQL has a hard 20000-result limit (VS402337); the default query is bounded to `@Me`.

## Verification model

- `npm run verify` runs every gate and prints a pass/fail report. Definition of Done
  = offline green AND a green live acceptance pass. `BLOCKED_ON_AUTH` is transitory
  (run not done until the live pass is green); the only tolerated terminal exclusion
  is `EMPIRICALLY_BLOCKED` (with evidence) for the cross-host artifact download.
- Secrets: `npm run scan:secrets` scans every committed file for personal/org data
  and generic secret patterns; it runs in CI and should be run before any push.
