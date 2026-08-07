# Changelog

## 3.5.1 — 2026-08-07

- plugin.json `mcpServers` returns to `command: "node"` with a direct `server/index.js` entry. The `/bin/sh` + `bin/omatic-launch.sh` form (introduced in 3.3.0 for #143) is refused by the claude.ai marketplace ingest, which silently keeps the last accepted bundle — Claude Desktop/Cowork was pinned at 3.2.0 while 3.3.0–3.5.0 shipped. Hosts that consume plugin.json manage their own Node runtime, so the bare interpreter name is resolvable there; the shell launcher and degraded advisory server remain in `bin/` and continue to back the `.mcpb` (`manifest.json`) path, where the GUI-PATH defect (KB-0418 defect A) actually lives.
- `manifest.json` version was stranded at 3.3.0 — now aligned and added to `scripts/version-sources.json` so the rule #287 gate sees it.

## 3.4.1 - 2026-08-07

Follow-up to 3.4.0's TLS change. Makes a stale install visible and a failed TLS
connection actionable — the two ways 3.4.0 could look "not working" without
saying why.

### Added
- **Running-version visibility.** The startup packet (`omatic_factory_startup_run`)
  and `omatic_usage_guide` now report a `plugin` block: the version this MCP
  process is actually running, and — best-effort on Claude Code — whether a newer
  version is installed on disk and pending a host restart. The host loads an MCP
  server at process start and never hot-reloads it, so `plugin update` writes the
  new version to disk while the live session keeps serving the old code. Nothing
  surfaced this before, so "I updated and nothing changed" was indistinguishable
  from a no-op. `restart_pending: true` names the gap and says to fully restart.

### Changed
- **`verify-full` connection failures are now actionable.** When a connect fails
  under a verifying `ssl_mode` (the 3.4.0 default), the error names the mode,
  flags when the mode was *defaulted* (no `ssl_mode` set on the connection), and
  lists the concrete fixes — set an explicit `ssl_mode`, point `ssl_root_cert` at
  a CA bundle, or present a matching certificate — instead of surfacing a bare
  `unable to verify the first certificate`. Non-TLS failures pass through
  unchanged.

### Fixed
- **Runtime version no longer drifts.** `server/index.js` carried a hardcoded
  `PLUGIN_VERSION` literal that had to be bumped by hand; it is now a
  version-align-gated source (rule #287) so CI fails if it disagrees with the
  canonical catalog.
- Corrected a stale comment in `connections.js` that still described an absent
  `ssl_mode` as defaulting to libpq `prefer`; it defaults to `verify-full` and
  fails closed.

### Not a bug
- The codex-flavored root `.mcp.json` (`OMATIC_PLATFORM=codex`, `${CODEX_WORKSPACE}`)
  is the Codex plugin's config, referenced by `.codex-plugin/plugin.json`; Claude
  Code uses the inline `.claude-plugin/plugin.json`. Both are correct — left as-is.

## 3.4.0 - 2026-08-07

Two connection-correctness fixes, found while migrating the O-Matic factory
database to TLS. 4.0 is reserved for the on-device embedding migration.

### Changed
- **`ssl_mode` now defaults to `verify-full`, not `prefer`.** The documented
  default and the real one disagreed: three tool descriptions advertised
  "Defaults to require" while `connections.js` read
  `const DEFAULT_SSL_MODE = "prefer"`, and `sslAttemptsFor("prefer")` returns
  `[encrypted, plaintext]` — TLS first, **silent fallback to plaintext**. A
  connection that cannot say which one it used cannot be attested to in an
  audit, which is the same class of defect as the unfalsifiable success this
  connector was rebuilt to remove (decision #226): it reports a working
  connection while quietly delivering less than was asked for.

  A **fourth** hardcoded default lived in `tools.js`
  (`String(args.ssl_mode || "require")`), so which default applied depended on
  which code path built the connection. Its own comment called `require` "the
  secure default" — `require` encrypts and validates *nothing*, so it stops
  passive capture and does not stop server impersonation. `tools.js` now imports
  `DEFAULT_SSL_MODE`; there is one source of truth.

  This **fails closed**: a connection entry with no `ssl_mode` against a server
  with no TLS now fails instead of silently running plaintext. Only entries with
  an **absent** `ssl_mode` change behavior — every explicit mode is honored
  unchanged, so no existing factory breaks on upgrade. Required by Blueprint
  KB-0051 v1.9.0 §9, and free in practice: factory databases sit behind a
  publicly-trusted certificate, so `verify-full` needs no private CA, no root
  distribution and no pinning.

  All three `ssl_mode` descriptions were rewritten. They listed only
  `disable, require, verify-ca, verify-full` while `VALID_SSL_MODES` also
  accepts `allow` and `prefer` — the two silent-downgrade modes were
  undocumented but reachable.

### Fixed
- **The embedding credential is read from the active factory, never from the
  pinned connection.** Both sites that generate a query embedding —
  `omatic_search_memory` and the `omatic_factory_startup_run` brain-warm —
  passed `explicitConnection` to the `factory_config` lookup, so a **pinned**
  query went hunting for `factory_config` inside the *target* database.

  `factory_commons` has no `factory_config` **by design**: O-Matic decision #230
  explicitly rejected putting a live OpenAI credential in a database that every
  factory reads through its `kb` connection, because that grants key access to
  every tenant including client and personal factories, and creates N copies to
  rotate. The contract it adopted instead is that the **session supplies the
  query vector** — `fn_search_semantic` / `fn_search_documents` take
  `p_query_vector` as a parameter, so the target never needs a credential at all.

  The effect was not an error. Every natural-language query against commons fell
  back to FTS-only and returned `vec_distance = 1` on every hit, so commons
  reported healthy while being **semantically blind** — the failure behind
  O-Matic task #138, open since 2026-08-02. `tenantId` was already
  `project.factory_id` (the active factory), so only the connection argument was
  ever wrong. Both sites now route through one `embeddingCredentialRows()`
  helper that takes no connection argument, so they cannot drift apart again.

  `omatic_embedding_status` deliberately still reads the **target**: "this
  database has no `factory_config`" is a true fact about that database and the
  diagnostic should report it.

## 3.3.0 - 2026-08-04

### Added
- **The plugin can no longer fail silently when its runtime is absent** (task #143,
  rule #284). The manifest now spawns `/bin/sh bin/omatic-launch.sh` instead of a
  bare `node`. The launcher resolves an interpreter from `OMATIC_NODE`, `PATH`,
  and the absolute locations a GUI-launched host cannot see (Homebrew,
  `/usr/local`, `~/.local/bin`, nvm, fnm, volta, asdf), then execs the real
  server unchanged.

  When no usable runtime exists it execs `bin/omatic-degraded-server.sh` —
  **advisory mode** — a dependency-free POSIX-sh MCP server that completes the
  handshake and publishes exactly one tool, `omatic_runtime_status`, whose
  description names the cause. The tool surface is never zero, so the failure is
  loud instead of being indistinguishable from an unresolved factory.

  Rule #284 required a compatibility tier and nothing verified it, because the
  check everyone reached for lived in `server/index.js` — which is Node, and so
  cannot run in the case it was meant to detect. Detection had to move below the
  runtime. Cost of the unfixed version: one full session (KB-0417), including a
  proposed 93 MB download for an interpreter already on the machine.

- `omatic_runtime_status`, published in **both** modes. In advisory mode it is
  the only tool; in normal mode it reports the measured runtime and returns
  `mode: "full"`. Classified `meta`, so a `read_only` or `disabled` connection
  can still be diagnosed. Tool surface 36 -> 37.

- `usage_guide.runtime` — Node version, minimum, whether the launcher resolved
  an interpreter the host's PATH could not. Measured from the running process,
  next to the `platform_support` block that is only declared.

- `scripts/smoke-runtime-degrade.mjs`, wired into `npm run check`. Drives the
  launcher through both outcomes and asserts the failing one is loud —
  FA-2026-01 Step 6. `OMATIC_FORCE_NO_RUNTIME=1` reproduces advisory mode on a
  working machine, which is the only way this path is reachable in a test.

### Changed
- `smoke-codex-plugin.mjs` required `command === "node"`, which enforced the
  exact defect KB-0418 names. It now requires an absolute command and the
  launcher in `args` — strictly stronger than the assertion it replaces.
- Probot's skill gains an advisory-mode branch: a surface of only
  `omatic_runtime_status` means the runtime failed to resolve, not that the
  database, network, TLS or credentials are at fault. Report the cause and stop.
- The launcher lifts the version out of `package.json` with `sed` and hands it to
  the advisory server, which cannot read JSON without the runtime it is reporting
  missing. A literal there would be a second source of truth (KB-0414 Step 5);
  a smoke assertion proves the relay has not drifted.

### Fixed
- **Embedder config resolution**, recovered from `beta` where it had been
  stranded since 2026-06-28 and never reached the 3.x line. `getEmbeddingConfig`
  falls back from `factory.factory_config` to `factory.config` on `42P01`, so a
  factory on the older kernel layout can still find its embedding credentials;
  config values that arrive as JSON strings are decoded; and a value of the form
  `factory.secrets:<key>` is resolved out of `factory.secrets` at read time.

- `resolveSecretPointer` no longer crashes the Embedder on a factory that holds
  a `factory.secrets:` pointer but has no `factory.secrets` table. It guards
  `42P01` the way `getEmbeddingConfig` already did and returns null, letting the
  caller fall through to `OPENAI_API_KEY` and report a missing credential.
  Verified by probe against a live factory with no such table: the branch threw
  before the guard and returns null after it.

### Known gaps
- POSIX hosts only. A Windows host has no `/bin/sh`, needs its own launcher, and
  is not claimed here — rule #284 cuts both ways.
- `server/embedder-worker.js` executes on require — it has no main guard — so
  importing it for inspection runs the worker. Not changed here; noted because
  it is surprising.

## 3.2.0 - 2026-08-02

### Changed
- **The read-only tools leave `tools/list` for clients that can read Resources**
  (punchlist B13). `omatic_usage_guide`, `omatic_list_connections` and
  `omatic_embedding_status` are published as Resources in 3.1.0; on a client that
  has actually called `resources/list` they are removed from the tool list and a
  `tools/list_changed` notification asks the host to refresh. **30 tools → 27.**
  A client that never reads Resources keeps all 30, because for that host the
  alternative does not exist. All three remain **callable by name either way** —
  this changes what is advertised, not what is dispatched.
  `omatic_resolve_factory` is exempt: rule #288 names it at halt level.

  The obvious implementation — read the client's declared capabilities — is
  impossible. `resources` is a **server** capability; clients declare `roots`,
  `sampling` and `elicitation`, and there is no client-side "I can read
  resources" flag. Asking for one returns `{}` on every client, which would have
  meant "cut nothing, ever" while looking like a working feature. Behavior is the
  only honest signal available.

- **The compatibility tier now separates verified from expected** (punchlist B9).
  `cowork-with-mcp-config` sat in one list beside `claude-code` and `codex`,
  reading as equally proven. It is not: Cowork's lifecycle, cwd and
  `list_changed` behavior have no public documentation, and what is held about
  them internally is telemetry, not a test. `platform_support` now reports
  `verified` and `expected_untested` separately, each with the evidence behind
  it. Rule #284 forbids claiming a capability that has not been demonstrated —
  the claim is not withdrawn, it is labelled.

## 3.1.1 - 2026-08-02

### Changed
- **The operating-guide skill is renamed `omatic-server-operating-guide`.** It was
  called `omatic-server-connection` — the same name as the MCP connector — so
  host plugin pages listed "Omatic Server Connection" under **Skills**, directly
  beneath the identically named entry under **MCP servers**, making the connector
  look like it was filed as a skill. It was the only skill in this plugin named
  after the package rather than its role; every other one (`data-o-matic-data`,
  `orch-o-matic-probot`, `find-o-matic-fred`, `embed-o-matic-embedder`) is named
  for what it does. The connector is the thing that connects; this is the guide
  that explains how to drive it.
- Invocation changes from `omatic-server-connection:omatic-server-connection` to
  `omatic-server-connection:omatic-server-operating-guide`. No other content
  changed.

## 3.1.0 - 2026-08-02

### Added
- **Resources and Prompts — the server now declares all three MCP primitives.**
  Through 3.0.1 it declared only `tools`, so every read-only surface had to be an
  action the model chose to call. Five resources (`omatic://usage-guide`,
  `omatic://factory`, `omatic://connections`, `omatic://tasks`,
  `omatic://embedding-status`) and four prompts (`start-the-factory`,
  `factory-health-check`, `diagnose-a-connection`, `explain-embedding-status`).
  Resources delegate to the same handlers the tools use, so the
  `outcome` / `degraded_reasons` / `results_trustworthy` envelope is inherited,
  not reimplemented.

### Changed
- **Published measured baselines rather than adjectives** (punchlist J4): 5,834
  lines, 30 tools, 5 resources, 4 prompts, 0.11 s cold start. The line count went
  up, and the notes say so.

### Not changed, deliberately
- The read-only tools remain. Removing them is the cheap way to cut the tool
  count, but `CLAUDE.md`, the Probot skill and six other factories name them
  directly, and 3.0.0 already broke the tool surface once. Staged for the next
  major.

## 3.0.1 - 2026-08-02

Section C — the connection surface. 3.0.0 shipped an honest response envelope
and a cut tool surface; the connections themselves were still the one part an
operator could not see, test, or control from inside a session.

Additive. No breaking changes, no changes to the tier model or the doctrine.
Existing `.omatic/factory.json` files behave exactly as before.

### Added

- **`omatic_test_connection`** — try a host, port, database, user, password and
  ssl_mode and report what actually happened. Saves nothing, mutates no stored
  config. Also re-tests an existing connection by name, optionally overriding a
  single field (a new password) for that test only. A failed test returns the
  server's own error text and is reported as a failure, not as a clean envelope.
- **`omatic_edit_connection`** — change one or more fields on an existing
  connection. Merges over what is on disk, so fixing a password no longer means
  re-sending host, port, database and user. The merged result is test-connected
  before anything is written; a failed test leaves the stored connection
  untouched. Changed fields are reported by name; a password change is named,
  never shown.
- **Per-connection permissions** — `read_write` (default), `read_only`, or
  `disabled`, stored in `factory.json` beside host and user and settable via
  `omatic_edit_connection`. Enforced at the tool layer in one chokepoint, for
  every tool and every pinned variant, before any handler runs and before any
  pool opens. There is no argument, flag or alias that bypasses it —
  `confirm_destructive` is the operator approving a destructive statement, not
  the operator overriding a connection's mode. An unclassified tool is treated
  as a write: the guard fails closed. A `read_only` pool additionally runs with
  `default_transaction_read_only=on`, so the database refuses writes too.

### Changed

- **`omatic_list_connections` reports live state.** Per connection: reachability
  measured by that call, the negotiated TLS state (protocol, cipher, authorized
  — the D9 `TLSSocket` readback, previously computed and never surfaced), and
  the permission. Configured and negotiated are separate fields; an unreachable
  connection carries the real Postgres error and marks the response `degraded`.
- **The password is no longer returned in any form.** The listing previously
  emitted `password: "***"`. That slot is now `password_configured`, a boolean
  about presence that says nothing about the secret including its length. Every
  response in this surface passes a credential assertion on the way out.
- **`omatic_add_connection` reports the write it proved.** A failed probe now
  returns the raw Postgres error in a dedicated `postgres_error` field alongside
  `wrote: false`, and successful writes are read back from disk before
  `persisted: true` is reported. `test: false` still stages a connection to a
  down host, but the response is `degraded` with the reason "has never been
  proven to connect" — it can no longer come back clean.
- **The unresolved-factory error (B4) names the connection surface.** An
  operator with no factory configured is told how to see, test, add, fix and
  remove connections, not only how to pin a factory.
- **`omatic_usage_guide` reports the real plugin version.** It had returned a
  hardcoded `2.1.0` through all of 3.0. It now reads the manifest, which
  `version-align.mjs` keeps in step with the canonical catalog entry.
- Tool surface: **34 → 36** (21 base + 15 pinned). No pinned variants are added.

### Tests

Smoke suite **247 → 659 assertions**, run by CI on every push. Covers the
credential guard, configured-vs-negotiated separation, merge semantics,
probe-target resolution, every write path against a real temp-dir
`factory.json` with an injected probe (so "writes nothing on failure" is proven
by reading the file), all three permission modes, and the bypass attempts —
`confirm_destructive`, CTE-hidden writes, batched writes, `SELECT … INTO`,
`SELECT … FOR UPDATE`, and pinned-versus-unsuffixed parity.

## 3.0.0 - 2026-08-02

**Operator-facing notes: see [`RELEASE-NOTES-3.0.0.md`](RELEASE-NOTES-3.0.0.md).**
Read them before upgrading — one item is a correctness warning about 2.2.1, and
one is a breaking change.

### The headline

**Every install on 2.2.1 or earlier reports success on failed reads.**
`omatic_factory_health_check` returned `success: true` with all five of its
startup views erroring, while printing `Brain: clean`. `optionalQuery` degraded a
query exception to an empty array, nothing downstream was obliged to check that a
read had happened, and a view reducing an empty array printed `0`, `clean` and
`OK`. Fast-wake printed GREEN on a total database blackout. Any decision taken on
a green health check from 2.2.1 or earlier may rest on a fabricated number.

### BREAKING

- **The tool surface is cut from 99 tools to 34** (19 base + 15 pinned). **Ten
  pinned tool families are removed** and now return an unknown-tool error:
  `o-matic-server-{factory}:execute_sql`,
  `postgres-cabinet-{factory}:execute_sql`, and the `{connection}`-suffixed
  variants of `omatic_factory_startup`, `omatic_factory_startup_run`,
  `omatic_factory_health_check`, `omatic_embedding_status`, `omatic_usage_guide`,
  `omatic_resolve_factory`, `omatic_record_decision` /
  `omatic_record_session_event` / `omatic_record_probe_result`, and
  `omatic_claim_work` / `omatic_release_work`.
  **Migration:** `omatic_set_active_connection` (between tasks, not mid-flow),
  or `omatic_select_factory` to move the whole session. Three pinned families
  survive unchanged: `omatic_execute_sql`, `omatic_search_memory`,
  `omatic_list_tasks`.
- **Codex operators must restart the MCP server deliberately.** Codex has no
  plugin or marketplace concept — nothing detects a version and nothing ever
  prompts. It also ignores `notifications/tools/list_changed`, so a running
  session keeps calling its cached 99-tool list. Claude Code picks the new
  catalog up on a background refresh and switches over with `/reload-plugins`,
  with no app restart and no reinstall.
- **`guardDestructive` is deleted as a parameter, not defaulted.** The removed
  raw `execute_sql` aliases passed exactly that argument, and were the one path
  by which a `DELETE` reached the database without `confirm_destructive=true`.

### Security

- **D5 — a hostname prefix was silently disabling TLS.** Removed
  `hostname.startsWith("100.") ? "disable" : "require"` from all three sites. It
  intended to detect Tailscale CGNAT (`100.64.0.0/10`) but the prefix also
  matches `100.0.x`–`100.63.x`, which is routable public internet — so
  encryption was being turned off on a guess that was wrong on its own terms,
  with nothing logged. **D6** — transport security is configuration, never
  inference; no network topology appears in code, defaults, or error messages.
- **All 7 dependency advisories resolved — 2 high, 4 moderate, 1 low → 0.**
  `@modelcontextprotocol/sdk` raised to `^1.30.0`; no `--force`, no `overrides`,
  no pinned resolutions. `npm audit` reports 0 vulnerabilities.

### Added

- **A1–A4, A9 — the response envelope.** Every response carries `outcome`
  (`complete` | `degraded` | `failed` | `no_op`), `degraded_reasons`,
  `no_op_reasons`, and `results_trustworthy`. An `OutcomeCollector` scoped
  through `AsyncLocalStorage` records every query failure, so `successResponse`
  can no longer emit a clean result on its own authority. Reserved envelope keys
  are stripped from handler-supplied data, so a handler cannot spoof
  `complete`. `complete` coexisting with a non-empty `degraded_reasons` throws
  rather than returning a comfortable lie. `outcome: "failed"` sets `isError`.
- **A9 — `no_op` as a distinct fourth state,** with its own reason channel.
  `omatic_release_work` releasing a claim you do not hold is no longer
  indistinguishable from a real release. `results_trustworthy` stays true: the
  zero was measured cleanly and is the answer. Precedence is
  `failed` > `degraded` > `no_op` > `complete`.
- **B1 — the factory selection persists across process restarts.**
  `omatic_select_factory` built a throwaway env object and dropped it, so the
  choice died with the process — the direct cause of the Cowork sessions where
  an operator re-selected the same factory eight or more times. It now mutates
  `process.env` and writes to durable per-plugin state
  (`OMATIC_STATE_DIR` → `${CLAUDE_PLUGIN_DATA}` → `${XDG_STATE_HOME}` →
  `~/.omatic/state` → tmp), restored at startup. Only paths are stored; no
  credentials reach the state file.
- **D9** — negotiated TLS is reported separately from configured intent.
  `ssl_mode_configured` and `ssl_negotiated`, plus protocol, cipher and
  `authorized`, read off the real `TLSSocket`.
- Optional `ssl_root_cert` on a connection entry, supplying the CA bundle for
  `verify-ca` / `verify-full`.
- **A12** — a `VIEW_COLUMNS` contract. Formatters resolve only declared columns;
  an undeclared column throws instead of rendering a plausible fallback.

### Fixed

- **A13 — `omatic_factory_health_check` is no longer a cosmetic alias.** It has a
  real handler that inherits the outcome machinery, declares
  `checks_attempted`, and renders `HEALTHY | DEGRADED | FAILED`.
- **A17 — views may not manufacture facts.** Every derived field is gated on the
  query behind it; a field whose source failed renders `UNKNOWN`, never `clean`,
  `OK`, `GREEN` or `0`. The full view names each unreadable source. Fast-wake
  suppresses the GREEN verdict entirely when any source is unreadable.
- **A15 — probe honesty.** The built-in startup probe was a static literal
  declaring `status: "connected"` and "database query path verified", assembled
  before anything was inspected — a dead readiness seed still produced a green,
  authoritative row. Status now derives from the two operations actually
  executed; a reachable database with a failed seed reports `degraded`.
- **A14** — cached probe verdicts are no longer restamped as freshly measured. A
  50-day-old result was being reported as measured this session.
- **A6** — caller-supplied `probes[]` are echoed back as `caller_asserted` with
  `recorded: false` and never reach `fn_record_probe_result`. Only the plugin's
  own measured probe is promoted.
- **B8 — 22 tool names were being silently truncated and hashed by Codex; now
  zero.** Codex folds names to `mcp__<server>__<tool>` and enforces 64 bytes,
  truncating and appending a hash with no error. The builder now measures every
  name against the budget, omits a pinned variant that would overflow rather
  than emitting it mangled, and discloses the omission on the base tool's
  description.
- **B2** — project-root discovery no longer leans on `process.cwd()`, which on
  Codex *is* the plugin install directory. A fallback used to hand back the
  unfiltered candidate list, reinstating the very plugin path it had just
  rejected. `cwd` is now the last candidate and never a rescue path. Still no
  walk-up (rule #259).
- **B3** — `${CODEX_WORKSPACE}`-derived roots are bound at spawn and have been
  observed pointing at a different project. They are now rejected unless the
  file exists, and always rank below the operator's persisted selection.
- **B4** — the unresolved-factory error named the wrong problem ("No O-Matic
  Server connection is configured for this project" — the connections were
  fine). It now lists every root tried in precedence order with the reason each
  was rejected, the no-walk-up rule, and the recovery call.
- **D7/D8 — `sslmode` now has real libpq semantics.** `pg` does not implement
  them: without `uselibpqcompat`, `prefer` / `require` / `verify-ca` all collapse
  into `verify-full`, `allow` is unhandled, and there is no plaintext fallback.
  All six modes are mapped explicitly with a negotiation ladder, so `prefer` and
  `allow` genuinely fall back — and only when the negotiation itself is refused.
  A bad password, unknown database or timeout surfaces as itself and never
  silently downgrades. Default is `prefer` when `sslmode` is absent; factories
  setting `disable` explicitly are unaffected.
- **F1** — full-text-only retrieval is reported as `degraded` with a reason
  naming the missing query vector, whether it returns hits or not, and including
  an explicitly requested `mode=fts`. A caller can now distinguish a keyword miss
  from a semantic miss.
- **A11** — `omatic_search_memory` declares its side effect. Its description
  opens with `WRITES ON EVERY CALL` and names the telemetry function and fields.
- Documentation corrected against the tool list the code actually builds:
  `README.md`, `commands/omatic-setup.md` (which still documented the removed
  `100.x` SSL inference), and `skills/orch-o-matic-probot/SKILL.md` (which named
  the wrong third pinned family and loads into every Probot session on every
  host). A doc guard now checks shipped docs against the built tool list, so this
  class of drift cannot return silently.

### Removed

- **J1** — `legacyToolName`, `modernToolName`, `parseLegacyToolName`,
  `RAW_TOOL_PREFIXES`, the raw-SQL tool builders and their dispatch branch.
- **J2** — `ensureFactoryJsonFromEnv()`, which ran on every boot. No shipped
  manifest sets `OMATIC_DATABASE_URL` and no observed factory uses
  `database_url`; it carried its own `process.cwd()` walk and its own
  write-into-a-plugin-directory hazard. `OMATIC_DATABASE_URL` remains a live
  single-connection override in `loadConnections()`.

### Known limits shipped in this release

- **`omatic_embedding_status` undercounts vector indexes.** The index query is
  hardcoded to `schemaname = 'public'`, so a factory whose content lives in
  another schema reports 0 HNSW indexes when it has several. The query succeeds
  and returns no rows, so the outcome machinery correctly reports `complete` —
  a wrong answer, not a detected failure. (#4 A16, open.)
- **Connection management has no operable surface.** No `omatic_test_connection`;
  adds are not tested before saving; `omatic_list_connections` does not report
  live reachability. (#6, open.)
- **`omatic_execute_sql` does not report `no_op`** on a zero-row mutation. Left
  deliberately — a zero-row `SELECT` is legitimately `complete`.
- **`omatic_claim_work` has a suspected uniqueness-key mismatch** between the
  constraint column and the column the INSERT supplies. Unverified against a live
  schema. (#4 A18, open.)
- **A declared parameter may still be silently ignored** rather than rejected in
  handlers outside this release's contract work. (#4 A8, open.)

### Verification

- `scripts/smoke-startup-modes.mjs`: 155 assertions, 0 failures (was 14).
- `npm run check`: codex plugin smoke, `node --check`, server boot — all pass.
- `npm audit`: 0 vulnerabilities.
- Live stdio boot against a real 5-connection factory: 34 tools, `listChanged`
  intact, 0 legacy tools, destructive-SQL guard holds.
- New assertions were mutation-tested: reverting the `release_work` no-op wiring
  fails 3, hard-wiring the probe back to `"connected"` fails 7, planting a false
  tool name in the README fails 2.

## 2.1.7 - 2026-06-21

### Fixed
- Claude Code marketplace distribution metadata now explicitly includes
  Embedder in marketplace/plugin descriptions.
- Release is tagged as `omatic-server-connection-v2.1.7` so marketplace
  updaters that rely on Git tags can detect the new plugin release.

## 2.1.6 - 2026-06-21

### Added
- `server/embedder-worker.js`, a plugin-shipped background worker for admitted
  stale/unembedded Tier 1 `brain.semantic_index` and Tier 2
  `brain.document_chunks` rows.
- Embedder skill contract, making embeddings an operational service over
  governed memory rather than a truth/admission layer.

## 2.1.5 — 2026-06-15

### Fixed
- `omatic_record_decision` failed with a NOT NULL violation on `category` and
  `title` (both required by the `decisions` table, no DB default). The tool now
  accepts optional `category` (default `general`) and `title` (default: a
  truncation of `decision`), sets `decision_date = CURRENT_DATE`, and maps the
  `owner` arg to `made_by`. Clarified that the `decisions` table has no `status`
  column — the `status` param is accepted for compatibility and ignored.

## 2.1.4

- Prior release.
