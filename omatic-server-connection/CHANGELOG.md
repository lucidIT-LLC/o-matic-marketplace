# Changelog

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
