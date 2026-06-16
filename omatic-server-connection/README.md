# O-Matic Server Connection (MCP Plugin + Bundled Skills)

> **What this is:** the plugin that connects Claude Code and Codex to an O-Matic Server, and ships the Probot, Fred, and Data skills.
> **What this is NOT:** a database. It bundles no PostgreSQL and no pgvector — it's the wire and the crew, not the brain.
> The brain it connects to lives in **[o-matic-server](https://github.com/lucidIT-LLC/o-matic-server)**.

The connection layer for an O-Matic factory, packaged for MCP-capable hosts such as Claude Code and OpenAI Codex. Install it once per host and let each factory project route through its own `.omatic/factory.json` to the right O-Matic Server. Ships Probot, Fred, and Data as plugin-bundled skills.

**Version:** 2.1.4
**Author:** James Walker / O-Matic AI Research Lab

---

## Compatibility model

This package has two layers:

- **MCP tool layer** — `server/index.js` connects to the factory database and exposes O-Matic tools. This requires an MCP-capable host such as Codex, Claude Code, or a desktop host configured to launch the server over stdio.
- **Skill prompt layer** — `skills/*/SKILL.md` files are canonical prompt contracts. They can be used in Google/Gemini, Ollama, or any generic model host, but those hosts do not get factory DB tools unless an external MCP/tool bridge is provided.

`agent-pack.json` documents the host-neutral package model. Adapter notes live in `adapters/`.

Helper scripts:

```bash
node scripts/print-system-prompt.mjs probot
node scripts/build-ollama-modelfile.mjs probot llama3.1:8b > Probot.Modelfile
node scripts/sync-bundled-skills.mjs --dry-run
node scripts/sync-bundled-skills.mjs
```

`sync-bundled-skills.mjs` installs missing bundled skills into
`${CODEX_HOME:-~/.codex}/skills`, updates older installed copies, and skips
installed skills that are already the same version or newer. It also detects
current/newer copies already installed through the Codex plugin cache.

## What this is

The factory brain — persistent memory, rules, tasks, decisions — lives in a separate Postgres + `pgvector` database: the **o-matic-server** image. This plugin doesn't contain that database. It's the MCP layer that *reaches* it: a bundled Node MCP server that resolves your project's factory, reports startup and connector health, searches factory memory, manages task and decision records, and exposes guarded SQL against the connected brain.

Until now that MCP server was a hand-maintained entry in `claude_desktop_config.json`. This plugin packages it so it installs and updates like any other plugin. No JSON surgery on the desktop config.

The server code is shared. Claude Code and Codex differ only in their plugin manifests and host bootstrap metadata.

---

## What's inside

```
omatic-server-connection/
  .claude-plugin/
    plugin.json        # Claude plugin manifest (declares skills/)
  .codex-plugin/
    plugin.json        # Codex plugin manifest (declares skills/)
  .mcp.json            # Codex MCP server config
  skills/
    omatic-server-connection/SKILL.md  # generic plugin operating guide
    orch-o-matic-probot/SKILL.md   # Probot v14.1 — orchestrator
    data-o-matic-data/SKILL.md     # Data v5.0 — analyst, architect + factory DBA
    find-o-matic-fred/SKILL.md     # Fred v9.1 — storage + connection CRUD
  server/              # bundled Node MCP server
    index.js
    connections.js
    tools.js
    package.json
    package-lock.json
    node_modules/       # runtime deps (pg, @modelcontextprotocol/sdk)
  agent-pack.json       # Host-neutral compatibility manifest
  adapters/             # Host-specific notes
  scripts/              # Prompt/Modelfile helpers for prompt-only hosts
  README.md
```

The Claude manifest points the MCP server at `${CLAUDE_PLUGIN_ROOT}/server/index.js`. The Codex manifest points to `./.mcp.json`, which launches `./server/index.js` from the installed plugin root. No absolute paths are committed.

---

## How it picks a database

On Claude Code, the server receives `OMATIC_PROJECT_ROOT=${CLAUDE_PROJECT_DIR}` — the directory Claude Code was opened in. On Codex, the manifest passes `OMATIC_PROJECT_ROOT=${CODEX_WORKSPACE}` and `OMATIC_FACTORY_JSON_PATH=${CODEX_WORKSPACE}/.omatic/factory.json` when the host expands those variables. The resolver also checks common workspace env vars (`CODEX_PROJECT_ROOT`, `CODEX_WORKSPACE_ROOT`, `WORKSPACE_ROOT`, `INIT_CWD`, `PWD`) before falling back to the MCP process working directory. Cowork should use `factory_json_path` in the desktop extension config. In all cases it walks up looking for `.omatic/factory.json` and connects to the connection that file names.

Each factory project carries its own `.omatic/factory.json`:

```json
{
  "factory_id": "omatic",
  "server_name": "O-Matic",
  "platform_profile": "claude-code",
  "database_url": "postgresql://user:password@host:5432/database"
}
```

`.omatic/factory.json` is gitignored — credentials never reach the repo. A committed `.omatic/factory.json.example` template ships in each factory for fresh clones.

One plugin install serves every factory project. The project you open decides which brain you're talking to.

---

## Install In Claude Code

1. In Claude Code, add this repository as a plugin marketplace: `lucidIT-LLC/o-matic-server-connection`.
2. Install the **omatic-server-connection** plugin from that marketplace.
3. Restart Claude Code.
4. Approve the `omatic-server-connection` MCP server on first launch when prompted.
5. **Remove the `omatic-server` block from `claude_desktop_config.json`** — the plugin replaces it. Leaving both means two processes competing for the same server name.

## Install In OpenAI Codex

1. Add this repository as a Codex plugin marketplace.
2. Install the **omatic-server-connection** plugin.
3. Restart Codex so the plugin-managed MCP server is loaded.
4. Open Codex from a factory project containing `.omatic/factory.json`, or use `omatic_add_connection` to create/update the project connection file.
5. Verify with `omatic_resolve_factory`.

Fresh machines: run `npm install` once inside `server/` if `node_modules/` is absent. The repository currently commits `node_modules/` so the plugin can run immediately after clone/install.

---

## Tools exposed

| Tool | Purpose |
|---|---|
| `omatic_usage_guide` | Connector-native instructions for LLM hosts: startup flow, factory resolution, per-platform packaging, pgvector retrieval, and SQL safety |
| `omatic_factory_startup` / `omatic_factory_health_check` | Startup surface, readiness, embedding health |
| `omatic_factory_startup_run` | Side-effecting startup runner: opens a platform session, seeds readiness, records built-in probes, warms retrieval, and returns scoped startup |
| `omatic_search_memory` | Factory memory search. `mode=auto` uses generated or caller-supplied query embeddings for pgvector hybrid retrieval and falls back to FTS when no vector is available |
| `omatic_embedding_status` | Reports redacted embedding config, vector extension status, HNSW/GIN indexes, search functions, and query-embedding readiness |
| `omatic_list_tasks` / `omatic_record_decision` / `omatic_record_session_event` / `omatic_record_probe_result` | Factory state writes |
| `omatic_resolve_factory` | Reports the active factory and resolved `factory_file` path |
| `omatic_claim_work` / `omatic_release_work` | Advisory work claims (if installed) |
| `omatic_execute_sql` | Guarded SQL — `confirm_destructive=true` required for DDL/DML |
| `o-matic-server-{factory}:execute_sql` | Raw SQL, modern name |
| `postgres-cabinet-{factory}:execute_sql` | Raw SQL, legacy alias — retained for backward compatibility |

## LLM Usage Guidance

The connector now teaches MCP hosts how to use it through server initialization
instructions and a first-class guide tool:

```text
omatic_usage_guide
```

Agents should call `omatic_usage_guide` at the start of a new project/thread,
then `omatic_resolve_factory` before DB work. For startup, use
`omatic_factory_startup_run`. For memory retrieval, use
`omatic_search_memory` with `mode=auto` unless strict behavior is needed.

`omatic_search_memory` supports:

- `mode=auto` — generate a query embedding when credentials are available,
  pass it into `fn_search_semantic` / `fn_search_documents`, and fall back to
  FTS with `NULL::vector` otherwise.
- `mode=hybrid` — require pgvector hybrid retrieval; fail clearly if no query
  vector can be produced.
- `mode=fts` — intentionally use FTS fallback.
- `embedding_vector` — caller-supplied vector for hosts that already provide
  embeddings.

Embedding credentials are read from `OPENAI_API_KEY`,
`OMATIC_OPENAI_API_KEY`, or DB-owned `factory_config` embedding rows. Status
output redacts secret-looking values.

---

## Verify after install

```
omatic_resolve_factory
```

Expect `factory_file` pointing at your project's `.omatic/factory.json` and `active_connection` matching its `factory_id`. Then run `o-matic-server-{factory}:execute_sql` with `SELECT 1` to confirm the connection is live.

---

## Changelog

- **2.1.4** — honest startup warm-retrieval probe.
  - `omatic_factory_startup_run` now generates a query embedding for `brain_warm` and runs the **hybrid pgvector** path (`fn_search_semantic($1, $2::vector, ...)`) instead of `NULL::vector` FTS-only. The probe previously reported a green warm result while silently exercising the weak path, so a semantically-relevant brain could read as 0 hits at startup (false assurance).
  - `brain_warm` payload and the `brain_search` session-log event now surface the actual `mode` (`hybrid_pgvector` vs `fts_with_null_vector`) so a green light means the real retrieval path ran. Falls back to FTS-only if no embedding key is configured.
  - Bumped marketplace, Claude, Codex, runtime, package, and agent-pack versions to `2.1.4`.
- **2.1.1** — version-aware bundled skill sync.
  - Added `scripts/sync-bundled-skills.mjs` so bundled plugin skills install only when missing or older and skip installed current/newer versions.
  - Bumped marketplace, Claude, Codex, runtime, package, and agent-pack versions to `2.1.1`.
- **2.1.0** — connector-native usage guidance and pgvector hybrid retrieval.
  - Added MCP server initialization instructions and `omatic_usage_guide` so LLM hosts know startup, factory resolution, retrieval, and SQL safety flows before picking tools.
  - `omatic_search_memory` now supports `mode=auto|hybrid|fts`, generated OpenAI-compatible query embeddings, caller-supplied vectors, and pgvector hybrid calls into `fn_search_semantic` / `fn_search_documents`.
  - `omatic_embedding_status` now redacts secret-looking config values and reports pgvector extension, HNSW, and GIN readiness explicitly.
  - Bumped marketplace, Claude, Codex, runtime, package, and agent-pack versions to `2.1.0` so plugin hosts see a real update.
- **2.0.0** — lucidIT LLC marketplace cutover and universal compatibility metadata.
  - Marketplace name standardized to `lucidIT-LLC`.
  - Added `agent-pack.json`, adapter docs, and prompt/Modelfile helpers for prompt-only hosts.
  - Server package metadata and MCP runtime identity aligned to plugin version `2.0.0`.
- **1.4.1** — Published to `lucidIT-LLC/o-matic-server-connection` (repo renamed from `o-matic-server-plugin`).
  - **Renamed** `omatic-server` → `omatic-server-connection` across package id, MCP server registration, the generic skill, and marketplace. The plugin is the *connection*; `lucidIT-LLC/o-matic-server` is the DB image distro.
  - **Strict project-root resolver retained** (rule 259, from 1.4.0 — "no walk-up / not stuck on the first DB"). Merged with the local improvements rather than overwritten.
  - **Codex `.mcp.json` fix** — uses the spec `mcp_servers` key (was `mcpServers`; Codex silently failed to register the connector).
  - **Kernel skills regenerated** from the persona gold records: Probot 14.1, Fred 9.1, Data 5.0 (friendly-android character) — each SKILL.md stamped with its `identity_signature`.
  - Net: one plugin installs **skills + connector on both Claude Code and Codex**.
- **1.3.4** — Codex connector fix + kernel skill regeneration.
  - **`.mcp.json` now uses the Codex-spec `mcp_servers` key** (was `mcpServers`, the Claude convention). Per the OpenAI Codex plugin spec, `.mcp.json` accepts only a direct server map or a `mcp_servers` wrapper — with `mcpServers`, Codex silently failed to register the connector. Skills loaded; the connector did not.
  - **Kernel skills regenerated from the persona gold records** (factory brain): Probot 14.1.0, Fred 9.1.0, Data 5.0.0 (character replacement — friendly affable android). Each SKILL.md header now carries its `identity_signature` for drift detection.
  - Legacy physical kernel duplicates retired; the DB gold record plus installed plugin skills are the canonical source and shipped export.
- **1.3.2** — Multi-platform startup hardening.
  - Codex manifest now passes workspace-derived `OMATIC_PROJECT_ROOT` and `OMATIC_FACTORY_JSON_PATH` when host variables are available.
  - Claude Code manifest no longer hardcodes the O-Matic project path, database URL, or Cowork platform. It uses `${CLAUDE_PROJECT_DIR}` and `OMATIC_PLATFORM=claude-code`.
  - Resolver checks multiple host workspace variables before falling back to plugin CWD and reports resolution diagnostics in `omatic_resolve_factory`.
  - Added `omatic_factory_startup_run` to create a platform-specific session, seed `session_mcp_status`, record built-in probe results, warm retrieval, and return `v_mcp_readiness_by_session` in one call.
- **1.3.1** — Hotfix on top of 1.3.0 (post-Smith audit).
  - **Defensive `${VAR}` literal detection** in `connections.js`. If a host runtime (Cowork .mcpb in some versions, certain Codex installs) fails to expand `${CLAUDE_PROJECT_DIR}` or other manifest env vars, the literal string is now treated as unset and the plugin falls back to `process.cwd()` instead of resolving to a dead path like `outputs/${CLAUDE_PROJECT_DIR}/.omatic/factory.json`.
  - **Platform precedence corrected.** `OMATIC_PLATFORM` env var now wins over `factory.json` `platform_profile`. Stale `platform_profile: "codex"` values in a shared factory.json no longer override the live surface.
  - **`ConnectionManager.reload()`.** `omatic_add_connection` and `omatic_remove_connection` now call `reload()` on the live ConnectionManager — invalidates stale pools, picks up new configs from disk, drops removed connections. The previous behavior was a no-op for the running session (false affordance Smith correctly flagged).
  - **Schema fixes:**
    - `omatic_record_session_event`: targets the actual `session_log` columns `(session_date, session_id varchar, platform, agent, event_type, detail text)`. Accepts `detail` (preferred) or `content` (legacy alias); object → JSON string. `session_id` coerced to varchar.
    - `omatic_record_probe_result`: correct arg order for `fn_record_probe_result(p_connector_id, p_session_id, p_result, p_note)` and `p_note` is text, not jsonb. Accepts `note` (preferred) or `detail` (legacy alias).
- **1.3.0** — Multi-factory rewrite.
  - **A1**: Claude Code manifest now sets `OMATIC_PROJECT_ROOT=${CLAUDE_PROJECT_DIR}` (was `${CLAUDE_PLUGIN_ROOT}`, which pointed the plugin at its own install dir and broke walk-up discovery). Codex unchanged — its CWD already resolves to the project root.
  - **A2**: Server declares `capabilities.tools.listChanged: true` and emits `notifications/tools/list_changed` after add/remove/set_active. Claude Code 2.1.0+ refreshes its tool list automatically — no restart needed.
  - **A3**: New `omatic_set_active_connection` tool switches the session's active connection without restart. Between-task only.
  - **A4**: Per-connection variants of base tools (`omatic_factory_startup:selife`, `omatic_execute_sql:thenest`, etc.) pin calls to a specific configured connection regardless of active default. Unsuffixed names still hit the default.
  - **A5**: Cowork `.mcpb` extension and Claude Code / Codex plugin now share one source. `omatic-server-connection/{connections,tools,index}.js` are copies of `plugins/omatic-server/server/*`. No more drift.
  - **A6**: Cowork extension gains a `factory_json_path` user_config field. Set it to an absolute path to an existing `.omatic/factory.json` and the extension reads connections from that file, bypassing the Desktop UI fields. Bridge between Cowork and Claude Code / Codex project configs.
  - **A8**: `writeFactoryConfig` now writes atomically (temp file + rename). Prevents lost updates from concurrent worktrees or surfaces.
  - **A9**: Upgrade migration — on first boot after upgrade, if no `.omatic/factory.json` is found AND `OMATIC_DATABASE_URL` env is set (legacy hardcoded fallback), the plugin writes one from the env DSN. Refuses to write into a plugin install dir.
  - **Skills bundled**: Probot v14 (orchestrator), Data v4.0 (analyst + factory DBA), Fred v9.0 (storage + connection CRUD) ship in `skills/`. Cowork `.mcpb` does NOT bundle skills (MCPB spec has no `skills` field) — Cowork operators continue installing the anthropic-skills suite for Probot/Data/Fred.
  - **Governance**: Rule 237 (skills not agents — authored skill prose), rule 238 (plugin distribution boundary — skills bundle with tool surface), rule 239 (plugin bootstrap pointer — never `${CLAUDE_PLUGIN_ROOT}`) persisted to the factory DB.
- **1.2.0** — Added OpenAI Codex plugin manifest, Codex marketplace metadata, Codex skill instructions, and `omatic_embedding_status`.
- **1.1.0** — Packaged as a Claude Code plugin. Server reads `database_url` from per-project `.omatic/factory.json`. Modern `o-matic-server-{factory}` tool name added alongside the legacy `postgres-cabinet-*` alias. Replaces the `claude_desktop_config.json` entry.
