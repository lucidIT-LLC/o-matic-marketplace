---
name: omatic-server-operating-guide
description: Use when operating an O-Matic Server project through the plugin — pinning the factory, confirming resolution, and reaching the factory database through Conductor for startup, memory search, task review, decision logging and SQL.
---

# O-Matic Server — Operating Guide

<!-- version: 5.7.0 | sig: 2 | author: James Walker | package: O-Matic Server Connection -->

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

<!-- shared:system-5-detection start -->
**Test the value and the observable shape, never the key name.** A key called
`openai_api_key` is not evidence of an OpenAI path. On the reference factory it
holds `env:CONDUCTOR_TOKEN`, and `openai_embedding_model` holds the current
`nomic-embed-text-v1.5@e9b67630…`. Those names survive because the on-device
provider is `onboard-openai-compatible` — it speaks the OpenAI REST *protocol*
against loopback. They are protocol names, not vendor names. Matching the label
false-positived both reference factories, and it misses the same secret stored
under any other label (task #276; FA-2026-05 §4.1, "search for values, not just
key names").

Run this through Conductor `factory_query`. It resolves vector columns by type,
so it does not care whether the tiers live in `brain.*`, `kb.*`, or elsewhere:

```sql
-- System 5 detection. One row out. Any error is a FAIL.
WITH vec AS (
  SELECT n.nspname AS sch, c.relname AS tbl, a.atttypmod AS dim
  FROM pg_attribute a
  JOIN pg_class c     ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_type t      ON t.oid = a.atttypid
  WHERE t.typname = 'vector' AND a.attnum > 0 AND NOT a.attisdropped
    AND c.relkind IN ('r','m','p')
    AND n.nspname NOT IN ('pg_catalog','information_schema')),
vt AS (SELECT DISTINCT sch, tbl FROM vec),
rt AS (
  SELECT count(*) AS n FROM pg_attribute a
  JOIN pg_class c     ON c.oid = a.attrelid
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE a.attname = 'embedding_runtime' AND a.attnum > 0 AND NOT a.attisdropped
    AND (n.nspname, c.relname) IN (SELECT sch, tbl FROM vt)),
cfg AS (SELECT key, value, value #>> '{}' AS v FROM factory.factory_config),
live AS (
  SELECT key, v FROM cfg
  WHERE key <> 'embedding_migration_state'
    AND jsonb_typeof(value) <> 'null' AND v IS NOT NULL AND btrim(v) <> ''
    AND v !~ '^env:'),
t AS (SELECT
  (SELECT count(*) FROM vec) > 0
    AND (SELECT count(*) FROM vec WHERE dim <> 768) = 0            AS a_vector_dim,
  (SELECT count(*) FROM vt) > 0
    AND (SELECT n FROM rt) = (SELECT count(*) FROM vt)             AS b_runtime_col,
  coalesce((SELECT v FROM cfg WHERE key = 'embedding_dimension'),'') = '768'
                                                                   AS c_cfg_dim,
  (SELECT count(*) FROM live
     WHERE v ~ '^sk-[A-Za-z0-9_-]{16,}'
        OR v ~* 'api\.openai\.com'
        OR v ~* 'text-embedding-(3-(small|large)|ada-002)') = 0     AS d_no_live_openai)
SELECT a_vector_dim, b_runtime_col, c_cfg_dim, d_no_live_openai,
  CASE WHEN a_vector_dim AND b_runtime_col AND c_cfg_dim AND d_no_live_openai
       THEN 'PASS — System 5' ELSE 'FAIL — pre-System-5 or unproven' END AS verdict
FROM t;
```

**What each column proves**, in descending order of reliability:

| Column | PASS needs | Why it holds |
|---|---|---|
| `a_vector_dim` | `true` | Structural. Every `vector` column is `vector(768)`. A `vector(1536)` is decisive pre-5 and no config row can fake it either way. Resolved from `pg_attribute`, so a renamed schema or table cannot hide it. |
| `b_runtime_col` | `true` | Every vector-bearing table also carries `embedding_runtime`. Added by the on-device migration; absent on 4.x. |
| `c_cfg_dim` | `true` | `factory_config.embedding_dimension` is `768`. `value` is **jsonb** — extract with `#>> '{}'`, not a text cast. Weakest of the four: it is a config row, so it agrees with `a_vector_dim` or one of them is lying. |
| `d_no_live_openai` | `true` | **Value-shaped scan over every config value regardless of its key name** — the false-negative half. Flags an API-key-shaped literal, an `api.openai.com` endpoint, or an OpenAI embedding model named as live config. |

`d_no_live_openai` deliberately excludes two things that are *not* evidence of a
live OpenAI path: values beginning `env:` (an indirection to the Keychain/token,
never a literal secret), and the `embedding_migration_state` row, whose
`from_model` legitimately records `text-embedding-3-small` as the model the
factory migrated *away* from. Provenance is not exposure.

**PASS / FAIL:**

- **PASS — System 5** only when `verdict` reads `PASS — System 5`, i.e. all four
  booleans are `true` in the one returned row.
- **FAIL — pre-System-5 or unproven** on anything else, specifically:
  - any boolean `false`;
  - **the query errors** — missing `factory.factory_config`, no `vector` type, no
    grant, wrong connection. An error is a FAIL, never "inconclusive". Report the
    error text verbatim and stop;
  - **zero rows** — this query returns exactly one row whenever it runs at all,
    so no rows means it did not run. An empty result is never a pass.
- A `false` on `d_no_live_openai` is the only *credential* finding in the set.
  Treat it as an exposure and route it before conversion, not as a schema note.

Do not reinstate a `schema_contract` check here — **the mechanism was never
built.** `system-5-built-vs-planned.md` records that no `schema_contract` table
exists anywhere in the database and lists writing one as an outstanding DDL
deliverable. The plan's enforcement language — that Conductor and the plugin read
it at connect/startup, and that the conformance suite tests three states — is
plan text describing intent, not a record of shipped behaviour. Measured
2026-08-14: absent from o-matic in every form; present in Commons only as a row
hand-written on 2026-08-09. One hand-made row in one database is not a mechanism,
and a detector for an unbuilt mechanism detects nothing.

If `schema_contract` is ever built for real — written on every factory, read at
startup, and tested by the conformance suite — reinstate it then, and not before.
Until that happens, treating its absence as a factory defect reports a planning
gap as an operational failure.

Report the result plainly. A pre-5 factory is not broken and it is not "degraded
System 5" — it runs the 4.x contract: plugin-direct SQL, credentials on the host,
keyword-only retrieval where no Conductor is installed. Conversion is a sequenced
advisory (FA-2026-05), not an ad-hoc fix; never half-convert a factory to make one
query work.

## What good looks like — the data doctrine

Detection tells you whether a factory is System 5. **KB-0002, *Factory Vector
Memory Design*** (Commons, design-guide, v2.0.0) tells you what a correct one is
built from. Read it before designing or repairing a tier — not after.

The parts you are expected to know without opening it:

- **The mandatory column set on every vector-bearing table:** `embedding`,
  `model_version`, `embedded_at`, `embedding_stale`, `embedding_runtime`. Missing
  any one of them means the table cannot participate in a drain — a table with a
  vector column and nothing else is storage, not memory. Measured 2026-08-15: the
  drain resolves tier tables by *contract shape*, so a table lacking these is
  correctly skipped rather than corrupted, which is how About Jimmy's
  `query_embedding_cache` and two held evaluation sets survive a drain untouched.
- **Index pairing:** partial HNSW on `embedding WHERE embedding IS NOT NULL`,
  plus a GIN index on a **precomputed `tsv` column** — never inline
  `to_tsvector()`. Hybrid retrieval needs both halves; one alone is not the
  contract.
- **Tenant scoping is per-corpus, not universal.** `brain.*` carries `tenant_id`;
  `kb.*` in the shared doctrine library has **no tenant column at all**. Code that
  assumes one throws on Commons. This is a real defect that shipped — the drain
  pinned `tenant_id = 'omatic'` and would have failed on Commons even after its
  schema hardcode was fixed.
- **The `factory_config` embedding block** declares provider, endpoint, model and
  dimension. It is a *declaration*, not proof: a complete, correct-looking
  embedding contract can be entirely inert. Call it and read what comes back.

**Row counts prove storage. Only a query with a real vector distance proves
retrieval.** A corpus that is 100% embedded and never queried with a vector is a
filing cabinet.

Doctrine lives in Commons and is the authority: **KB-0051** (the Blueprint —
System 5.2 is a chapter of it, amendment v2.6.0, not a separate book) and
**KB-0002** (this data doctrine). The files in `_omatic/blueprints/` —
`system-5-plan.md`, `conductor-v1.5.md`, `system-5-compliance-register.md`,
`marketplace-change-log.md` — are working notes derived from those, and they
carry no version, hash or gate. **When they disagree with Commons, Commons wins.**
<!-- shared:system-5-detection end -->
