---
description: Add or update a database connection for this project's O-Matic Server plugin. Walks through naming the connection and entering credentials, test-connects before writing, and confirms what to do next.
disable-model-invocation: true
argument-hint: [connection-name]
---

# O-Matic Server — Connection Setup

You are helping the operator add (or update) a database connection in **this project's** `.omatic/factory.json`. Each project reaches only the databases its own `.omatic/factory.json` declares — that isolation is intentional. Do not add connections to other projects.

## Steps

1. **Connection name.** If the operator passed an argument, use it as the connection name. Otherwise ask for one. Lowercase letters, numbers, and hyphens only.

   The name becomes the suffix on the three pinned tool families —
   `omatic_execute_sql:{name}`, `omatic_search_memory:{name}`, and
   `omatic_list_tasks:{name}`. **Keep it short.** Codex enforces a 64-byte
   ceiling on the fully namespaced tool name and silently truncates past it, so
   a long connection name causes those pinned variants to be omitted from the
   published surface. The unsuffixed tool plus `omatic_set_active_connection`
   always covers the same ground, and any omission is disclosed on the base
   tool's description.

2. **Show what's already configured.** Call `omatic_list_connections` and show the operator this project's current connections, so they don't add a duplicate by accident.

3. **Gather credentials.** Ask for the database connection details. Accept either:
   - a full PostgreSQL DSN — `postgresql://user:password@host:port/database`, or
   - discrete fields: `host`, `port` (default 5432), `database`, `user`, `password`, `ssl_mode`.

   `ssl_mode` defaults to `require` and is **never inferred from the host
   address**. The old behavior guessed `disable` for `100.x` Tailscale hosts;
   that inference was removed because a guessed SSL mode is a silent security
   decision. If the target needs something other than `require`, ask the
   operator to state it explicitly — `disable`, `require`, `verify-ca`, or
   `verify-full`.

   Ask one thing at a time. Keep it conversational.

4. **Add it.** Call `omatic_add_connection` with the name and the credentials. Leave `test` at its default of `true` — the tool test-connects before it writes anything. **Do not set `test: false`** unless the operator explicitly asks you to.

5. **Handle the result.**
   - If the connection test fails, the tool writes nothing. Show the operator the error, help them correct the credentials, and try again.
   - If it succeeds, confirm: the connection is now in `.omatic/factory.json`, and the new `omatic_execute_sql:{name}`, `omatic_search_memory:{name}`, and `omatic_list_tasks:{name}` variants are broadcast via `notifications/tools/list_changed`. **On Claude Code 2.1.0+ they appear immediately — no restart needed.**
   - If the tool returns a `gitignore_warning`, surface it prominently — the operator must gitignore `.omatic/factory.json` so credentials are never committed.

6. **Confirm next steps.** Verify with `omatic_resolve_factory`.

   **On Codex, and on MCP clients older than Claude Code 2.1.0, tell the
   operator to restart deliberately.** Those hosts ignore
   `notifications/tools/list_changed`, are never prompted to update, and will
   keep serving a cached tool list — the new connection's tools will simply not
   be there, with nothing explaining why.

This command handles real database credentials. Never echo the password back in plain text. Never write credentials to any file other than via the `omatic_add_connection` tool.
