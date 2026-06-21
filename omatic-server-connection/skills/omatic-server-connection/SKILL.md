---
name: omatic-server-connection
description: Use when operating an O-Matic Server project through the Codex plugin, including factory startup, health checks, memory search, embedding status, task review, decision logging, connection setup, work claims, and guarded SQL.
---

# O-Matic Server

<!-- version: 2.1.5 | sig: 2 | author: James Walker | package: O-Matic Server Connection -->

This plugin is project-centric. Resolve the active factory from folder context before running factory work.

## Operating Model

- One Codex session operates one factory.
- Folder context wins. Do not switch factories inside a session unless the operator explicitly asks to override project context.
- Use the factory tools before raw SQL when a high-level tool exists.
- Destructive SQL requires explicit operator confirmation.
- Work claims are per factory and auto-expire when the `work_claims` table is installed.
- The plugin is the gateway/tool surface; the factory database remains the source of truth.

## Startup

When the operator says `start the factory`, `restart the factory`, `Probot start`, or `run startup`:

1. Call `omatic_resolve_factory`.
2. Call `omatic_factory_startup_run` when available. It opens the platform session, seeds readiness, records built-in probes, warms retrieval, and returns the scoped startup packet.
3. If `omatic_factory_startup_run` is unavailable, call `omatic_factory_startup` and then execute the DB startup rules returned by `v_startup_rules`.
4. Report the startup summary, connector readiness, embedding health, SOP index presence, and agent agreement flags.
5. If an exact session audit is needed later, pass the current `factory_sessions.id` to `omatic_factory_startup`.

If this skill is loaded in Codex but `omatic_*` tools are absent, report a Codex plugin MCP registration/cache/reload failure. Do not diagnose that as standalone factory mode, and do not edit factory config. The package or installed plugin cache must be fixed and loaded in a fresh thread.

## Retrieval

Use `omatic_search_memory` for memory lookup.

Use `omatic_embedding_status` when the operator asks how embeddings, pgvector, or retrieval works. The tool reports the active factory's DB-owned embedding configuration, vector extensions, vector/FTS indexes, embedding health, and whether the plugin itself can generate query embeddings.

## Connections

Use `omatic_list_connections` to inspect configured connections with passwords redacted.

Use `omatic_add_connection` only when the operator asks to add or update a factory DB connection. The tool test-connects by default before writing `.omatic/factory.json`.

Use `omatic_remove_connection` only when the operator asks to remove a connection.

## SQL

Use `omatic_execute_sql` only for queries that do not have a first-class tool. Set `confirm_destructive=true` only after the operator confirms the destructive action.
