# O-Matic Server Connection (MCP Plugin + Bundled Skills)

> **What this is:** the plugin that pins a project to its O-Matic factory and ships the Probot, Fred and Data skills.
> **What this is NOT — as of 5.0.0 — a database client.** It holds no credentials, opens no connections and runs no SQL.
> Database access goes through **Conductor**, which holds the keys in the Mac Keychain and serves them over MCP on `https://localhost:8438`.

**Version:** 5.0.0
**Author:** James Walker / O-Matic AI Research Lab

---

## 5.0.0 — read this first if you are upgrading

Through 4.1.0 this plugin carried its own PostgreSQL client. It read credentials
out of `.omatic/factory.json`, opened pools, negotiated TLS, and published 18
tools that ran SQL. **All of that is removed** (decision #283).

Two reasons, both structural:

1. **Credentials in `factory.json` were a credential at rest** on every host that
   opened the project (task #209). Conductor exists precisely so that a
   credential lives in the Keychain and is granted per paired app, never handed
   to the caller.
2. **Two SQL paths meant two enforcement points for one policy.** The plugin's
   destructive-SQL guard and per-connection permissions were a second, parallel
   implementation of what Conductor's grant model already does — and a policy
   enforced in two places is a policy enforced in neither.

The removed tools are **deleted, not deprecated**. Calling one returns
`Unknown tool` and fails closed. There is no stub returning "unsupported": a
stub is a call site with no implementation, and that is the exact defect class
this factory has been removing everywhere else.

| Removed | Use instead |
| --- | --- |
| `omatic_execute_sql` (and every `:name` variant) | Conductor `factory_query` |
| `omatic_search_memory` | Conductor `embed_query` for a vector, then `factory_query` calling `fn_search_semantic` / `fn_search_documents` |
| `omatic_embedding_status` | Conductor `factory_query` against the embedding tables |
| `omatic_factory_startup`, `omatic_factory_startup_run`, `omatic_factory_health_check` | Probot's startup SOP, driven through Conductor `factory_query` |
| `omatic_list_tasks`, `omatic_record_decision`, `omatic_record_session_event`, `omatic_record_probe_result` | Conductor `factory_query` |
| `omatic_claim_work`, `omatic_release_work` | Conductor `factory_query` |
| `omatic_list_connections` | Conductor `connections_list` |
| `omatic_add_connection`, `omatic_edit_connection`, `omatic_remove_connection`, `omatic_test_connection`, `omatic_set_active_connection` | Conductor `connection_propose` / `connection_amend` / `connection_remove` — the operator approves in Conductor's own UI |

---

## Where the databases are now

**Conductor** is a macOS app that holds every factory database credential in the
Mac Keychain and grants them per paired app over MCP on `https://localhost:8438`.

| Call | What it does |
| --- | --- |
| `connections_list` | Which connections this app was granted — and how many exist that it was not. |
| `factory_query` | SQL against a granted connection. Conductor holds the credential; the caller never sees it. Destructive statements refuse unless `confirm_destructive` is true. |
| `embed_query` | A 768-d query vector, on the weights the corpus was embedded under. |

**Conductor's connection names are the operator-facing ones**, and they differ
from this plugin's old internal names:

| Conductor | was |
| --- | --- |
| o-MATIC Home Office | `omatic` |
| Commons | `kb` |
| About Jimmy | `aboutjimmy` |
| Benecard, lucidIT Corp, Practically Adventist, theNest | — |

Two things that are easy to get wrong:

- **Retrieval needs a vector.** `fn_search_semantic` and `fn_search_documents`
  take `p_query_model_version` and refuse a weights mismatch (task #222). Get the
  vector from `embed_query` and pass it. **FTS-only is a reportable degraded
  state, not a normal answer.**
- **A grant refusal is not an empty result.** *"This app was not granted access
  to X"* means the pairing grant is working — the ticket for that project names
  which databases it may reach. Report it as a refusal.

---

## Tools exposed

Four. All of them are filesystem and environment operations; none opens a socket.

| Tool | Purpose |
| --- | --- |
| `omatic_select_factory` | Pin this session to a factory by `project_root` or `factory_json_path`, and persist the choice so the next session restores it. |
| `omatic_resolve_factory` | Report the resolved factory, every candidate root considered and why each was accepted or rejected, and whether `factory.json` still holds pre-5.0.0 connection fields. |
| `omatic_runtime_status` | The measured Node runtime. If this is the *only* tool present, the plugin is in advisory mode and the runtime failed to resolve. |
| `omatic_usage_guide` | What this plugin does, what it no longer does, and where database work goes. |

Also published as MCP **Resources** (`omatic://usage-guide`, `omatic://factory`)
and **Prompts** (`start-the-factory`, `diagnose-factory-resolution`).

---

## Pinning the factory — required on every host

**Do this first, every session, before anything else:**

```
omatic_select_factory(project_root="/absolute/path/to/the/project")
```

This is not optional ceremony. The plugin's process working directory is
**host-dependent and is not the project folder** — on Cowork it is the session
scratch directory, on other hosts the plugin install root. Mounting or
re-selecting the project in the host UI does **not** fix it: the host mount and
the plugin process cwd are independent.

Factory discovery **never walks up the directory tree** (rule #259), so a
`.omatic/factory.json` in a parent folder is deliberately invisible. The project
root itself must contain one.

Verify with `omatic_resolve_factory` before proceeding. If `factory_file` is
`null`, **stop and report** — do not run work against an unresolved factory.

The selection is persisted to a durable state directory and restored on the next
start, so this only needs doing once per project per machine.

### What `.omatic/factory.json` should contain now

Identity only:

```json
{
  "factory_id": "omatic",
  "server_name": "O-Matic",
  "connection_profile": "default"
}
```

**No `database_url`, host, user or password.** Nothing reads them — this plugin
is not a database client and Conductor holds the real credentials in the
Keychain. A credential left there is a credential at rest serving no purpose.

`omatic_resolve_factory` reports a `legacy_connection_fields` block naming the
**keys** of any such leftovers so you know to move them into Conductor and delete
them. Key names only: no value is ever read, returned or logged.

An **empty connection list is correct, not a failure.** As of 2026-08-09 the
O-Matic factory holds zero connections and zero credentials in `factory.json` by
design.

---

## Compatibility model

This package has two layers:

- **MCP tool layer** — `server/index.js` resolves the factory and publishes the
  four tools above. Requires an MCP-capable host such as Claude Code, Codex, or
  a desktop host that launches the server over stdio.
- **Skill prompt layer** — `skills/*/SKILL.md` are canonical prompt contracts.
  They work in Gemini, Ollama, or any generic model host. Those hosts get no
  factory tools, and no database access without Conductor on the same machine.

`agent-pack.json` documents the host-neutral package model. Adapter notes live in
`adapters/`.

Helper scripts:

```bash
node scripts/print-system-prompt.mjs probot
node scripts/build-ollama-modelfile.mjs probot llama3.1:8b > Probot.Modelfile
node scripts/sync-bundled-skills.mjs --dry-run
node scripts/sync-bundled-skills.mjs
# RETIRED — see scripts/_retired/README.md. This script cannot run: it imports
# server/connections.js, deleted in 5.0.0. Draining is Conductor's job now.
```

`sync-bundled-skills.mjs` installs missing bundled skills into
`${CODEX_HOME:-~/.codex}/skills`, updates older installed copies, and skips ones
already the same version or newer.

`scripts/embed-drain.mjs` is **RETIRED** (moved to `scripts/_retired/`, 2026-08-15). It could
not run — it imported `server/connections.js`, deleted in 5.0.0 when the plugin stopped being a
database client, while `npm run check` syntax-checked it and reported green. Draining now runs
inside Conductor on-device. Historically it
talks to the embedding provider named in `factory_config` directly and is
unaffected by this release.

---

## What's inside

```
omatic-server-connection/
  .claude-plugin/plugin.json   # Claude plugin manifest (declares skills/)
  .codex-plugin/plugin.json    # Codex plugin manifest
  manifest.json                # .mcpb desktop-extension manifest
  skills/
    omatic-server-operating-guide/SKILL.md
    orch-o-matic-probot/SKILL.md      # Probot — orchestrator + memory governance
    data-o-matic-data/SKILL.md        # Data — analyst, architect + lifecycle health
    find-o-matic-fred/SKILL.md        # Fred — storage, provenance + workspace
  server/                      # bundled Node MCP server
    index.js                   # transport, capabilities, lifecycle
    factory.js                 # factory resolution + persisted selection
    tools.js                   # the four tools
    resources.js               # Resources + Prompts
    node_modules/              # runtime deps (@modelcontextprotocol/sdk only)
  bin/                         # launcher + advisory-mode fallback server
  scripts/                     # smoke suite, prompt/Modelfile helpers
    _retired/                  # scripts kept for the record; none are runnable
  adapters/                    # host-specific notes
```

**There is no `pg` in `node_modules`.** The database driver and its 13
transitive packages were removed in 5.0.0; the shipped runtime contains no
database client at all. `server/connections.js` is gone — its factory-resolution
half is `server/factory.js`.

---

## Install in Claude Code

1. Add the marketplace: `lucidIT-LLC/o-matic-marketplace`.
2. Install the **omatic-server-connection** plugin.
3. Restart Claude Code — an MCP server is loaded at process start and never hot-reloads.
4. Approve the `omatic-server-connection` MCP server when prompted.
5. Pin the factory: `omatic_select_factory(project_root="/absolute/path")`.

## Install in OpenAI Codex

1. Add the same repository as a Codex plugin marketplace.
2. Install the **omatic-server-connection** plugin.
3. Restart Codex.
4. Pin the factory: `omatic_select_factory(project_root="/absolute/path")`.
5. Verify with `omatic_resolve_factory`.

Fresh machines: `node_modules/` is committed, so the plugin runs immediately
after install. Run `npm ci` inside `server/` only if it is absent.

---

## Verify after install

```
omatic_resolve_factory
```

Expect `factory_id` and a `factory_file` pointing at your project's
`.omatic/factory.json`. If `factory_file` is `null`, pin it with
`omatic_select_factory` and try again.

To verify **database** access — which this plugin does not provide — call
Conductor's `connections_list` and confirm the connections this project's ticket
grants. A `factory_query` returning `SELECT 1` on a granted connection proves the
path end to end.

If `omatic_runtime_status` is the only tool present, the plugin is in advisory
mode: the launcher could not resolve a Node runtime, and even factory resolution
is unavailable. Fix the runtime first.

---

## Tests

```bash
cd omatic-server-connection && npm run check
```

Runs the tool-surface suite, the Codex plugin manifest check, host-platform
detection, and runtime-degradation behaviour. No database and no network.

`scripts/smoke-tool-surface.mjs` guards the negative half of this release: that
no database tool is published, that every removed tool name fails closed while
pointing at Conductor, that no source file requires `pg`, and that rule #259's
no-walk-up rule still holds.

---

## Changelog

See [CHANGELOG.md](./CHANGELOG.md). The 5.0.0 entry lists every removed tool and
its Conductor replacement.
