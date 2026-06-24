# [1.1.0](https://github.com/VMargan/mcp-ado-browser/compare/v1.0.0...v1.1.0) (2026-06-24)


### Features

* add authenticate MCP tool and universal multi-client setup ([15237bc](https://github.com/VMargan/mcp-ado-browser/commit/15237bc49577112120cc1264dbf95575be707d06))

# Changelog

All notable changes are documented here. From v1.1.0 onward this file is maintained
automatically by [semantic-release](https://github.com/semantic-release/semantic-release)
from Conventional Commits.

## 1.0.0

Initial release.

- MCP (stdio) server giving read-only access to Azure DevOps using only an
  authenticated browser session — no PAT, no Azure CLI, no official ADO MCP.
- Org-wide: browse every project, repo and feed the user can access.
- Tools: `list_projects`, `list_repositories`, `search_work_items`, `get_work_item`,
  `get_work_item_comments`, `get_comment_details`, `search_pull_requests`,
  `get_pull_request`, `get_pull_request_comments`, `search_feeds`, `download_artifact`.
- `node:sqlite` cache with TTL + revision-based freshness.
- `playwright-core` + installed Chrome/Edge (no Playwright browser download).
- CLI flags and env configuration; chromeless interactive sign-in.
