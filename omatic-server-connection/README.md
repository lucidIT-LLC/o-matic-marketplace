# O-Matic Server Connection (MCP Plugin + Bundled Skills)

> **What this is:** the plugin that connects Claude Code and Codex to an O-Matic Server, and ships the Probot, Fred, Data, and Embedder skills.
> **What this is NOT:** a database. It bundles no PostgreSQL and no pgvector — it's the wire and the crew, not the brain.
> The brain it connects to lives in **[o-matic-server](https://github.com/lucidIT-LLC/o-matic-server)**.

The connection layer for an O-Matic factory, packaged for MCP-capable hosts such as Claude Code and OpenAI Codex. Install it once per host and let each factory project route through its own `.omatic/factory.json` to the right O-Matic Server. Ships Probot, Fred, Data, and Embedder as plugin-bundled skills.

**Version:** 2.1.7
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
OMATIC_PROJECT_ROOT=/path/to/factory node server/embedder-worker.js
OMATIC_PROJECT_ROOT=/path/to/factory node server/embedder-worker.js --watch
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
    embed-o-matic-embedder/SKILL.md    # Embedder background worker
    orch-o-matic-probot/SKILL.md   # Probot v14.2 — orchestrator + memory governance
    data-o-matic-data/SKILL.md     # Data v5.1 — analyst, architect + lifecycle health
    find-o-matic-fred/SKILL.md     # Fred v9.2 — storage, provenance + connection CRUD
  server/              # bundled Node MCP server
    index.js
    embedder-worker.js
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
| `omatic_execute_sql` | Guarded SQL — `confirm_destructive=true` required for DDL/DML. **The only SQL path.** The target connection's permission is enforced first and cannot be overridden |
| `omatic_select_factory` | Pin the active factory explicitly by `project_root` or `factory_json_path` |
| `omatic_list_connections` | Every configured connection with **live reachability**, the **negotiated** TLS state, and its **permission**. Passwords are never returned |
| `omatic_test_connection` | Try a host, database, user and password and report what actually happened. Saves nothing, mutates nothing |
| `omatic_add_connection` / `omatic_edit_connection` | Create or change a connection. Both **test-connect before writing**; a failed probe returns the real Postgres error and writes nothing |
| `omatic_remove_connection` | Drop a connection from `.omatic/factory.json` |
| `omatic_set_active_connection` | Switch the session's active connection without restarting |

That is the complete base surface: **21 base tools**, plus **15 pinned variants**
(3 families × 5 configured connections) for a total of **36**.

## The connection surface

The question this answers is "which of my databases actually work, and what is
Claude allowed to do to them" — without leaving the session and without opening
a JSON file.

```
omatic_list_connections {}
```

Returns, per connection: `name`, `host`, `port`, `database`, `user`,
`ssl_mode_configured`, `permission`, and — measured by that call, not read from
config — `reachable`, `latency_ms`, `connected_database`, `connected_user`,
`ssl_negotiated`, `tls_protocol`, `tls_cipher`, `tls_authorized`.

**Configured and negotiated are separate fields.** `ssl_mode_configured` is what
`factory.json` asks for; `ssl_negotiated` and the `tls_*` fields are what the
handshake actually produced. When they disagree, the negotiated ones are true.

**The password is never returned** — not the value, and not a mask standing in
its place. `password_configured` is a boolean about presence and says nothing
about the secret, including its length. Every response in this surface passes a
credential assertion on the way out; a credential-shaped field that holds a
value raises an error instead of shipping.

An unreachable connection carries the real Postgres error and marks the whole
response `degraded` — the listing succeeded, the factory did not.

### Testing before committing

```
omatic_test_connection {
  "host": "cabinet.blue-triggerfish.ts.net",
  "database": "o-matic",
  "user": "o-matic-llm",
  "password": "…",
  "ssl_mode": "disable"
}
```

Nothing is saved and no stored configuration changes. Pass `connection` instead
to re-test an existing connection, optionally overriding a single field (a new
password, say) for that test only. A failed test returns the server's own error
text and is reported as a failure, not as a clean envelope around bad news.

### Writes are proven, not assumed

`omatic_add_connection` and `omatic_edit_connection` both test-connect before
writing. A failed probe returns the raw Postgres error and the file is never
opened — a saved connection that has never connected is the exact lie this
release removes. After a successful write the file is read back and the
response reports `persisted: true` only if the read-back matches.

`omatic_edit_connection` merges over what is on disk, so changing a password
does not require re-sending the host, port, database and user. Changed fields
are reported by name; a password change is named, never shown.

`test: false` remains available for staging a connection to a host that is
currently down, but such a write can never come back clean: the response is
`degraded` with the reason *"has never been proven to connect"*.

### Per-connection permissions

Every connection carries a `permission`, stored in `factory.json` beside the
host and user:

| Permission | Effect |
|---|---|
| `read_write` | Everything works. The default — existing `factory.json` files are unaffected |
| `read_only` | Reads work. Every write, DDL and DML is refused **before it reaches the database** |
| `disabled` | The connection resolves and is listed, but no tool will use it. Visible, deliberately parked |

```
omatic_edit_connection { "name": "benecard", "permission": "read_only" }
```

`benecard` is a client database and `dbadmin` connects as a superuser. Before
this, the only thing preventing a tool writing to either was the model choosing
not to — a rule loaded, not a rule obeyed. The permission is **enforced**, in
one chokepoint, for every tool and every pinned variant, before any handler runs
and before any pool opens:

- There is **no argument, flag or alias that bypasses it.** `confirm_destructive`
  is the operator approving a destructive statement, not the operator overriding
  a connection's mode.
- A tool with no explicit classification is treated as a **write**. The guard
  fails closed.
- Statement classification strips comments and string literals first, and
  catches the cases a leading-keyword check misses: a `DELETE` hidden in a CTE,
  a write batched behind a `SELECT`, `SELECT … INTO`, `SELECT … FOR UPDATE`.
- A `read_only` connection's pool additionally runs with
  `default_transaction_read_only=on`, so if a write ever slipped past the
  classifier PostgreSQL refuses it too.
- A `disabled` connection cannot be made the session default, and
  `ConnectionManager.getPool()` will not open it by any route.

The connection surface itself — list, test, add, edit, remove, set-active —
stays available at every permission level. Locking it behind the mode it manages
would strand the operator with no way back.

A refusal names the connection, the mode, and the tool that was stopped:

> Refused: connection "benecard" is read_only. `omatic_execute_sql` performs a
> write, so it was stopped at the tool layer and never reached the database.
> Reads against this connection still work.

### Pinned per-connection variants

Exactly three base tools accept a `:{connection}` suffix to pin one call to one
configured connection regardless of the session's active default:

| Pinned family | Example |
|---|---|
| `omatic_execute_sql:{connection}` | `omatic_execute_sql:kb` |
| `omatic_search_memory:{connection}` | `omatic_search_memory:kb` |
| `omatic_list_tasks:{connection}` | `omatic_list_tasks:kb` |

Every other tool — including startup, health check, embedding status, and all
the `record_*` writers — follows the **active** connection. Reach another
connection with those by calling `omatic_set_active_connection` first.

A pinned name is only published if it fits the host's tool-name budget. Codex
namespaces tools as `mcp__<server>__<tool>` and silently truncates past 64
bytes, so an over-long connection name would arrive mangled. Such variants are
omitted rather than emitted broken, and the omission is disclosed on the base
tool's own description.

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

Expect `factory_file` pointing at your project's `.omatic/factory.json` and `active_connection` matching its `factory_id`. Then run `omatic_execute_sql` with `SELECT 1` to confirm the connection is live — or `omatic_execute_sql:{connection}` to verify one specific connection.

---

## Changelog

- **3.0.0** — **BREAKING: the tool surface was cut from 99 tools to 34.**

  ### What was removed

  Ten pinned tool families no longer exist. Any call to one of these now fails
  with an unknown-tool error:

  | Removed | Replacement |
  |---|---|
  | `o-matic-server-{factory}:execute_sql` | `omatic_execute_sql` (guarded) |
  | `postgres-cabinet-{factory}:execute_sql` | `omatic_execute_sql` (guarded) |
  | `omatic_factory_startup:{connection}` | `omatic_factory_startup` after `omatic_set_active_connection` |
  | `omatic_factory_startup_run:{connection}` | `omatic_factory_startup_run` after `omatic_set_active_connection` |
  | `omatic_factory_health_check:{connection}` | `omatic_factory_health_check` after `omatic_set_active_connection` |
  | `omatic_embedding_status:{connection}` | `omatic_embedding_status` after `omatic_set_active_connection` |
  | `omatic_usage_guide:{connection}` | `omatic_usage_guide` after `omatic_set_active_connection` |
  | `omatic_resolve_factory:{connection}` | `omatic_resolve_factory` after `omatic_set_active_connection` |
  | `omatic_record_decision:{connection}`, `omatic_record_session_event:{connection}`, `omatic_record_probe_result:{connection}` | the unsuffixed writer after `omatic_set_active_connection` |
  | `omatic_claim_work:{connection}`, `omatic_release_work:{connection}` | the unsuffixed tool after `omatic_set_active_connection` |

  The two raw `execute_sql` aliases were removed for a second reason beyond
  surface size: they invoked the SQL handler with the destructive-SQL guard
  disabled. They were the one door through which `DELETE FROM tasks` reached
  the database without `confirm_destructive=true`. That door is gone, not
  merely defaulted shut.

  **Surviving pinned families — exactly three:** `omatic_execute_sql`,
  `omatic_search_memory`, `omatic_list_tasks`.

  ### Why

  Codex namespaces every MCP tool as `mcp__<server>__<tool>`, folds
  non-alphanumerics to `_`, and enforces a 64-byte ceiling. On overflow it
  **silently** truncates and appends a hash. At 99 tools, 22 of ours were being
  mangled — the model called a name that did not match what we published, and
  two long names could collide into one with nothing logged. A smaller surface
  with disclosed omissions is the fix.

  ### Migration

  Replace a pinned call with two steps:

  ```text
  omatic_set_active_connection { "name": "kb" }
  omatic_factory_health_check
  ```

  For `omatic_execute_sql`, `omatic_search_memory`, and `omatic_list_tasks`
  nothing changes — keep using `omatic_search_memory:kb` directly.

  To pin the whole *factory* rather than a connection, use
  `omatic_select_factory` with an explicit `project_root` or
  `factory_json_path`. Do this before any startup call: the plugin's process
  CWD is host-dependent and is not necessarily your project folder, so an
  unpinned resolve can fail with "No O-Matic Server connection is configured
  for this project."

  `omatic_set_active_connection` is a **between-task** operation. Switching
  mid-flow — during a multi-call startup sequence, say — can produce
  cross-tenant results.

  ### ⚠️ Codex users must restart deliberately

  The server declares `capabilities.tools.listChanged: true` and emits
  `notifications/tools/list_changed`, so **Claude Code 2.1.0+ picks the new
  surface up automatically**.

  **Codex does not.** Codex users are never prompted to update and will keep
  calling the old 99-tool surface from a cached tool list until the MCP server
  is restarted. Nothing warns you; the calls simply fail with unknown-tool
  errors, or worse, resolve against a stale mangled name. **Restart Codex
  deliberately after upgrading to 3.0.** This is not automatic and there is no
  notification.

  ### Also in 3.0

  - **Response layer (#4 A1–A3, A9, F1):** every response carries an `outcome`
    of `complete` | `degraded` | `failed` | `no_op`, plus `degraded_reasons`,
    `no_op_reasons`, `results_trustworthy`, and `trust_level`. A handler can no
    longer emit a clean result once a constituent query has errored, and the
    envelope cannot be spoofed by handler-supplied keys.
  - **`trust_level` (#4 F1):** `results_trustworthy` is a strict boolean meaning
    "nothing about this response was degraded" — true only for `complete` and
    `no_op`. It previously reported true for any degraded call that observed
    rows, so rows returned by one query laundered another query's failure into
    a clean envelope. The gradation a boolean cannot hold now lives beside it:
    `trusted` (complete or no_op), `partial` (degraded, some rows came back —
    read them, but read `degraded_reasons` first), `untrusted` (degraded with
    zero rows, or failed — an empty answer from a broken call carries no
    information).
  - **`no_op` (#4 A9):** zero-row mutations are no longer reported as
    `complete`. `omatic_release_work` releasing a claim you do not hold now
    returns `outcome: "no_op"` — previously indistinguishable from a real
    release. `complete` and a non-empty `degraded_reasons` remain structurally
    unable to coexist.
  - **Probe honesty (#4 A15):** the built-in startup probe derives its status
    from the observed result of the `factory_sessions` INSERT and the readiness
    seed. It previously hard-coded `status: "connected"` and the note
    "database query path verified" before any measurement had been taken, so a
    dead seed still produced a green authoritative row in
    `mcp_registry.probe_status`.
  - **Asserted vs measured probes (#4 A6):** caller-supplied `probes[]` are
    echoed back as `caller_asserted` with `recorded: false` and never reach
    `mcp_registry.probe_status`. Use `omatic_record_probe_result` for a probe
    you actually ran.
  - **Dependencies:** `@modelcontextprotocol/sdk` bumped to `^1.30.0`, clearing
    all 7 open advisories (2 high, 4 moderate, 1 low) in the transitive tree.
    `npm audit` reports 0 vulnerabilities.

- **2.1.7** — Governed memory lifecycle + Embedder worker.
  - Added `server/embedder-worker.js` and the `embed-o-matic-embedder` skill contract. Embedder refreshes vectors for admitted Tier 1/Tier 2 rows only; it does not decide truth, promotion, retirement, contradiction resolution, or authority.
  - Probot 14.2 defines the memory admission gate, lifecycle states, promotion/demotion triggers, contradiction handling, and operator escalation boundaries.
  - Fred 9.2 owns provenance, archives, custody, and safe retention; Data 5.1 owns lifecycle health, stale-vector audit, retired/superseded retrieval checks, and benchmark discipline.
  - Factory blueprint conversion target: adopt SOP-019, lifecycle Policies, Embedder roster/agreement state, and a factory_commons blueprint section before claiming governed operating memory.
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
  - **A4**: Per-connection variants of base tools (`omatic_factory_startup:selife`, `omatic_execute_sql:thenest`, etc.) pin calls to a specific configured connection regardless of active default. Unsuffixed names still hit the default. *(Superseded in 3.0 — the pinned surface is now only `omatic_execute_sql`, `omatic_search_memory`, and `omatic_list_tasks`. See the 3.0 entry above.)*
  - **A5**: Cowork `.mcpb` extension and Claude Code / Codex plugin now share one source. `omatic-server-connection/{connections,tools,index}.js` are copies of `plugins/omatic-server/server/*`. No more drift.
  - **A6**: Cowork extension gains a `factory_json_path` user_config field. Set it to an absolute path to an existing `.omatic/factory.json` and the extension reads connections from that file, bypassing the Desktop UI fields. Bridge between Cowork and Claude Code / Codex project configs.
  - **A8**: `writeFactoryConfig` now writes atomically (temp file + rename). Prevents lost updates from concurrent worktrees or surfaces.
  - **A9**: Upgrade migration — on first boot after upgrade, if no `.omatic/factory.json` is found AND `OMATIC_DATABASE_URL` env is set (legacy hardcoded fallback), the plugin writes one from the env DSN. Refuses to write into a plugin install dir. *(Removed in 3.0 — see J2 below. `OMATIC_DATABASE_URL` still works as a live single-connection override; it just no longer triggers a file write at boot.)*
  - **Skills bundled**: Probot v14 (orchestrator), Data v4.0 (analyst + factory DBA), Fred v9.0 (storage + connection CRUD) ship in `skills/`. Cowork `.mcpb` does NOT bundle skills (MCPB spec has no `skills` field) — Cowork operators continue installing the anthropic-skills suite for Probot/Data/Fred.
  - **Governance**: Rule 237 (skills not agents — authored skill prose), rule 238 (plugin distribution boundary — skills bundle with tool surface), rule 239 (plugin bootstrap pointer — never `${CLAUDE_PLUGIN_ROOT}`) persisted to the factory DB.
- **1.2.0** — Added OpenAI Codex plugin manifest, Codex marketplace metadata, Codex skill instructions, and `omatic_embedding_status`.
- **1.1.0** — Packaged as a Claude Code plugin. Server reads `database_url` from per-project `.omatic/factory.json`. Modern `o-matic-server-{factory}` tool name added alongside the legacy `postgres-cabinet-*` alias. Replaces the `claude_desktop_config.json` entry.
