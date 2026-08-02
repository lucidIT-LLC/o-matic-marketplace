# O-Matic Server Connection 3.0.0 — Release Notes

**Read this before you upgrade.** One section is a correctness warning about the
version you are running right now, and one is a breaking change.

---

## 1. If you are on 2.2.1 or earlier, your connector reports success on failed reads

This is the reason 3.0 exists.

`omatic_factory_health_check` could return `success: true` while **every single
one** of its five startup queries had failed. Not a partial result, not a warning
— a clean report built on nothing.

Here is the real output from 2.2.1, run against a live connection whose startup
views genuinely do not exist:

```
success = true

Factory status: CHECK | 0/0 connectors OK | 0/0 skills READY
Workload: 0 open tasks | none
Brain: clean | stale 0 | unembedded 0
Governance: OK unknown rules | OK unknown combined | 0 active SOPs
```

All five queries errored. The tool said **`Brain: clean`**.

The mechanism was simple and it ran everywhere: a helper caught query exceptions
and turned them into empty arrays. Nothing downstream was required to check
whether a read had actually happened, so a view that reduced an empty array
printed `0`, `clean`, and `OK` — indistinguishable from a healthy factory. The
fast-wake summary printed **GREEN on a total database blackout**.

**What this means for you.** Any decision you or an agent made on the basis of a
green health check, a `0 open tasks` reading, a `stale 0` embedding count, or a
GREEN fast-wake on 2.2.1 or earlier may have been made on a fabricated number.
The connector could not tell you it had failed, so it did not.

**In 3.0** every response carries an explicit `outcome` — `complete`,
`degraded`, `failed`, or `no_op` — with `degraded_reasons`, `no_op_reasons`, and
`results_trustworthy`. A response cannot be marked `complete` once any
constituent query has errored, and a handler cannot fake it: the envelope fields
are stripped from handler-supplied data and the invariant throws rather than
returning a comfortable lie. Any field whose source failed renders `UNKNOWN` —
never `clean`, `OK`, `GREEN`, or `0`. The same check now fails loudly, names all
five broken reads, and sets `isError`.

Zero-row writes are covered too. Releasing a work claim you never held used to be
indistinguishable from releasing a real one. It now returns `outcome: "no_op"`.

---

## 2. Breaking change — the tool surface went from 99 tools to 34

**Ten pinned tool families are gone.** Calls to them now fail with an
unknown-tool error:

| Removed | Replacement |
|---|---|
| `o-matic-server-{factory}:execute_sql` | `omatic_execute_sql` |
| `postgres-cabinet-{factory}:execute_sql` | `omatic_execute_sql` |
| `omatic_factory_startup:{connection}` | `omatic_factory_startup` |
| `omatic_factory_startup_run:{connection}` | `omatic_factory_startup_run` |
| `omatic_factory_health_check:{connection}` | `omatic_factory_health_check` |
| `omatic_embedding_status:{connection}` | `omatic_embedding_status` |
| `omatic_usage_guide:{connection}` | `omatic_usage_guide` |
| `omatic_resolve_factory:{connection}` | `omatic_resolve_factory` |
| `omatic_record_decision:{connection}`, `omatic_record_session_event:{connection}`, `omatic_record_probe_result:{connection}` | the unsuffixed writer |
| `omatic_claim_work:{connection}`, `omatic_release_work:{connection}` | the unsuffixed tool |

**Migration** — set the target first, then call the unsuffixed tool:

```text
omatic_set_active_connection { "name": "kb" }
omatic_factory_health_check
```

To move the whole session to a different factory, use `omatic_select_factory`
with an explicit `project_root`.

`omatic_set_active_connection` is a **between-task** operation. Switching in the
middle of a multi-call sequence can produce cross-tenant results.

**Three pinned families survive** and need no change:
`omatic_execute_sql`, `omatic_search_memory`, `omatic_list_tasks`.

### Why the cut was necessary

Codex namespaces every MCP tool as `mcp__<server>__<tool>` and enforces a 64-byte
ceiling. On overflow it **silently** truncates the name and appends a hash —
no error, no log entry. At 99 tools, **22 of ours were being mangled in
production**. The model was calling names that did not match what we published,
and two long names could fold into one with nothing to notice.

**In 3.0 that count is zero.** The tool builder now measures every name against
the budget, refuses to emit one that would overflow, and discloses the omission
on the base tool's own description rather than shipping a mangled name.

The two raw `execute_sql` aliases were removed for a second reason: they invoked
the SQL handler with the destructive-statement guard **disabled**. They were the
one path by which a `DELETE` reached the database without
`confirm_destructive=true`. That door is removed, not defaulted shut.

---

## 3. How to upgrade — this differs sharply by host

### Claude Code — effectively automatic

Claude Code refreshes the marketplace catalog in the background, notices the new
version, and notifies you. Run:

```text
/reload-plugins
```

The MCP servers switch over in place. **No app restart. No reinstall.**

### Codex — nothing will ever tell you

> ### ⚠️ Codex has no plugin or marketplace concept at all.
>
> There is no catalog refresh. Nothing reads a version number. Nothing compares
> it to anything. **You will never be prompted, notified, or warned — not now,
> not later.**
>
> A Codex operator who does not restart deliberately keeps running the old build
> **forever**, including the 2.2.1 health check described in section 1.

Codex also ignores `notifications/tools/list_changed`, so even a running session
keeps calling its cached 99-tool list. The symptom is unknown-tool errors, or —
worse — a call that resolves against a stale mangled name.

**Restart the MCP server deliberately after upgrading.** This is a manual act and
there is no substitute for it.

---

## 4. Security

### A hostname prefix was silently disabling TLS

The connector decided transport security by looking at the first four characters
of the hostname:

```js
hostname.startsWith("100.") ? "disable" : "require"
```

The intent was to detect Tailscale's CGNAT range and skip TLS on the tailnet.
**The test was wrong on its own terms.** CGNAT is `100.64.0.0/10` — but the
prefix `100.` also matches `100.0.x` through `100.63.x`, which is **routable
public internet**. Any connection to a host in that space had its encryption
silently turned off, with nothing in the logs and nothing in the config to
indicate it.

**This heuristic is deleted from all three sites where it lived.** Transport
security is now configuration, never inference. No network topology appears in
the code, the defaults, or the error messages.

### `sslmode` is now real configuration

All six libpq modes are honoured explicitly:

| mode | behaviour | verification |
|---|---|---|
| `disable` | plaintext | — |
| `allow` | plaintext, then encrypted | none |
| `prefer` | encrypted, then plaintext | none |
| `require` | encrypted | none |
| `verify-ca` | encrypted | chain |
| `verify-full` | encrypted | chain + hostname |

This mattered more than it sounds. The underlying `pg` driver does **not**
implement libpq semantics: without a compatibility flag, `prefer`, `require` and
`verify-ca` all silently collapse into `verify-full`, `allow` is unhandled, and
there is no plaintext fallback at all. `prefer` is now a genuine fallback,
triggered only when the negotiation itself is refused — a bad password, an
unknown database, or a timeout surfaces as itself and **never silently
downgrades** the connection.

The default when `sslmode` is absent is `prefer`. Connections that explicitly set
`disable` are unaffected. An optional `ssl_root_cert` supplies the CA bundle for
the verify modes.

You can also now see what actually happened rather than what was requested:
`ssl_mode_configured` and `ssl_negotiated` are reported as separate fields,
alongside the real protocol, cipher, and authorization status read off the live
socket.

### Dependencies

All 7 open advisories in the dependency tree — **2 high**, 4 moderate, 1 low —
are resolved. `npm audit` reports **0 vulnerabilities**. Achieved by upgrading
the MCP SDK to `^1.30.0`; no forced resolutions, no pinned overrides.

---

## 5. Things that simply work better now, with no action from you

**Your factory selection survives a process restart.** `omatic_select_factory`
used to build a throwaway object and drop it — the choice lived exactly as long
as the process, and any component that re-read the environment never saw it at
all. This is the direct cause of the Cowork sessions where an operator selected
the same factory eight or more times in a row. The selection is now written to
durable per-plugin state and restored at startup. **Pinning a project is now a
once-per-project act.** Only paths are stored — no host, port, user, password, or
connection string reaches the state file.

**Resolution failures tell you the truth.** The old error said "No O-Matic Server
connection is configured for this project" — which named the wrong problem
entirely. The connections were fine; the *factory* had never resolved. That one
sentence cost a full misdiagnosis cycle. The error now lists every candidate root
in precedence order with the specific reason each was rejected, states the
no-walk-up rule explicitly, and gives you the recovery call.

Related: project discovery no longer leans on the process working directory,
which on Codex *is* the plugin install directory. A fallback used to reinstate
the very plugin path it had just filtered out.

**Probes report measurement, not memory.** The built-in startup probe used to
declare `status: "connected"` and the note "database query path verified" as a
static literal, assembled before anything had been inspected — a dead readiness
seed still produced a green, authoritative row. Status now derives from the two
operations actually executed, and reachability alone is not enough: a reachable
database with a failed seed reports `degraded`, honestly.

Separately, cached probe verdicts are no longer restamped as fresh — a 50-day-old
result was being reported as measured this session.

**Caller-supplied probes are labelled, not promoted.** Probes you pass in are
echoed back as `caller_asserted` with `recorded: false` and never reach the
registry. Only the plugin's own measured probe is recorded.

**Keyword-only search says so.** When semantic retrieval is unavailable and the
search falls back to full-text, the response is marked `degraded` with a reason
naming the missing vector. An empty result from a keyword search and an empty
result from a semantic search are different facts, and you can now tell them
apart.

**`omatic_search_memory` declares its side effect.** It writes telemetry on every
call. Its description now says so up front.

---

## Known limits in 3.0.0

Stated plainly, because a release built on an honesty contract should not hide
its own gaps.

- **`omatic_embedding_status` undercounts vector indexes.** The index query is
  hardcoded to the `public` schema, so a factory whose content lives in another
  schema is reported as having **0 HNSW indexes when it has several**. The query
  succeeds and returns no rows, so the new outcome machinery correctly reports
  `complete` — this is a wrong answer, not a detected failure, and nothing in
  this release catches it. Do not use this tool's index counts to diagnose
  retrieval on a non-`public` factory.
- **Connection management still has no operable surface.** There is no
  `omatic_test_connection`, adding a connection does not test it before saving,
  and `omatic_list_connections` does not report live reachability. Unchanged in
  this release.
- **`omatic_execute_sql` does not report `no_op`.** A zero-row `DELETE` through
  the guarded SQL tool still returns `complete`. Left deliberately: a zero-row
  `SELECT` is legitimately complete, and classifying arbitrary SQL as
  mutation-versus-read reliably is not something to guess at.
- **`omatic_claim_work` has a suspected uniqueness-key mismatch** between the
  column the constraint uses and the column the insert supplies. Unverified
  against a live schema at time of release.
- **A declared-but-unused parameter is still silently ignored** rather than
  rejected, in the handlers not covered by this release's contract work.

---

## Verifying the upgrade

```text
omatic_resolve_factory
```

Expect `factory_file` pointing at your project's `.omatic/factory.json` and
`active_connection` matching its `factory_id`. Then confirm the surface actually
changed — a 3.0 server exposes **34 tools**, and `omatic_factory_startup:kb`-style
names are gone. If you still see them, your host has not reloaded. On Codex, that
means restart.
