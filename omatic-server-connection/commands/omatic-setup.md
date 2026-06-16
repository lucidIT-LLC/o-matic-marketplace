---
description: Add or update a database connection for this project's O-Matic Server plugin. Walks through naming the connection and entering credentials, test-connects before writing, and confirms what to do next.
disable-model-invocation: true
argument-hint: [connection-name]
---

# O-Matic Server — Connection Setup

You are helping the operator add (or update) a database connection in **this project's** `.omatic/factory.json`. Each project reaches only the databases its own `.omatic/factory.json` declares — that isolation is intentional. Do not add connections to other projects.

## Steps

1. **Connection name.** If the operator passed an argument, use it as the connection name. Otherwise ask for one. The name becomes the tool namespace (`o-matic-server-{name}:execute_sql`) — lowercase letters, numbers, and hyphens only.

2. **Show what's already configured.** Call `omatic_list_connections` and show the operator this project's current connections, so they don't add a duplicate by accident.

3. **Gather credentials.** Ask for the database connection details. Accept either:
   - a full PostgreSQL DSN — `postgresql://user:password@host:port/database`, or
   - discrete fields: `host`, `port` (default 5432), `database`, `user`, `password`, `ssl_mode` (defaults to `disable` for `100.x` Tailscale hosts, `require` otherwise).

   Ask one thing at a time. Keep it conversational.

4. **Add it.** Call `omatic_add_connection` with the name and the credentials. Leave `test` at its default of `true` — the tool test-connects before it writes anything. **Do not set `test: false`** unless the operator explicitly asks you to.

5. **Handle the result.**
   - If the connection test fails, the tool writes nothing. Show the operator the error, help them correct the credentials, and try again.
   - If it succeeds, confirm: the connection is now in `.omatic/factory.json`, and the new `o-matic-server-{name}:execute_sql` tool set appears **after a Claude Code restart**.
   - If the tool returns a `gitignore_warning`, surface it prominently — the operator must gitignore `.omatic/factory.json` so credentials are never committed.

6. **Confirm next steps.** Tell the operator to restart Claude Code, then verify with `omatic_resolve_factory`.

This command handles real database credentials. Never echo the password back in plain text. Never write credentials to any file other than via the `omatic_add_connection` tool.
