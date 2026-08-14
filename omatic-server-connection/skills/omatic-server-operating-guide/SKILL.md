---
name: omatic-server-operating-guide
description: Use when operating an O-Matic Server project through the plugin — pinning the factory, confirming resolution, and reaching the factory database through Conductor for startup, memory search, task review, decision logging and SQL.
---

# O-Matic Server — Operating Guide

<!-- version: 5.1.0 | sig: 2 | author: James Walker | package: O-Matic Server Connection -->

This plugin is project-centric and, as of 5.0.0, **not a database client**. It
resolves and pins the factory. Everything that touches a database goes through
**Conductor**.

## Operating Model

- One session operates one factory.
- **Folder context wins.** Do not switch factories inside a session unless the
  operator explicitly asks to override project context.
- The plugin answers "which factory is this?". Conductor answers "what is in
  it?". Neither substitutes for the other.
- The factory database remains the source of truth. State is queried, not
  recalled.
- Destructive SQL requires explicit operator confirmation, enforced by
  Conductor's `confirm_destructive` flag.

## Startup

When the operator says `start the factory`, `restart the factory`, `Probot
start`, or `run startup`:

1. **Pin the factory first.** Call
   `omatic_select_factory(project_root="/absolute/path")`. This is required on
   every host: the plugin's working directory is host-dependent and is not the
   project folder, and discovery never walks up the directory tree (rule #259).
2. Call `omatic_resolve_factory` and check `factory_file` is non-null. If it is
   null, **stop and report** — do not run work against an unresolved factory.
3. Open the session and load startup state through Conductor's `factory_query`
   against the granted connection (session anchor, connector readiness, startup
   rules, agent agreements, open tasks).
4. Report the startup summary, connector readiness, embedding health, SOP index
   presence and agreement flags — and report each **as measured**. A connector
   with no measurement this session is `untested`, not OK.

If the `omatic_*` tools are absent entirely, report a plugin MCP
registration/cache/reload failure. If `omatic_runtime_status` is the *only* tool
present, the plugin is in advisory mode and the Node runtime failed to resolve.
Neither is "standalone factory mode", and neither is fixed by editing factory
config.

## Database access — Conductor

Conductor holds every factory credential in the Mac Keychain and grants them per
paired app over MCP on `https://localhost:8438`.

- `connections_list` — which connections this app was granted, and how many exist
  that it was not.
- `factory_query` — SQL against a granted connection. Conductor holds the
  credential; the caller never sees it. Destructive statements refuse unless
  `confirm_destructive` is true.
- `embed_query` — a 768-d query vector on the weights the corpus was embedded
  under.

Conductor's connection names are the **operator-facing** ones and differ from the
plugin's old internal names: **o-MATIC Home Office** (was `omatic`), **Commons**
(was `kb`), **About Jimmy** (was `aboutjimmy`), plus **Benecard**, **lucidIT
Corp**, **Practically Adventist**, **theNest**.

*"This app was not granted access to X"* is the pairing grant working — the
ticket for this project names which databases it may reach. It is a **refusal**,
never an empty result. Report it as one.

## Retrieval

1. Get a query vector from Conductor's `embed_query`.
2. Call `fn_search_semantic` / `fn_search_documents` through `factory_query`,
   passing `p_query_model_version` from the vector you were given.

Those functions take `p_query_model_version` and **refuse a weights mismatch**
(task #222) — a corpus embedded under one set of weights and searched under
another returns confident nonsense, so the refusal is the feature.

**Keyword-only retrieval is a reportable degraded state, not a neutral
fallback.** If you could not get a vector, say so rather than presenting FTS hits
as semantic ones. `v_retrieval_health` is the gauge.

## Connections

Connection CRUD is Conductor's, and the operator approves it in Conductor's own
UI: `connections_list` to see what is granted, `connection_propose` /
`connection_amend` / `connection_remove` to change it.

**Never write a database credential into `.omatic/factory.json`.** Nothing reads
it — this plugin does not connect to a database — so it is a credential at rest
serving no purpose. `omatic_resolve_factory` reports the key names of any
leftovers so they can be moved into Conductor and deleted.

An **empty connection list in `factory.json` is correct, not a failure.**

## Embedding drain

`scripts/embed-drain.mjs` is a standalone operator script, not a plugin tool. It
speaks the provider named in `factory_config` and covers both tiers:

```bash
OMATIC_PROJECT_ROOT=/path/to/factory node scripts/embed-drain.mjs
OMATIC_PROJECT_ROOT=/path/to/factory node scripts/embed-drain.mjs --watch
```

It refreshes only admitted Tier 1 and Tier 2 rows already present in
`brain.semantic_index` and `brain.document_chunks`. It does not admit memory,
resolve contradictions, promote canon, retire records, or decide truth.

## Tools this plugin provides

- `omatic_select_factory` — pin the factory. **Always first.**
- `omatic_resolve_factory` — confirm what resolved, and why.
- `omatic_runtime_status` — the measured Node runtime.
- `omatic_usage_guide` — what the plugin does and where DB work goes.

That is the whole surface. The SQL, memory, task, decision, probe, work-claim,
embedding-status and connection-CRUD tools were **removed in 5.0.0** and return
`Unknown tool`. They are gone, not deprecated — use Conductor.
