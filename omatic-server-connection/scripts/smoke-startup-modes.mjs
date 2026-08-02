#!/usr/bin/env node
// Smoke test for Factory 3.0 startup modes (workstream C). Modes are reporting
// depth only — no cache (Smith gate, decision #188). Pure logic, no DB/network.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const tools = require(resolve(here, "../server/tools.js"));
const { __test__, buildToolList, handleToolCall, buildServerInstructions } = tools;
const {
  formatFastStartupView,
  formatStartupView,
  startupViewForMode,
  OutcomeCollector,
  runWithOutcome,
  currentOutcome,
  successResponse,
  errorResponse,
  viewField,
  assertToolNamesSafe,
  hostVisibleToolName,
  MAX_BARE_TOOL_NAME_BYTES,
  HOST_TOOL_NAME_LIMIT,
  HOST_TOOL_NAMESPACE,
} = __test__;

let pass = 0;
const failures = [];
const ok = (cond, msg) => (cond ? pass++ : failures.push(msg));

// queryResult shape mirrors optionalQuery output: { ok, rows, count }
const green = {
  // A12: `connector_id` is the column v_mcp_readiness actually exposes. This
  // fixture said `connector_name` and the assertion below still passed, because
  // the formatter guessed through an `||` chain — the fixture encoded the bug.
  readiness: { ok: true, rows: [{ status_label: "OK", connector_id: "postgres-omatic" }] },
  embedding: { ok: true, rows: [{ stale: 0, unembedded: 0 }] },
  summary: {
    ok: true,
    rows: [{ governance_health: { active_rule_count: 40, rule_count_target: 40 }, open_task_total: "3", last_summary: "resume here" }],
  },
  agreements: { ok: true, rows: [] },
  rules: { ok: true, rows: [] },
  loaded_skills: [],
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const warnConn = clone(green);
warnConn.readiness.rows[0].status_label = "DEGRADED";

// fast view — green
const gv = formatFastStartupView({
  mode: "fast",
  startup: green,
  session: { id: 42, platform: "claude-code" },
  identity: { db_name: "o-matic" },
  factory: { factory_id: "omatic" },
});
ok(/FAST WAKE/.test(gv), "fast view header present");
ok(/Status: GREEN/.test(gv), "green fast view says GREEN");
ok(/mode=fast/.test(gv), "fast view shows mode line (no stale health source)");
ok(/Resume: resume here/.test(gv), "fast view shows resume point");
ok(/Open P1\+ tasks: 3/.test(gv), "fast view shows open task count");

// fast view — warnings surfaced
const wv = formatFastStartupView({
  mode: "fast",
  startup: warnConn,
  session: { id: 7 },
  identity: {},
  factory: {},
});
ok(/need attention/.test(wv), "warn fast view flags attention");
ok(/DEGRADED: connector postgres-omatic/.test(wv), "warn fast view names degraded connector");

// mode -> view selection (the runner branch, made testable)
const base = { startup: green, session: { id: 1, platform: "claude-code" }, identity: { db_name: "o-matic" }, factory: { factory_id: "omatic" } };
const fastOut = startupViewForMode({ ...base, mode: "fast" });
ok(/FAST WAKE/.test(fastOut), "mode=fast selects the fast-wake view");

for (const m of ["normal", "audit", undefined]) {
  let out;
  let threw = false;
  try {
    out = startupViewForMode({ ...base, mode: m });
  } catch {
    threw = true;
  }
  ok(!threw, `mode=${m} view renders without throwing`);
  ok(typeof out === "string" && !/FAST WAKE/.test(out), `mode=${m} selects the full (non-fast) view`);
}

// ── P0 response layer (issue #4 section A) ──
// Adversarial shape: every startup view errored, exactly as the kb connection
// (factory_commons, no public base tables) behaves live.
const blackout = {
  summary: { ok: false, error: 'relation "v_startup_summary" does not exist' },
  rules: { ok: false, error: 'relation "v_startup_rules" does not exist' },
  readiness: { ok: false, error: 'relation "v_mcp_readiness" does not exist' },
  embedding: { ok: false, error: 'relation "v_embedding_health" does not exist' },
  agreements: { ok: false, error: 'relation "public.v_agent_agreement" does not exist' },
  loaded_skills: [],
};

// A17 — fast wake must not print GREEN on a blackout.
const bv = formatFastStartupView({ mode: "fast", startup: blackout, session: {}, identity: {}, factory: {} });
ok(!/Status: GREEN/.test(bv), "A17 blackout fast view does NOT say GREEN");
ok(/Status: UNKNOWN/.test(bv), "A17 blackout fast view says UNKNOWN");
ok(/connector readiness unreadable/.test(bv), "A17 blackout names the unreadable readiness source");
ok(/Open P1\+ tasks: UNKNOWN/.test(bv), "A4 blackout does not manufacture an open-task count");
ok(!/Open P1\+ tasks: 0\b/.test(bv), "A4 blackout never renders 0 open tasks from a missing view");

// A4 — full view must not manufacture "clean"/"OK"/"GREEN"/0 from missing data.
const fv = formatStartupView({ startup: blackout, session: {}, identity: {}, factory: {} });
ok(!/Brain: clean/.test(fv), "A4 blackout view does NOT print 'Brain: clean'");
ok(/Brain: UNKNOWN \| stale UNKNOWN \| unembedded UNKNOWN/.test(fv), "A4 brain fields render UNKNOWN");
ok(/Factory status: UNKNOWN/.test(fv), "A4 factory status renders UNKNOWN");
ok(!/GREEN/.test(fv), "A4 blackout view never claims GREEN");
ok(/Unreadable sources: 5 of 5/.test(fv), "A4 blackout view enumerates unreadable sources");

// A1/A2 — successResponse cannot emit a clean result once a query failed.
const cleanRes = runWithOutcome(() => successResponse({ data: 1 }));
const cleanPayload = JSON.parse(cleanRes.content[0].text);
ok(cleanPayload.outcome === "complete", "A2 clean call reports outcome=complete");
ok(cleanRes.isError === false, "A2 clean call is not an MCP error");
ok(cleanPayload.results_trustworthy === true, "A3 clean call is trustworthy");

const failedRes = runWithOutcome(() => {
  currentOutcome().recordQueryFailure("SELECT * FROM v_startup_summary", new Error("relation does not exist"));
  return successResponse({ rows: [] });
});
const failedPayload = JSON.parse(failedRes.content[0].text);
ok(failedPayload.outcome === "failed", "A1 successResponse reports failed when every query errored");
ok(failedPayload.success === false, "A1 successResponse cannot claim success under total failure");
ok(failedRes.isError === true, "A1 MCP isError set on outcome=failed");
ok(failedPayload.degraded_reasons.length === 1, "A2 degraded_reasons carries the failure");
ok(/v_startup_summary/.test(failedPayload.degraded_reasons[0]), "A2 degraded_reasons includes SQL context");
ok(failedPayload.results_trustworthy === false, "A3 zero results under failure is not trustworthy");

const degradedRes = runWithOutcome(() => {
  const c = currentOutcome();
  c.recordQuerySuccess(4);
  c.recordQueryFailure("SELECT * FROM v_embedding_health", new Error("boom"));
  return successResponse({ rows: [1, 2, 3, 4] });
});
const degradedPayload = JSON.parse(degradedRes.content[0].text);
ok(degradedPayload.outcome === "degraded", "A2 partial failure reports degraded");
ok(degradedRes.isError === false, "A2 degraded is not an MCP protocol error");
ok(degradedPayload.success === true, "A2 degraded still returns data");
ok(degradedPayload.results_trustworthy === true, "A3 degraded WITH rows stays trustworthy");

const unavailableRes = runWithOutcome(() => {
  const c = currentOutcome();
  c.recordQuerySuccess(1);
  c.recordUnavailable("work_claims", "table is not installed for this factory");
  return successResponse({ available: false });
});
const unavailablePayload = JSON.parse(unavailableRes.content[0].text);
ok(unavailablePayload.outcome === "degraded", "A2 unavailable capability is never complete");
ok(/work_claims/.test(unavailablePayload.degraded_reasons[0]), "A2 unavailable capability is named");

// errorResponse keeps the same envelope shape.
const errRes = runWithOutcome(() => errorResponse("nope"));
const errPayload = JSON.parse(errRes.content[0].text);
ok(errRes.isError === true && errPayload.outcome === "failed", "errorResponse stamps outcome=failed + isError");

// Internal invariant: complete + non-empty reasons must be impossible.
let invariantThrew = false;
try {
  const c = new OutcomeCollector();
  c.failures.push({ sql: "x", error: "y", connection: null });
  c.okQueryCount = 1;
  Object.defineProperty(c, "outcome", { value: () => "complete" });
  c.summarize();
} catch {
  invariantThrew = true;
}
ok(invariantThrew, "outcome=complete with degraded_reasons throws the internal invariant");

// Handler-supplied keys can never overwrite the computed envelope.
const spoofRes = runWithOutcome(() => {
  currentOutcome().recordQueryFailure("SELECT 1", new Error("boom"));
  return successResponse({ success: true, outcome: "complete", degraded_reasons: [], results_trustworthy: true });
});
const spoofPayload = JSON.parse(spoofRes.content[0].text);
ok(spoofPayload.outcome === "failed", "handler cannot spoof outcome=complete");
ok(spoofPayload.results_trustworthy === false, "handler cannot spoof results_trustworthy");

// ══════════════════════════════════════════════════════════════════════════
// P1 tool surface (issue #4: J1/A10, A6, A11, A12, D5, B8)
// ══════════════════════════════════════════════════════════════════════════

// ── A12 — field names resolve ──
// The old formatter read `connector_name`, a column v_mcp_readiness has never
// had, behind an `||` chain of guesses. A row carrying ONLY the wrong column
// must now render UNKNOWN: a wrong guess has to look wrong.
const legacyShaped = clone(green);
delete legacyShaped.readiness.rows[0].connector_id;
legacyShaped.readiness.rows[0].connector_name = "postgres-omatic";
legacyShaped.readiness.rows[0].status_label = "DEGRADED";
const legacyView = formatFastStartupView({
  mode: "fast",
  startup: legacyShaped,
  session: {},
  identity: {},
  factory: {},
});
ok(
  /DEGRADED: connector UNKNOWN/.test(legacyView),
  "A12 a row missing the declared connector_id renders UNKNOWN"
);
ok(!/connector \?/.test(legacyView), "A12 the '?' guess-fallback is gone from the fast view");
ok(
  !/DEGRADED: connector postgres-omatic/.test(legacyView),
  "A12 formatter does not silently read the undeclared connector_name column"
);

// The correctly-shaped row still renders, in both views.
const fullReadiness = formatStartupView({
  startup: warnConn,
  session: {},
  identity: {},
  factory: {},
});
ok(/postgres-omatic: DEGRADED/.test(fullReadiness), "A12 full view renders connector_id in the readiness block");

// The contract itself: an undeclared column is a programming error, not a
// silent UNKNOWN. This is what stops the next formatter inventing a column.
let undeclaredThrew = false;
try {
  viewField("readiness", { connector_name: "x" }, "connector_name");
} catch {
  undeclaredThrew = true;
}
ok(undeclaredThrew, "A12 viewField throws when a formatter reads an undeclared column");

let unknownSourceThrew = false;
try {
  viewField("not_a_view", {}, "anything");
} catch {
  unknownSourceThrew = true;
}
ok(unknownSourceThrew, "A12 viewField throws on an unknown view source");

// ── B8 — the model-visible tool surface ──
const FIVE = ["omatic", "kb", "benecard", "dbadmin", "aboutjimmy"];
const fakeConnections = (names = FIVE) => ({
  project: () => ({ factory_id: "omatic", platform_profile: "claude-code", resolution: {} }),
  names: () => names,
  defaultName: () => names[0],
  activeName: names[0],
  has: (n) => names.includes(n),
  getConfig: (n) => (names.includes(n) ? { name: n, host: "db.internal", port: 5432, database: `f_${n}`, user: "u" } : null),
  env: () => ({}),
});

const surface = buildToolList(fakeConnections());
ok(surface.length === 34, `B8 tool surface is 34, was 99 (got ${surface.length})`);
ok(
  surface.filter((t) => t.name.includes(":")).length === 15,
  "B8 pinned variants are 3 families x 5 connections = 15"
);
ok(
  surface.every((t) => !/^(postgres-cabinet-|o-matic-server-)/.test(t.name)),
  "J1 no raw execute_sql aliases remain in the tool list"
);

const overBudget = surface.filter(
  (t) => Buffer.byteLength(hostVisibleToolName(t.name), "utf8") > HOST_TOOL_NAME_LIMIT
);
ok(overBudget.length === 0, `B8 every name fits the ${HOST_TOOL_NAME_LIMIT}-byte host budget (over: ${overBudget.map((t) => t.name).join(", ")})`);

const visibleNames = surface.map((t) => hostVisibleToolName(t.name));
ok(
  new Set(visibleNames).size === visibleNames.length,
  "B8 every name is still unique after the host folds ':' and '-' to '_'"
);
ok(
  surface.every((t) => !/_[0-9a-f]{12}$/.test(hostVisibleToolName(t.name))),
  "B8 no name arrives pre-hashed"
);

// The guard is structural, not advisory.
let overThrew = false;
try {
  assertToolNamesSafe([{ name: "x".repeat(MAX_BARE_TOOL_NAME_BYTES + 1) }]);
} catch {
  overThrew = true;
}
ok(overThrew, "B8 assertToolNamesSafe throws on an over-budget name");

let collisionThrew = false;
try {
  assertToolNamesSafe([{ name: "omatic_a:kb" }, { name: "omatic_a-kb" }]);
} catch {
  collisionThrew = true;
}
ok(collisionThrew, "B8 assertToolNamesSafe throws when two names fold to the same host name");

ok(
  Buffer.byteLength(HOST_TOOL_NAMESPACE, "utf8") + MAX_BARE_TOOL_NAME_BYTES === HOST_TOOL_NAME_LIMIT,
  "B8 the bare-name budget and the namespace exactly account for the host limit"
);

// A connection name too long to pin must be omitted, not emitted mangled — and
// the omission must be visible in the tool surface. `aboutjimmy-dev` is 14
// bytes, which is the interesting middle: it fits under omatic_execute_sql (18)
// and omatic_list_tasks (17) but not under omatic_search_memory (20). The
// decision is therefore per-name, not per-connection.
const midName = "aboutjimmy-dev";
const withLong = buildToolList(fakeConnections([...FIVE, midName]));
ok(
  withLong.every((t) => Buffer.byteLength(hostVisibleToolName(t.name), "utf8") <= HOST_TOOL_NAME_LIMIT),
  "B8 an over-long connection name never produces an over-budget pinned tool"
);
ok(
  !withLong.some((t) => t.name === `omatic_search_memory:${midName}`),
  "B8 the over-budget pinned variant is omitted rather than mangled"
);
ok(
  withLong.some((t) => t.name === `omatic_execute_sql:${midName}`),
  "B8 a pinned variant that still fits is kept for the same connection"
);
ok(
  withLong.some((t) => t.name === "omatic_search_memory" && t.description.includes(midName)),
  "B8 the omission is disclosed on the base tool description"
);

// A name long enough to overflow every family loses all its pinned variants,
// and the base tools still work against it via omatic_set_active_connection.
const hugeName = "practicallyadventist";
const withHuge = buildToolList(fakeConnections([...FIVE, hugeName]));
ok(
  !withHuge.some((t) => t.name.endsWith(`:${hugeName}`)),
  "B8 a connection name too long for any family publishes no pinned variants"
);
ok(
  withHuge.every((t) => Buffer.byteLength(hostVisibleToolName(t.name), "utf8") <= HOST_TOOL_NAME_LIMIT),
  "B8 the surface stays within budget even then"
);

// ── J1 / A10 — one guard, no bypass door ──
// The removed dispatch called handleSql with guardDestructive=false. Both the
// legacy and the modern raw name must now be unroutable, and the first-class
// tool must refuse the same statement.
const sqlConnections = {
  ...fakeConnections(),
  query: async () => ({ rows: [{ db_name: "f_omatic", db_user: "u" }], count: 1 }),
  execute: async () => ({ rows: [], count: 0 }),
};

const parse = (res) => JSON.parse(res.content[0].text);

for (const legacyName of ["o-matic-server-omatic:execute_sql", "postgres-cabinet-omatic:execute_sql"]) {
  const res = await handleToolCall(sqlConnections, legacyName, { sql: "DELETE FROM tasks" });
  const body = parse(res);
  ok(res.isError === true, `A10 ${legacyName} is refused`);
  ok(/Unknown tool/.test(body.error || ""), `A10 ${legacyName} is not routed to any handler`);
}

const guarded = await handleToolCall(sqlConnections, "omatic_execute_sql", { sql: "DELETE FROM tasks" });
ok(parse(guarded).error === "Destructive SQL requires confirm_destructive=true.", "A10 omatic_execute_sql guards DELETE");
const guardedPinned = await handleToolCall(sqlConnections, "omatic_execute_sql:kb", { sql: "DROP TABLE tasks" });
ok(
  parse(guardedPinned).error === "Destructive SQL requires confirm_destructive=true.",
  "A10 the pinned SQL variant is guarded too"
);
ok(
  tools.parseLegacyToolName === undefined && tools.legacyToolName === undefined,
  "J1 the legacy tool-name helpers are gone from the module surface"
);

// ── F1 amendment — FTS-only always reports degraded ──
// End-to-end through handleToolCall, with no embedding credential available, so
// the tool takes exactly the fallback path that read `complete` before.
const memoryConnections = {
  ...fakeConnections(),
  query: async (_name, sql) => {
    if (/current_database\(\)/.test(sql)) return { rows: [{ db_name: "f_omatic", db_user: "u" }], count: 1 };
    if (/factory_config/.test(sql)) return { rows: [], count: 0 };
    if (/fn_record_retrieval_event/.test(sql)) return { rows: [{ event_id: 1 }], count: 1 };
    return { rows: [], count: 0 }; // fn_search_semantic / fn_search_documents: zero hits
  },
};

const ftsRes = await handleToolCall(memoryConnections, "omatic_search_memory", { query: "anything" });
const fts = parse(ftsRes);
ok(fts.retrieval_mode === "fts_only", "F1 the no-vector path really did run FTS-only");
ok(fts.outcome === "degraded", "F1 FTS-only reports outcome=degraded, not complete");
ok(ftsRes.isError === false, "F1 degraded is not a protocol error — the data still returns");
ok(
  fts.degraded_reasons.some((r) => /query vector/i.test(r)),
  "F1 a degraded reason names the missing query vector"
);
ok(
  fts.degraded_reasons.some((r) => /pgvector_hybrid_retrieval/.test(r)),
  "F1 the degraded reason names the capability that did not run"
);

// Hit count is irrelevant — the marker is about which retrieval ran.
const hitConnections = {
  ...memoryConnections,
  query: async (_name, sql) => {
    if (/current_database\(\)/.test(sql)) return { rows: [{ db_name: "f_omatic", db_user: "u" }], count: 1 };
    if (/factory_config/.test(sql)) return { rows: [], count: 0 };
    if (/fn_record_retrieval_event/.test(sql)) return { rows: [{ event_id: 2 }], count: 1 };
    return { rows: [{ id: 1 }, { id: 2 }], count: 2 };
  },
};
const ftsHits = parse(await handleToolCall(hitConnections, "omatic_search_memory", { query: "anything" }));
ok(ftsHits.outcome === "degraded", "F1 FTS-only with hits is still degraded — hit count is irrelevant");

// An explicitly-requested mode=fts ran without a vector like any other.
const ftsExplicit = parse(await handleToolCall(memoryConnections, "omatic_search_memory", { query: "q", mode: "fts" }));
ok(ftsExplicit.outcome === "degraded", "F1 an explicitly requested mode=fts is marked degraded too");

// A caller-supplied vector is real hybrid retrieval and must stay clean.
const hybrid = parse(
  await handleToolCall(memoryConnections, "omatic_search_memory", {
    query: "q",
    embedding_vector: [0.1, 0.2, 0.3],
  })
);
ok(hybrid.retrieval_mode === "hybrid_pgvector", "F1 a supplied vector takes the hybrid path");
ok(hybrid.outcome === "complete", "F1 the marker does not fire when a query vector WAS used");

// ── A11 — side effects declared ──
const searchTool = surface.find((t) => t.name === "omatic_search_memory");
ok(/fn_record_retrieval_event/.test(searchTool.description), "A11 the telemetry write names the function it calls");
ok(/WRITES ON EVERY CALL/.test(searchTool.description), "A11 the tool description declares that it is not read-only");

// ── A6 — model-asserted probes are labeled, never promoted ──
const probeCalls = [];
const startupConnections = {
  ...fakeConnections(),
  query: async (_name, sql, params) => {
    if (/current_database\(\)/.test(sql)) return { rows: [{ db_name: "f_omatic", db_user: "u" }], count: 1 };
    if (/INSERT INTO factory_sessions/.test(sql)) {
      return { rows: [{ id: 4242, session_date: "2026-08-02", platform: "claude-code", session_type: "work" }], count: 1 };
    }
    if (/fn_seed_session_mcp_status/.test(sql)) return { rows: [{ seeded: 5 }], count: 1 };
    if (/fn_record_probe_result/.test(sql)) {
      probeCalls.push(params[0]);
      return { rows: [{ result: "ok" }], count: 1 };
    }
    if (/v_mcp_readiness/.test(sql)) return { rows: [{ connector_id: "postgres-omatic", status_label: "OK" }], count: 1 };
    if (/v_startup_summary/.test(sql)) return { rows: [{ open_task_total: "1" }], count: 1 };
    return { rows: [], count: 0 };
  },
};

const runRes = parse(
  await handleToolCall(startupConnections, "omatic_factory_startup_run", {
    probes: [
      { connector_name: "omatic-elementor", status: "connected", note: "I believe this works" },
      { connector_name: "filesystem", status: "connected" },
    ],
  })
);
ok(probeCalls.length === 1, `A6 exactly one probe was written to the registry (got ${probeCalls.length})`);
ok(probeCalls[0] === "postgres-omatic", "A6 the written probe is the one the plugin actually measured");
ok(!probeCalls.includes("omatic-elementor"), "A6 a caller-asserted probe never reaches fn_record_probe_result");
ok(runRes.asserted_probes.length === 2, "A6 caller-asserted probes are echoed back, not discarded");
ok(
  runRes.asserted_probes.every((p) => p.source === "caller_asserted" && p.recorded === false),
  'A6 asserted probes carry source="caller_asserted" and recorded=false'
);
ok(
  runRes.probe_results.every((p) => p.source === "plugin_measured" && p.recorded === true),
  'A6 measured probes are labeled source="plugin_measured"'
);

const startupRunTool = surface.find((t) => t.name === "omatic_factory_startup_run");
ok(
  /caller_asserted/.test(startupRunTool.inputSchema.properties.probes.description),
  "A6 the probes schema discloses that entries are not promoted to the registry"
);

// ── D5 — sslmode is never inferred from a hostname ──
const addConnTool = surface.find((t) => t.name === "omatic_add_connection");
ok(
  !/inferred from host/i.test(addConnTool.inputSchema.properties.ssl_mode.description),
  "D5 the ssl_mode schema no longer advertises host inference"
);
ok(
  /never inferred from the host/i.test(addConnTool.inputSchema.properties.ssl_mode.description),
  "D5 the ssl_mode schema states that the host is not consulted"
);
// Assert against CODE, not prose — the fix is documented in a comment that
// quotes the deleted expression, and a comment must not satisfy the test.
const toolsCode = require("node:fs")
  .readFileSync(resolve(here, "../server/tools.js"), "utf8")
  .split("\n")
  .filter((line) => !line.trim().startsWith("//"))
  .join("\n");
ok(!/startsWith\("100\./.test(toolsCode), "D5 the 100.x hostname branch is gone from tools.js");
ok(!/args\.host[^\n]*\?[^\n]*ssl/i.test(toolsCode), "D5 no ssl mode is selected from a host expression");
ok(
  !/ssl_mode\s*\|\|\s*\(/.test(toolsCode),
  "D5 ssl_mode has no conditional-inference fallback expression"
);

// Server instructions must not advertise tools that no longer exist.
const instructions = buildServerInstructions();
ok(
  !/omatic_factory_startup:factory-name/.test(instructions),
  "B8 server instructions no longer point at a removed pinned variant"
);
ok(
  /omatic_search_memory:name|omatic_execute_sql:name/.test(instructions),
  "B8 server instructions name pinned variants that actually exist"
);

if (failures.length) {
  console.error(`startup-modes smoke: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error("  FAIL:", f);
  process.exit(1);
}
console.log(`startup-modes smoke: ${pass} passed, 0 failed`);
