# O-Matic Server Connection 3.0.1 — Release Notes

**If you are on 2.2.1 or earlier, upgrade.** The version you are running reports
success on failed reads. That warning is repeated in full below, because it is
the reason the 3.0 line exists and it has not reached everyone it applies to.

---

## What 3.0.1 adds — connection management has an operable surface

3.0.0 shipped with this listed as a known limit. It is now closed.

- **`omatic_test_connection`** — enter a host, port, database, user, password and
  `sslmode` and find out whether they work. Saves nothing, changes nothing. On
  failure it returns the server's own error text; on success it reports the
  negotiated TLS and the database and user you actually landed on. You can also
  re-test a stored connection, overriding a single field for that test only.
- **`omatic_add_connection` and `omatic_edit_connection` test before they write.**
  A failed probe returns the Postgres error and writes nothing at all — the
  existing connection is left untouched rather than replaced with a broken one.
- **`omatic_list_connections` reports live reachability**, measured by that call,
  alongside the negotiated TLS protocol and cipher. `ssl_mode_configured` is what
  the config asks for; `ssl_negotiated` is what the handshake produced. When those
  two disagree, that disagreement is usually the bug. Passwords are never
  returned in any form.
- **Per-connection permissions.** Every connection carries `read_write` (default),
  `read_only`, or `disabled`, enforced at the tool layer for every tool and every
  pinned variant — before any handler runs and before any pool opens. There is no
  argument, flag or alias that bypasses it, and `confirm_destructive` does not
  override it: that flag is the operator approving a destructive statement, not
  the operator overriding a connection set to read-only. A `read_only` connection
  additionally runs with `default_transaction_read_only=on`, so the database
  refuses writes too. Use `read_only` for client databases and `disabled` for
  connections that must stay visible but untouched.

Also in this release: the Elementor connector is repointed after the upstream
v3.7.0 endpoint rename.

---

## The warning that applies to 2.2.1 and earlier

`omatic_factory_health_check` could return `success: true` while **every single
one** of its five startup queries had failed. Not a partial result, not a warning
— a clean report built on nothing.

Real output from 2.2.1, run against a live connection whose startup views
genuinely do not exist:

```
success = true

Factory status: CHECK | 0/0 connectors OK | 0/0 skills READY
Workload: 0 open tasks | none
Brain: clean | stale 0 | unembedded 0
Governance: OK unknown rules | OK unknown combined | 0 active SOPs
```

All five queries errored. The tool said **`Brain: clean`**.

A helper caught query exceptions and turned them into empty arrays. Nothing
downstream was required to check whether a read had actually happened, so a view
that reduced an empty array printed `0`, `clean`, and `OK` — indistinguishable
from a healthy factory. The fast-wake summary printed **GREEN on a total database
blackout**.

**What this means for you.** Any decision you or an agent made on the basis of a
green health check, a `0 open tasks` reading, a `stale 0` embedding count, or a
GREEN fast-wake on 2.2.1 or earlier may have been made on a fabricated number.
The connector could not tell you it had failed, so it did not.

**In 3.0** every response carries an explicit `outcome` — `complete`, `degraded`,
`failed`, or `no_op` — with `degraded_reasons`, `no_op_reasons`, and
`results_trustworthy`. A response cannot be marked `complete` once any constituent
query has errored, and a handler cannot fake it: the envelope fields are stripped
from handler-supplied data and the invariant throws rather than returning a
comfortable lie. Any field whose source failed renders `UNKNOWN` — never `clean`,
`OK`, `GREEN`, or `0`.

---

## Upgrading — this differs sharply by host

**Claude Code** refreshes the catalog in the background and notifies you. Run
`/reload-plugins`. The MCP servers switch over in place; no app restart, no
reinstall.

**Codex has no plugin or marketplace concept at all.** There is no catalog
refresh. Nothing reads a version number. You will never be prompted, notified, or
warned — not now, not later. A Codex operator who does not restart deliberately
keeps running the old build **forever**, including the 2.2.1 health check
described above. Codex also ignores `notifications/tools/list_changed`, so a
running session keeps calling its cached tool list. **Restart the MCP server
deliberately after upgrading.**

---

## Breaking change carried over from 3.0.0

The tool surface went from 99 tools to 34. Ten pinned tool families are gone;
calls to them now fail with an unknown-tool error. Set the target first, then call
the unsuffixed tool:

```text
omatic_set_active_connection { "name": "kb" }
omatic_factory_health_check
```

Three pinned families survive and need no change: `omatic_execute_sql`,
`omatic_search_memory`, `omatic_list_tasks`. Full detail, including the Codex
64-byte truncation that made the cut necessary and the removal of the two raw
`execute_sql` aliases that bypassed the destructive-SQL guard, is in the 3.0.0
release notes.

---

## Known limits in 3.0.1

Stated plainly, because a release built on an honesty contract should not hide its
own gaps.

- **`omatic_embedding_status` undercounts vector indexes.** The index query is
  hardcoded to the `public` schema, so a factory whose content lives in another
  schema is reported as having 0 HNSW indexes when it has several. The query
  succeeds and returns no rows, so the outcome machinery correctly reports
  `complete` — a wrong answer, not a detected failure. Do not use this tool's
  index counts to diagnose retrieval on a non-`public` factory.
- **`omatic_execute_sql` does not report `no_op`.** A zero-row `DELETE` through the
  guarded SQL tool still returns `complete`. Left deliberately: a zero-row
  `SELECT` is legitimately complete, and classifying arbitrary SQL as
  mutation-versus-read reliably is not something to guess at.
- **A declared-but-unused parameter is still silently ignored** rather than
  rejected, in the handlers not covered by this release's contract work.
- **The server declares one MCP primitive of three.** Tools only — no Resources,
  no Prompts. Read-only surfaces are still tools.

---

## Verifying the upgrade

```text
omatic_usage_guide
```

Expect `version: 3.0.1` and a `connection_management` block naming the connection
tools. Then run `omatic_list_connections` — a 3.0.1 server reports `reachable`,
`latency_ms`, `ssl_negotiated` and `permission` for every connection. If you do
not see those fields, your host has not reloaded. On Codex, that means restart.
