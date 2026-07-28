# mcp-ado-browser

> Azure DevOps for MCP — via your browser, not a PAT.

An **MCP (stdio) server** that gives **read-only access to Azure DevOps using only your
existing browser session** — **no PAT, no Azure CLI, no official ADO MCP**, no
credential provider. The only source of authentication is the session of a real
browser, driven by Playwright on an **isolated, dedicated profile**.

It is **org-wide by default**: only the organization is required, and it browses **every
project, repo and feed you can access**.

Requests reuse **whatever credential your signed-in browser session already carries**.
Where Azure DevOps authenticates the web app with a bearer token rather than cookies,
the server loads the app shell once, observes the `Authorization: Bearer` header on
the app's own API traffic, and replays that token for every host (`dev.azure.com`,
`feeds`, `pkgs`, `almsearch`). You get **JSON** back — never DOM scraping for data the
REST API provides. No PAT is ever created, and no token is written to disk.

## Why these choices (restricted-environment friendly)

| Concern | Decision |
|---|---|
| No Playwright browser download | `playwright-core` + `channel: 'chrome'`/`'msedge'` uses an already-installed browser; nothing is downloaded. |
| SQLite without a native build | `node:sqlite` (built into Node ≥ 22.5) — zero compilation. |
| One package, one binary | The MCP server and the `authenticate` mechanism ship in the same package and the same `npx` binary. |
| No hardcoded values | org/project/ids come from flags/env or discovery; api-versions live only in `src/ado/versions.ts`. |

## How it works

```mermaid
flowchart TD
    A["authenticate<br/>(visible, chromeless window)"] -->|"sign in once · MFA"| P[("browser session<br/>persisted on an isolated profile")]
    P -. restored .-> W["headless work session"]
    W -->|"loads the app shell once"| T{{"session access token<br/>(observed, in memory only)"}}

    MC["MCP client<br/>(Claude / Cursor / …)"] -->|"tools/call"| SRV["mcp-ado-browser<br/>(stdio MCP server)"]
    SRV --> W
    T --> ADO["dev.azure.com · feeds · pkgs · almsearch<br/>(your real session)"]
    ADO -->|"JSON"| W
    W --> SRV
    SRV <-->|"TTL + Rev freshness"| DB[("SQLite cache")]
```

1. **Authentication is your browser, not a PAT.** `authenticate` opens a real,
   visible browser window on a **dedicated, isolated profile** (never your daily
   browser). You sign in normally (MFA included). The tool detects success by polling
   an authenticated endpoint, then snapshots the browser session to disk. No PAT is
   ever created.
2. **Work runs headless.** Subsequent runs launch the same profile **headless** and
   restore that snapshot — no window, no re-login until the session expires.
   The snapshot is needed because the cookie that keeps the Azure DevOps app shell
   loaded is a **session cookie**, which Chrome drops when it exits.
3. **Requests reuse the web app's own credential.** On the tenants this was tested
   against, the Azure DevOps web app authenticates its API with
   `Authorization: Bearer` (MSAL) and a cookie-only request gets `401` on every
   host — the sign-in URL even carries `protocol=cookieless`. (This is *observed*
   behaviour; we found no Microsoft announcement of such a change, so treat it as
   something that varies rather than a rule.) The server therefore loads the app
   shell once, observes the token on the app's own API calls, and replays it. One
   token covers `dev.azure.com`, `feeds`, `pkgs` and `almsearch` alike.

   The token is held **in memory only** and refreshed automatically on a `401`. It
   is deliberately never written to disk: a bearer token reachable from JS is more
   exposed than an `httpOnly` cookie — [Microsoft's own MSAL guidance](https://github.com/AzureAD/microsoft-authentication-library-for-js/blob/dev/lib/msal-browser/docs/caching.md)
   states browser storage is only safe absent XSS, and that its cache encryption
   "reduce[s] the persistence of auth artifacts, not to provide additional
   security". This server does not widen that exposure.
4. **`401` and `403` are kept distinct.** `401` means the session is dead →
   `AUTH_REQUIRED`, re-run `authenticate`. `403` means you are signed in but lack
   permission on that resource (a private feed, say) → a `403` error saying so.
   Re-authenticating cannot fix a permission problem.
5. **Responses are cached** in a local SQLite DB (`node:sqlite`) with a configurable
   TTL. On a stale hit, a cheap freshness check (`System.Rev` for work items) avoids
   re-downloading unchanged data.
6. **When the session dies**, tools fail fast with `AUTH_REQUIRED` — just re-run
   `authenticate` and continue.

## Getting started

**Prerequisites:** Node ≥ 22.5 and Google Chrome (or Microsoft Edge) installed. You do
**not** need a PAT, the Azure CLI, or any admin setup.

Setup is **two steps**:

1. **Register the server** in your MCP client (one config entry — see your client below).
2. **Sign in once** — just ask your assistant: *“authenticate to Azure DevOps”*. The
   built-in `authenticate` tool opens a visible browser window; you log in (MFA), and the
   session is persisted. (No separate terminal command needed.) From then on everything
   runs headless until the session expires — then just ask it to authenticate again.

The command every client runs is the same:

```bash
npx -y mcp-ado-browser --org <your-org>
```

Config is passed as CLI flags (`--org`, `--project`, …) or env vars (`ADO_ORG`, …);
flags win. Then ask things like *“list my active pull requests”*, *“show work item 1234
and its linked PR”*, or *“what feeds and packages are in this org?”*.

> Tip: prefer per-user/local config (not committed) so your org name doesn't land in a
> shared repo. Or omit `--org` from a committed config and set `ADO_ORG` in your env.

## Use it from your MCP client

<details open>
<summary><b>Claude Code</b></summary>

```bash
claude mcp add ado --scope local -- npx -y mcp-ado-browser --org <your-org>
```
Then ask Claude to *“authenticate to Azure DevOps”*.
</details>

<details>
<summary><b>Claude Desktop</b> — <code>claude_desktop_config.json</code></summary>

```json
{
  "mcpServers": {
    "ado": {
      "command": "npx",
      "args": ["-y", "mcp-ado-browser", "--org", "<your-org>"]
    }
  }
}
```
</details>

<details>
<summary><b>GitHub Copilot (VS Code)</b> — <code>.vscode/mcp.json</code></summary>

```json
{
  "servers": {
    "ado": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "mcp-ado-browser", "--org", "<your-org>"]
    }
  }
}
```
Open Copilot Chat in **Agent** mode and pick the `ado` tools. (Avoid committing your org —
use `${env:ADO_ORG}` or a personal config.)
</details>

<details>
<summary><b>Cursor</b> — <code>~/.cursor/mcp.json</code> (or <code>.cursor/mcp.json</code>)</summary>

```json
{
  "mcpServers": {
    "ado": {
      "command": "npx",
      "args": ["-y", "mcp-ado-browser", "--org", "<your-org>"]
    }
  }
}
```
</details>

<details>
<summary><b>Codex CLI</b> — <code>~/.codex/config.toml</code></summary>

```toml
[mcp_servers.ado]
command = "npx"
args = ["-y", "mcp-ado-browser", "--org", "<your-org>"]
```
</details>

After registering, trigger sign-in **from the chat** (*“authenticate to Azure DevOps”*),
which runs the `authenticate` tool. Prefer a terminal instead? `npx -y mcp-ado-browser
authenticate --org <your-org>` does the same thing. Tools return a structured
`AUTH_REQUIRED` error when the session expires — re-authenticate and continue.

## Tools (`tools/list`)

| Tool | What it does |
|---|---|
| `list_projects` | All projects you can access (org-wide). |
| `list_repositories` | All Git repos across the org (or one project). |
| `search_work_items` | WIQL (org-wide by default) or full-text (almsearch); `project` to scope. |
| `get_work_item` | Work item with `$expand=all` + `relations` (hierarchy, Related, PR ArtifactLink resolved). |
| `get_work_item_comments` | The separate comments endpoint (project derived automatically). |
| `get_comment_details` | A comment **plus** its downloaded attachments (size, sha256). |
| `search_pull_requests` | PRs org-wide, by repo, or by project; filter by status/author/target. |
| `get_pull_request` | Metadata, branches, reviewers, linked work items (repo by id **or name**). |
| `get_pull_request_comments` | Threads, distinguishing **system vs human**. |
| `search_feeds` | Artifacts feeds → packages → versions. |
| `download_artifact` | `.nupkg`/`.tgz` from a feed (cross-host `pkgs.dev.azure.com`), with archive-integrity validation. |
| `authenticate` | Opens a visible browser for interactive sign-in (MFA); persists the session. Run it once, or whenever a tool returns `AUTH_REQUIRED`. |

## Commands

The single `npx mcp-ado-browser` binary has a few subcommands:

| Command | What it does |
|---|---|
| `npx mcp-ado-browser --org <org>` | Start the MCP stdio server (default). |
| `… authenticate --org <org>` | Interactive sign-in (visible browser). Same as the `authenticate` tool. |
| `… status --org <org>` | Show the profile/cache paths, the org, and whether the session is signed in (and as who). |
| `… logout` | Clear the persisted session **and** the cache (a local sign-out). No org needed. |

> Switching org with the **same** account needs nothing special — just change `--org`; one
> sign-in covers every org that account can access. A different account → `logout` first,
> then `authenticate` against the other org.

## Where it stores things

Everything is local to your machine, under a single dedicated folder (mode `700`, never
committed). Nothing is hosted remotely — the server is a local process spawned by your MCP
client over stdio.

| What | Path (default) |
|---|---|
| Browser session (profile) | **macOS/Linux:** `~/.mcp-ado-browser/profile/` · **Windows:** `C:\Users\<you>\.mcp-ado-browser\profile\` |
| Session snapshot (mode `600`) | `…/.mcp-ado-browser/session-state.json` — the session cookies Chrome will not keep on its own. Treat it like a credential; `logout` deletes it. |
| SQLite cache | `…/.mcp-ado-browser/cache.sqlite` |
| Package code (npx cache) | **macOS/Linux:** `~/.npm/_npx/<hash>/…/mcp-ado-browser` · **Windows:** `…\AppData\Local\npm-cache\_npx\<hash>\…` (see `npm config get cache`) |

Reset everything (forces re-login): `logout`, or `rm -rf ~/.mcp-ado-browser`.

## Configuration

| Flag | Env | Default | Meaning |
|---|---|---|---|
| `--org` | `ADO_ORG` | — | Organization (**required**). |
| `--project` | `ADO_PROJECT` | — | Default project scope (optional; org-wide otherwise). |
| `--user-data-dir` | `ADO_USER_DATA_DIR` | `~/.mcp-ado-browser/profile` | Isolated persistent browser profile. |
| — | `ADO_SESSION_STATE` | `~/.mcp-ado-browser/session-state.json` | Session snapshot (mode `600`) that keeps you signed in across browser restarts. |
| `--channel` | `ADO_BROWSER_CHANNEL` | `chrome` | `chrome` or `msedge`. |
| `--cache-ttl` | `ADO_CACHE_TTL_SECONDS` | `900` | Global cache TTL. Per-resource: `ADO_CACHE_TTL_WORKITEM=60`. |
| `--api-version` | `ADO_API_VERSION` | discovery/defaults | Force an api-version for all areas. |
| `--no-app-window` | `ADO_APP_WINDOW=0` | app mode | Use a normal browser window for sign-in. |
| `--headed` | `ADO_HEADLESS=0` | headless | Run work with a visible window. |

## Development & verification

```bash
npm install
npm run build
npm run verify           # all offline gates (browser stack, MCP, tools, cache, artifacts, no-hardcoding)
npm run verify:live      # adds the live acceptance pass against real Azure DevOps
npm run scan:secrets     # pre-push secret / sensitive-data scan
npm run demo:live        # drive the real stdio server as an MCP client (env-driven)
```

`npm run verify` prints a detailed report, gate by gate, assertion by assertion.
`BLOCKED_ON_AUTH` is transitory: the run is not done until the live pass is green; the
only tolerated terminal exclusion is `EMPIRICALLY_BLOCKED` (with evidence), for the
cross-host artifact download only.

## Security & privacy

- Authentication is **only** your real browser session on a dedicated, isolated profile
  — no PAT or token is ever created, stored, or transmitted by this tool.
- The session lives in `~/.mcp-ado-browser/profile` (machine-local, gitignored).
- Fixtures and reports are anonymized; `npm run scan:secrets` blocks pushes that would
  leak personal/org data or secrets (also enforced in CI).

## License

MIT © VMargan
