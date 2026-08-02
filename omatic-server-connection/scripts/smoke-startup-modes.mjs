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
  deriveBuiltInPostgresProbe,
  viewField,
  VIEW_COLUMNS,
  assertToolNamesSafe,
  hostVisibleToolName,
  MAX_BARE_TOOL_NAME_BYTES,
  HOST_TOOL_NAME_LIMIT,
  HOST_TOOL_NAMESPACE,
  // P4 (A5, A7, F1)
  probeIsMeasured,
  probeIsOk,
  probeState,
  probeCoverage,
  statusIcon,
} = __test__;

let pass = 0;
const failures = [];
const ok = (cond, msg) => (cond ? pass++ : failures.push(msg));

// queryResult shape mirrors optionalQuery output: { ok, rows, count }
const green = {
  // A12: `connector_id` is the column v_mcp_readiness actually exposes. This
  // fixture said `connector_name` and the assertion below still passed, because
  // the formatter guessed through an `||` chain — the fixture encoded the bug.
  //
  // A5: `probed_at` + `probe_result` are what make this row GREEN. Without a
  // measurement taken this session it is an inherited verdict, and the fixture
  // that omitted them was encoding exactly the defect A5 closes: a green label
  // with nothing behind it.
  readiness: {
    ok: true,
    rows: [
      {
        status_label: "OK",
        connector_id: "postgres-omatic",
        probe_result: "connected",
        probed_at: "2026-08-02T12:00:00Z",
        probe_note: null,
        criticality: "critical",
      },
    ],
  },
  embedding: { ok: true, rows: [{ stale: 0, unembedded: 0 }] },
  summary: {
    ok: true,
    // A12: `resume_notes` is the column v_startup_summary actually exposes.
    // This fixture said `last_summary`, a column the view has never had, and
    // the assertion passed anyway — the same defect one layer up, in the
    // VIEW_COLUMNS contract itself.
    rows: [{ governance_health: { active_rule_count: 40, rule_count_target: 40 }, open_task_total: "3", resume_notes: "resume here" }],
  },
  agreements: { ok: true, rows: [] },
  rules: { ok: true, rows: [] },
  loaded_skills: [],
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const warnConn = clone(green);
warnConn.readiness.rows[0].status_label = "DEGRADED";
warnConn.readiness.rows[0].probe_result = "unavailable";

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
// F1 (P4): this used to assert `results_trustworthy === true`. A degraded
// response with rows is amber, never clean — Smith's amendment — so the
// boolean is now false and the amber/red gradation moves to trust_level.
ok(degradedPayload.results_trustworthy === false, "F1 a degraded response is never results_trustworthy");
ok(degradedPayload.trust_level === "partial", "F1 degraded WITH rows is amber (trust_level=partial)");

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
// A9 — no_op, the fourth outcome state (issue #4)
// ══════════════════════════════════════════════════════════════════════════

// The regression this closes: a zero-row mutation used to be indistinguishable
// from an effective one, because both reported outcome="complete".
const noOpRes = runWithOutcome(() => {
  const c = currentOutcome();
  c.recordQuerySuccess(0);
  c.recordNoOp("omatic_release_work", "no active work_claims row matched; nothing was released");
  return successResponse({ available: true, released: [], count: 0 });
});
const noOpPayload = JSON.parse(noOpRes.content[0].text);
ok(noOpPayload.outcome === "no_op", "A9 a zero-row mutation reports outcome=no_op");
ok(noOpPayload.outcome !== "complete", "A9 a zero-row mutation is no longer reported as complete");
ok(noOpRes.isError === false, "A9 no_op is not an MCP protocol error");
ok(noOpPayload.success === true, "A9 no_op is not a failure — nothing went wrong");
ok(noOpPayload.no_op_reasons.length === 1, "A9 no_op_reasons carries the explanation");
ok(/release_work/.test(noOpPayload.no_op_reasons[0]), "A9 no_op_reasons names the mutation");
ok(noOpPayload.degraded_reasons.length === 0, "A9 a no-op is not a degradation");
ok(noOpPayload.results_trustworthy === true, "A9 a no_op's zero rows are a measured, trustworthy answer");

// An effective release must still be plainly distinguishable from the above.
const realReleaseRes = runWithOutcome(() => {
  currentOutcome().recordQuerySuccess(1);
  return successResponse({ available: true, released: [{ id: 1 }], count: 1 });
});
const realReleasePayload = JSON.parse(realReleaseRes.content[0].text);
ok(realReleasePayload.outcome === "complete", "A9 a release that did change a row stays complete");
ok(realReleasePayload.no_op_reasons.length === 0, "A9 an effective mutation records no no-op");

// Precedence: a real failure outranks a no-op, and both reason channels survive.
const noOpDegradedRes = runWithOutcome(() => {
  const c = currentOutcome();
  c.recordQuerySuccess(2);
  c.recordNoOp("omatic_release_work", "nothing matched");
  c.recordQueryFailure("SELECT * FROM v_embedding_health", new Error("boom"));
  return successResponse({ rows: [1, 2] });
});
const noOpDegradedPayload = JSON.parse(noOpDegradedRes.content[0].text);
ok(noOpDegradedPayload.outcome === "degraded", "A9 degradation outranks no_op");
ok(noOpDegradedPayload.degraded_reasons.length === 1, "A9 degraded reasons survive alongside a no-op");
ok(noOpDegradedPayload.no_op_reasons.length === 1, "A9 no-op reasons survive alongside a degradation");

// Failure still outranks everything.
const noOpFailedRes = runWithOutcome(() => {
  const c = currentOutcome();
  c.recordNoOp("omatic_release_work", "nothing matched");
  c.recordQueryFailure("SELECT 1", new Error("boom"));
  return successResponse({});
});
ok(JSON.parse(noOpFailedRes.content[0].text).outcome === "failed", "A9 total failure outranks no_op");

// The operator-stated invariant, still holding with a fourth state in play.
let noOpCompleteInvariantThrew = false;
try {
  const c = new OutcomeCollector();
  c.failures.push({ sql: "x", error: "y", connection: null });
  c.okQueryCount = 1;
  Object.defineProperty(c, "outcome", { value: () => "complete" });
  c.summarize();
} catch {
  noOpCompleteInvariantThrew = true;
}
ok(noOpCompleteInvariantThrew, "A9 complete + non-empty degraded_reasons still throws");

// complete must also be unreachable while a no-op is on the books.
let completeWithNoOpThrew = false;
try {
  const c = new OutcomeCollector();
  c.recordNoOp("m", "r");
  Object.defineProperty(c, "outcome", { value: () => "complete" });
  c.summarize();
} catch {
  completeWithNoOpThrew = true;
}
ok(completeWithNoOpThrew, "A9 complete + non-empty no_op_reasons throws the invariant");

// ...and an unbacked no_op is a wiring bug, not a quiet default.
let unbackedNoOpThrew = false;
try {
  const c = new OutcomeCollector();
  Object.defineProperty(c, "outcome", { value: () => "no_op" });
  c.summarize();
} catch {
  unbackedNoOpThrew = true;
}
ok(unbackedNoOpThrew, "A9 outcome=no_op with no recorded no-op throws the invariant");

// A handler cannot fake the new field any more than the old ones.
const spoofNoOpRes = runWithOutcome(() =>
  successResponse({ no_op_reasons: ["invented"], outcome: "no_op" })
);
const spoofNoOpPayload = JSON.parse(spoofNoOpRes.content[0].text);
ok(spoofNoOpPayload.outcome === "complete", "A9 handler cannot spoof outcome=no_op");
ok(spoofNoOpPayload.no_op_reasons.length === 0, "A9 handler cannot spoof no_op_reasons");

// A9 end-to-end: the layer is only half the fix — omatic_release_work has to
// actually call recordNoOp. This drives the real dispatcher against a stubbed
// connection so the wiring is covered, not just the collector.
function stubConnections(updateResult) {
  const cfg = { name: "omatic", host: "localhost", port: 5432, database: "o-matic", user: "u" };
  return {
    activeName: "omatic",
    names: () => ["omatic"],
    defaultName: () => "omatic",
    getConfig: () => cfg,
    project: () => ({ factory_id: "omatic", platform_profile: "claude-code", resolution: {} }),
    async query(_name, sql) {
      if (/current_database\(\)/.test(sql)) return { rows: [{ db_name: "o-matic", db_user: "u" }], count: 1 };
      if (/to_regclass/.test(sql)) return { rows: [{ relation: "public.work_claims" }], count: 1 };
      if (/UPDATE work_claims/.test(sql)) return updateResult;
      throw new Error(`unexpected SQL in stub: ${sql}`);
    },
  };
}

const releaseArgs = { resource_type: "task", resource_id: "T-1", claimed_by: "carver" };

const e2eNoOp = JSON.parse(
  (await handleToolCall(stubConnections({ rows: [], count: 0 }), "omatic_release_work", releaseArgs))
    .content[0].text
);
ok(e2eNoOp.outcome === "no_op", "A9 omatic_release_work reports no_op when no claim was held");
ok(e2eNoOp.count === 0, "A9 the zero count is still reported alongside no_op");
ok(/T-1/.test(e2eNoOp.no_op_reasons.join(" ")), "A9 the no-op reason names the resource that did not match");

const e2eReleased = JSON.parse(
  (await handleToolCall(
    stubConnections({ rows: [{ id: 1, status: "released" }], count: 1 }),
    "omatic_release_work",
    releaseArgs
  )).content[0].text
);
ok(e2eReleased.outcome === "complete", "A9 omatic_release_work stays complete when a claim was actually released");
ok(
  e2eNoOp.outcome !== e2eReleased.outcome,
  "A9 holding a claim and not holding one are now distinguishable from the outcome alone"
);

// ══════════════════════════════════════════════════════════════════════════
// A15 — the built-in probe reports the measurement, not the intention
// ══════════════════════════════════════════════════════════════════════════

// Both observations succeeded: connected is earned.
const probeGreen = deriveBuiltInPostgresProbe({ sessionId: 42, seedOk: true, seedValue: 7 });
ok(probeGreen.status === "connected", "A15 probe is connected when the INSERT and seed both succeeded");
ok(probeGreen.connector_name === "postgres-omatic", "A15 probe names the connector it measured");
ok(/session id 42/.test(probeGreen.note), "A15 probe note cites the observed session id");
ok(/returned 7/.test(probeGreen.note), "A15 probe note cites the observed seed value");
ok(
  !/database query path verified/.test(probeGreen.note),
  "A15 probe no longer emits the pre-written 'verified' note"
);

// Seed errored: the database is reachable, the readiness path is not.
const probeSeedFailed = deriveBuiltInPostgresProbe({
  sessionId: 42,
  seedOk: false,
  seedError: "function fn_seed_session_mcp_status(integer) does not exist",
});
ok(probeSeedFailed.status === "degraded", "A15 a failed seed degrades the probe instead of reporting connected");
ok(
  /fn_seed_session_mcp_status does not exist|does not exist/.test(probeSeedFailed.note),
  "A15 probe note carries the actual seed error"
);

// Seed ran but produced nothing — the silent case the old literal papered over.
const probeSeedEmpty = deriveBuiltInPostgresProbe({ sessionId: 42, seedOk: true, seedValue: null });
ok(probeSeedEmpty.status === "degraded", "A15 a seed that returned no value is not reported as connected");
ok(/produced no value/.test(probeSeedEmpty.note), "A15 probe note states the seed produced no value");

// No session anchored: nothing to be green about.
const probeNoSession = deriveBuiltInPostgresProbe({ sessionId: null, seedOk: true, seedValue: 1 });
ok(probeNoSession.status === "degraded", "A15 probe is degraded when no session id was returned");
ok(/no session id/.test(probeNoSession.note), "A15 probe note states no session id was returned");

// Defensive: a call with no observations at all must never be green.
ok(deriveBuiltInPostgresProbe().status === "degraded", "A15 probe with zero observations is degraded");
ok(
  deriveBuiltInPostgresProbe({}).status === "degraded",
  "A15 probe defaults to degraded rather than assuming success"
);

// The status must be reachable in both directions — a probe hard-wired to
// "degraded" would pass every assertion above and still be dishonest.
ok(
  new Set([
    deriveBuiltInPostgresProbe({ sessionId: 1, seedOk: true, seedValue: 1 }).status,
    deriveBuiltInPostgresProbe({ sessionId: 1, seedOk: false }).status,
  ]).size === 2,
  "A15 probe status actually varies with the observations"
);

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
legacyShaped.readiness.rows[0].probe_result = "unavailable";
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
    if (/v_mcp_readiness/.test(sql)) {
      return {
        rows: [
          {
            connector_id: "postgres-omatic",
            status_label: "OK",
            probe_result: "connected",
            probed_at: "2026-08-02T12:00:00Z",
            probe_note: null,
            criticality: "critical",
          },
        ],
        count: 1,
      };
    }
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
// A5 (P4): the built-in probe was hardcoded to "postgres-omatic" regardless of
// which connection carried the I/O. It now names the connection it actually
// exercised; fn_record_probe_result canonicalizes the postgres-cabinet-{name}
// form. fakeConnections()'s default connection is "omatic".
ok(
  probeCalls[0] === "postgres-cabinet-omatic",
  `A5 the written probe names the connection actually exercised (got ${probeCalls[0]})`
);
ok(
  runRes.probe_results[0].probed_connection === "omatic",
  "A5 the probe result records which connection was measured"
);
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
// A15: the pre-written probe literal must not come back. Comments are stripped
// above, so the surviving explanatory comment cannot satisfy this.
ok(
  !/database query path verified/.test(toolsCode),
  "A15 the hard-coded 'database query path verified' note is gone from tools.js"
);
ok(
  !/status:\s*"connected"/.test(toolsCode),
  "A15 no probe declares status:\"connected\" as a literal"
);
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

// ══════════════════════════════════════════════════════════════════════════
// P4 (issue #4: A5, A7, A12 follow-through, F1)
// ══════════════════════════════════════════════════════════════════════════

// ── A5 — probes assert measurement, not memory ──
//
// fn_seed_session_mcp_status writes probe_result='untested' with probed_at
// NULL and demotes any prior verdict to a note. The plugin must not undo that.
const untestedRow = {
  connector_id: "omatic-elementor",
  status_label: "DEGRADED",
  probe_result: "untested",
  probed_at: null,
  probe_note: "Not probed this session. Prior verdict: connected as of 2026-06-16",
  criticality: "standard",
};
// The dangerous shape: a green label with no measurement behind it. The DB no
// longer produces this, but the plugin must not be the thing that trusts it if
// anything ever does — an inherited verdict wearing a current label is exactly
// what A5 forbids presenting as current.
const inheritedOkRow = {
  connector_id: "filesystem",
  status_label: "OK",
  probe_result: "connected",
  probed_at: null,
  probe_note: "Not probed this session. Prior verdict: connected as of 2026-06-13",
  criticality: "standard",
};

ok(probeIsMeasured(green.readiness.rows[0]) === true, "A5 a row with probed_at counts as measured");
ok(probeIsMeasured(untestedRow) === false, "A5 an untested row is not measured");
ok(probeIsMeasured(inheritedOkRow) === false, "A5 status_label=OK with probed_at NULL is NOT a measurement");
ok(probeIsOk(inheritedOkRow) === false, "A5 an inherited verdict never counts as OK");
ok(probeState(untestedRow) === "UNTESTED", "A5 an unprobed connector reports UNTESTED, not its label");
ok(probeState(inheritedOkRow) === "UNTESTED", "A5 a restamped OK reports UNTESTED");
ok(probeState(green.readiness.rows[0]) === "OK", "A5 a genuinely measured OK still reports OK");

// statusIcon: the labels v_mcp_readiness actually emits must not read benign.
ok(statusIcon("CRITICAL-DOWN") === "FAIL", "A5 CRITICAL-DOWN renders FAIL, not INFO");
ok(statusIcon("REDUCED") === "WARN", "A5 REDUCED renders WARN, not INFO");
ok(statusIcon("untested") === "WARN", "A5 untested renders WARN, not INFO");
ok(statusIcon("BLOCKED") === "FAIL", "A5 BLOCKED renders FAIL");
ok(statusIcon("OK") === "OK", "A5 OK still renders OK");

// Full view: untested is named, carries its prior verdict as history, and
// denies GREEN.
const mixed = clone(green);
mixed.readiness.rows.push(clone(untestedRow), clone(inheritedOkRow));
const mixedView = formatStartupView({ startup: mixed, session: {}, identity: {}, factory: {} });
ok(/omatic-elementor: UNTESTED \(not probed this session\)/.test(mixedView), "A5 full view names the unprobed connector");
ok(/filesystem: UNTESTED/.test(mixedView), "A5 full view reports an inherited OK as UNTESTED");
ok(!/filesystem: OK/.test(mixedView), "A5 full view never renders an unmeasured connector as OK");
ok(/Prior verdict: connected/.test(mixedView), "A5 the demoted prior verdict is surfaced as history");
ok(/1\/3 connectors measured OK/.test(mixedView), "A5 only measured connectors count toward the OK tally");
ok(/2 never probed this session/.test(mixedView), "A5 the unprobed count is stated, not omitted");
ok(/Factory status: CHECK/.test(mixedView), "A5 unprobed connectors deny a GREEN factory status");
ok(!/Factory status: GREEN/.test(mixedView), "A5 a partly-unprobed factory is never GREEN");
ok(/Probe coverage: 1\/3 measured this session/.test(mixedView), "A5 full view states probe coverage in words");

// A fully-measured factory is still allowed to be GREEN — the point is honesty,
// not pessimism.
ok(/Factory status: GREEN/.test(formatStartupView({ startup: green, session: {}, identity: {}, factory: {} })), "A5 a fully measured factory still reports GREEN");

// Fast view: untested is an UNKNOWN, and UNKNOWNs suppress GREEN.
const mixedFast = formatFastStartupView({ mode: "fast", startup: mixed, session: {}, identity: {}, factory: {} });
ok(!/Status: GREEN/.test(mixedFast), "A5 fast view is never GREEN with unprobed connectors");
ok(/Status: UNKNOWN/.test(mixedFast), "A5 fast view reports UNKNOWN when probes are missing");
ok(/not probed this session/.test(mixedFast), "A5 fast view says why");
ok(!/could not be read/.test(mixedFast), "A5 fast view no longer miscalls an unprobed connector an unreadable source");

// Critical unprobed connectors are named individually; the rest collapse.
const manyUntested = clone(green);
for (let i = 0; i < 12; i += 1) {
  manyUntested.readiness.rows.push({ ...clone(untestedRow), connector_id: `enh-${i}`, criticality: "enhancement" });
}
manyUntested.readiness.rows.push({ ...clone(untestedRow), connector_id: "postgres-lucidit", criticality: "critical" });
const manyFast = formatFastStartupView({ mode: "fast", startup: manyUntested, session: {}, identity: {}, factory: {} });
ok(/CRITICAL connector postgres-lucidit not probed/.test(manyFast), "A5 an unprobed CRITICAL connector is named individually");
ok(/12 non-critical connectors not probed this session/.test(manyFast), "A5 non-critical unprobed connectors collapse to one line");

// probe_coverage travels in the packet, not only in the rendered text.
const coverage = probeCoverage(mixed.readiness.rows, true);
ok(coverage.total === 3 && coverage.measured_this_session === 1 && coverage.untested === 2, "A5 probe_coverage counts measured vs untested");
ok(coverage.untested_connectors.some((c) => /Prior verdict/.test(c.prior_verdict_note || "")), "A5 probe_coverage carries the demoted prior verdict");
// Unprobed connectors drop the RESPONSE to degraded, not just the rendered
// text. A startup that reports `complete` while connectors carry no
// measurement is asserting something it never checked.
const partiallyProbed = {
  ...startupConnections,
  query: async (name, sql, params) => {
    if (/v_mcp_readiness/.test(sql)) {
      return {
        rows: [
          { connector_id: "postgres-omatic", status_label: "OK", probe_result: "connected", probed_at: "2026-08-02T12:00:00Z", probe_note: null, criticality: "critical" },
          { connector_id: "omatic-elementor", status_label: "DEGRADED", probe_result: "untested", probed_at: null, probe_note: "Not probed this session. Prior verdict: connected as of 2026-06-16", criticality: "standard" },
        ],
        count: 2,
      };
    }
    return startupConnections.query(name, sql, params);
  },
};
const partialStartup = parse(await handleToolCall(partiallyProbed, "omatic_factory_startup", {}));
ok(partialStartup.outcome === "degraded", `A5 unprobed connectors make the startup response degraded (got ${partialStartup.outcome})`);
ok(partialStartup.results_trustworthy === false, "A5 a startup with unmeasured connectors is not clean");
ok(
  partialStartup.degraded_reasons.some((r) => /connector_probe_coverage/.test(r) && /omatic-elementor/.test(r)),
  "A5 the unmeasured connector is named in degraded_reasons"
);
ok(partialStartup.startup.probe_coverage.untested === 1, "A5 probe_coverage ships inside the startup packet");
// A fully-measured startup is still clean — honesty, not blanket pessimism.
const fullyProbed = parse(await handleToolCall(startupConnections, "omatic_factory_startup", {}));
ok(fullyProbed.outcome === "complete", `A5 a fully measured startup stays complete (got ${fullyProbed.outcome})`);

// A13 follow-on: the health check inherits that verdict rather than reporting HEALTHY.
const partialHealth = parse(await handleToolCall(partiallyProbed, "omatic_factory_health_check", {}));
ok(partialHealth.health === "DEGRADED", `A5 health check reports DEGRADED when probes are missing (got ${partialHealth.health})`);

const blindCoverage = probeCoverage([], false);
ok(blindCoverage.readable === false && blindCoverage.untested === "UNKNOWN", "A5 unreadable readiness yields UNKNOWN coverage, not zero");
ok(blindCoverage.measured_this_session !== 0, "A5 unreadable readiness never reports 0 measured as if it were a finding");

// ── A7 — inspection tools declare their search scope ──
//
// omatic_embedding_status filtered schemaname='public'. Against `kb`, where
// both tables live in a `kb` schema carrying 2 HNSW and 2 GIN indexes, it
// returned ok:true / count:0 / warning:null — indistinguishable from a
// correctly-scoped finding of zero.
const kbShaped = (schema = "kb") => ({
  ...fakeConnections(),
  query: async (_name, sql, params) => {
    if (/current_database\(\)/.test(sql)) return { rows: [{ db_name: "f_omatic", db_user: "u" }], count: 1 };
    // The locator runs UNFILTERED by schema — that is the whole fix.
    if (/FROM pg_class c/.test(sql) && /c\.relname = ANY/.test(sql)) {
      if (!schema) return { rows: [], count: 0 };
      return {
        rows: [
          { schema_name: schema, table_name: "document_chunks" },
          { schema_name: schema, table_name: "semantic_index" },
        ],
        count: 2,
      };
    }
    if (/FROM pg_indexes/.test(sql)) {
      const schemas = params[0] || [];
      if (!schemas.includes(schema)) return { rows: [], count: 0 };
      return {
        rows: [
          { schemaname: schema, tablename: "document_chunks", indexname: "idx_kb_chunks_fts", indexdef: "USING gin (tsv)" },
          { schemaname: schema, tablename: "document_chunks", indexname: "idx_kb_chunks_hnsw", indexdef: "USING hnsw (embedding vector_cosine_ops)" },
          { schemaname: schema, tablename: "semantic_index", indexname: "idx_kb_si_fts", indexdef: "USING gin (tsv)" },
          { schemaname: schema, tablename: "semantic_index", indexname: "idx_kb_si_hnsw", indexdef: "USING hnsw (embedding vector_cosine_ops)" },
        ],
        count: 4,
      };
    }
    if (/pg_extension/.test(sql)) return { rows: [{ extname: "vector", extversion: "0.8.2" }], count: 1 };
    return { rows: [], count: 0 };
  },
});

const kbStatus = parse(await handleToolCall(kbShaped(), "omatic_embedding_status", {}));
ok(kbStatus.pgvector_status.hnsw_index_count === 2, `A16 embedding_status finds the HNSW indexes in a non-public schema (got ${kbStatus.pgvector_status.hnsw_index_count})`);
ok(kbStatus.pgvector_status.gin_index_count === 2, `A16 embedding_status finds the GIN indexes in a non-public schema (got ${kbStatus.pgvector_status.gin_index_count})`);
ok(
  kbStatus.pgvector_status.hnsw_index_count + kbStatus.pgvector_status.gin_index_count === 4,
  "A16 all 4 indexes on the kb-shaped connection are reported"
);
ok(JSON.stringify(kbStatus.scope.searched_schemas) === '["kb"]', "A7 the response declares the schemas it searched");
ok(kbStatus.pgvector_status.searched_schemas.includes("kb"), "A7 index counts travel with their scope");
ok(kbStatus.scope.missing_tables.length === 0, "A7 no target table is reported missing when both were located");
ok(kbStatus.pgvector_status.warning === null, "A7 a correctly-scoped, complete search carries no warning");
ok(kbStatus.indexes.searched_schemas.includes("kb"), "A7 the raw index result carries its filter");
ok(kbStatus.table_columns.searched_schemas.includes("kb"), "A7 the raw column result carries its filter");

// A target outside the searched schemas is degraded, not zero.
const emptyStatus = parse(await handleToolCall(kbShaped(null), "omatic_embedding_status", {}));
ok(emptyStatus.outcome === "degraded", `A7 a target absent from every searched schema is degraded, not complete (got ${emptyStatus.outcome})`);
ok(emptyStatus.results_trustworthy === false, "A7 a zero-index result from a degraded scope is not trustworthy");
ok(emptyStatus.pgvector_status.hnsw_index_count === 0, "A7 the count is still zero");
ok(emptyStatus.pgvector_status.warning !== null, "A7 but the zero now carries a warning explaining it");
ok(/target absent/.test(emptyStatus.pgvector_status.warning), "A7 the warning distinguishes 'absent' from 'present and unindexed'");
ok(
  emptyStatus.degraded_reasons.some((r) => /embedding_target_tables/.test(r)),
  "A7 the missing target is named in degraded_reasons"
);

// The hardcoded filter must be gone from the CODE, not just from the output —
// the fake connection above cannot see a SQL change, so this is asserted
// against the source. Every literal form of the pin is covered, because the
// first fix only removed the one spelling the bug report happened to quote.
for (const pin of [
  /schemaname\s*=\s*'public'/,
  /table_schema\s*=\s*'public'/,
  /nspname\s*=\s*'public'/,
  /to_regclass\(\s*`public\./,
  /'public\.\$\{/,
]) {
  ok(!pin.test(toolsCode), `A7 no hardcoded public-schema pin matching ${pin} remains in tools.js`);
}
// The scope must be resolved before it is used, not defaulted.
ok(/resolveEmbeddingScope/.test(toolsCode), "A7 embedding status resolves its schema scope");
ok(
  /searched_schemas/.test(toolsCode),
  "A7 the searched schemas are part of the response contract"
);

// A7 applied to the other schema-filtered probe: omatic_claim_work gated on
// to_regclass('public.work_claims') while its INSERT referenced the table
// unqualified. Absence must now say where it looked.
const noClaims = {
  ...fakeConnections(),
  query: async (_name, sql) => {
    if (/current_database\(\)/.test(sql)) return { rows: [{ db_name: "f_omatic", db_user: "u" }], count: 1 };
    if (/to_regclass/.test(sql)) {
      return { rows: [{ relation: null, schema_name: null, search_path: ["pg_catalog", "public"] }], count: 1 };
    }
    return { rows: [], count: 0 };
  },
};
const claimMiss = parse(await handleToolCall(noClaims, "omatic_claim_work", { resource_type: "t", resource_id: "r", claimed_by: "c" }));
ok(claimMiss.available === false, "A7 an unresolvable work_claims still reports available:false");
ok(
  JSON.stringify(claimMiss.searched_schemas) === '["pg_catalog","public"]',
  "A7 claim_work discloses the search_path it resolved against"
);
ok(/pg_catalog, public/.test(claimMiss.message), "A7 the absence message names the schemas searched");
ok(claimMiss.outcome === "degraded", "A7 an unresolvable capability is degraded, not complete");
// The unqualified probe must match the DML it gates.
ok(!/to_regclass\(\$1\)[\s\S]{0,80}public\./.test(toolsCode), "A7 the work_claims probe is not pinned to the public schema");
ok(/current_schemas\(true\)::text\[\]/.test(toolsCode), "A7 the search_path is cast to text[] so the driver actually parses it");

// ── A12 follow-through — every declared column exists on its source view ──
//
// Captured from information_schema.columns on the live factory DB (o-matic,
// 2026-08-02). VIEW_COLUMNS declaring a column absent from this map is the same
// defect as a formatter reading one: `last_resume_notes` and `last_summary`
// were declared for two releases and resolved to null on every single call.
const LIVE_VIEW_COLUMNS = {
  readiness: "connector_id, display_name, criticality, category, agent_primary, platform_availability, fallback_behavior, probe_result, fallback_active, probe_note, probed_at, status_label".split(", "),
  embedding: "tier, tenant_id, total_rows, embedded, unembedded, stale, distinct_models, oldest_embed, newest_embed".split(", "),
  summary: "last_session_id, session_date, platform, session_type, resume_notes, open_tasks, open_task_total, p1_tasks, agents, embedding_health, decommissioned_terms, sop_index, governance_health".split(", "),
  agreements: "agent_name, agreement_version, enforcement_model, required_rule_types, loaded_rules, tenant_id, missing_rule_types, status_label".split(", "),
  rules: "id, enforcement, rule, category, rule_type, agent, applies_to, tenant_id, updated_at".split(", "),
};
for (const [source, declared] of Object.entries(VIEW_COLUMNS)) {
  const live = LIVE_VIEW_COLUMNS[source];
  ok(Array.isArray(live), `A12 view source "${source}" has a recorded live column list`);
  const phantom = (live ? declared.filter((c) => !live.includes(c)) : declared);
  ok(phantom.length === 0, `A12 VIEW_COLUMNS.${source} declares no column the view lacks (phantom: ${phantom.join(", ")})`);
}
for (const removed of ["last_resume_notes", "last_summary"]) {
  let threw = false;
  try {
    viewField("summary", { [removed]: "x" }, removed);
  } catch {
    threw = true;
  }
  ok(threw, `A12 the phantom column "${removed}" is no longer readable through the contract`);
}
// And the fast view now actually finds the resume point it was always missing.
ok(/Resume: resume here/.test(gv), "A12 the fast view reads resume_notes, the column the view really has");

// ── F1 — a degraded response is never a clean one ──
const trustCases = [
  ["complete", (c) => c.recordQuerySuccess(3), true, "trusted"],
  ["degraded with rows", (c) => { c.recordQuerySuccess(3); c.recordQueryFailure("SELECT 1", new Error("x")); }, false, "partial"],
  ["degraded with zero rows", (c) => { c.recordQuerySuccess(0); c.recordUnavailable("work_claims", "absent"); }, false, "untrusted"],
  ["failed", (c) => c.recordQueryFailure("SELECT 1", new Error("x")), false, "untrusted"],
];
for (const [label, setup, expectTrust, expectLevel] of trustCases) {
  const payload = JSON.parse(
    runWithOutcome(() => {
      setup(currentOutcome());
      return successResponse({ rows: [] });
    }).content[0].text
  );
  ok(payload.results_trustworthy === expectTrust, `F1 ${label}: results_trustworthy=${expectTrust}`);
  ok(payload.trust_level === expectLevel, `F1 ${label}: trust_level=${expectLevel} (got ${payload.trust_level})`);
}
// The specific hole F1 closes: rows from ONE query no longer launder a failure
// in another into a clean envelope.
const launderPayload = JSON.parse(
  runWithOutcome(() => {
    const c = currentOutcome();
    c.recordQuerySuccess(40); // an unrelated query answered
    c.recordQueryFailure("SELECT * FROM v_embedding_health", new Error("relation does not exist"));
    return successResponse({ rows: [] });
  }).content[0].text
);
ok(launderPayload.results_trustworthy === false, "F1 rows from one query cannot launder another query's failure");
ok(launderPayload.trust_level === "partial", "F1 that case is amber, not green and not red");

// trust_level is computed, never accepted from a handler.
const spoofTrust = JSON.parse(
  runWithOutcome(() => {
    currentOutcome().recordQueryFailure("SELECT 1", new Error("boom"));
    return successResponse({ trust_level: "trusted", results_trustworthy: true });
  }).content[0].text
);
ok(spoofTrust.trust_level === "untrusted", "F1 a handler cannot spoof trust_level");

// ══════════════════════════════════════════════════════════════════════════
// P3 — the shipped docs must not advertise tools that do not exist
// ══════════════════════════════════════════════════════════════════════════
//
// The B8 cut took the surface from 99 to 34 and removed 10 pinned families,
// but the README and the setup command kept describing the old one. Docs drift
// silently; this pins them to the real surface.
const fsMod = require("node:fs");
const docSurface = buildToolList({
  activeName: "omatic",
  names: () => ["omatic", "kb"],
  defaultName: () => "omatic",
  getConfig: (n) => ({ name: n, host: "h", port: 5432, database: `db_${n}`, user: "u" }),
  project: () => ({ factory_id: "omatic", platform_profile: "claude-code", resolution: {} }),
});
const realToolNames = new Set(docSurface.map((t) => t.name));
const realPinnedFamilies = new Set(
  docSurface.filter((t) => t.name.includes(":")).map((t) => t.name.split(":")[0])
);

ok(realPinnedFamilies.size === 3, "P3 exactly three pinned families exist");
for (const fam of ["omatic_execute_sql", "omatic_search_memory", "omatic_list_tasks"]) {
  ok(realPinnedFamilies.has(fam), `P3 ${fam} is a real pinned family`);
}
ok(
  !realPinnedFamilies.has("omatic_factory_startup_run"),
  "P3 omatic_factory_startup_run is NOT pinnable (the docs used to claim it was)"
);

// Every `omatic_x:{...}` pinned form a doc advertises must be a real family.
// Excludes the README's explicit table of REMOVED tools, which is under a
// heading that says so.
const docFiles = [
  ["README.md", "../README.md"],
  ["commands/omatic-setup.md", "../commands/omatic-setup.md"],
  ["skills/orch-o-matic-probot/SKILL.md", "../skills/orch-o-matic-probot/SKILL.md"],
];
for (const [label, rel] of docFiles) {
  const text = fsMod.readFileSync(resolve(here, rel), "utf8");
  // A doc line may legitimately name a cut tool in exactly two places: the
  // removed-tools migration table, and a historical changelog entry that marks
  // itself superseded. Everything else is an advertisement and must be real.
  let inRemovedTable = false;
  const body = text
    .split("\n")
    .filter((line) => {
      if (/^\s*### What was removed/.test(line)) {
        inRemovedTable = true;
        return false;
      }
      if (inRemovedTable && /^\s*###\s/.test(line)) inRemovedTable = false;
      if (inRemovedTable) return false;
      return !/\(Superseded in [0-9]/i.test(line);
    })
    .join("\n");
  const claimed = [...body.matchAll(/`(omatic_[a-z_]+):\{?[a-z-]+\}?`/g)].map((m) => m[1]);
  const bogus = [...new Set(claimed)].filter((n) => !realPinnedFamilies.has(n));
  ok(bogus.length === 0, `P3 ${label} advertises only real pinned families (found: ${bogus.join(", ")})`);

  // No doc outside the removed table may present the cut raw-SQL aliases as usable.
  ok(
    !/`o-matic-server-[^`]*:execute_sql`|`postgres-cabinet-[^`]*:execute_sql`/.test(body),
    `P3 ${label} does not advertise the removed raw execute_sql aliases`
  );

  // Unsuffixed tool names named in backticks must exist.
  const named = [...body.matchAll(/`(omatic_[a-z_]+)`/g)].map((m) => m[1]);
  const missing = [...new Set(named)].filter((n) => !realToolNames.has(n));
  ok(missing.length === 0, `P3 ${label} names only tools that exist (missing: ${missing.join(", ")})`);
}

// The README must actually carry the 3.0 breaking-change guidance.
const readmeText = fsMod.readFileSync(resolve(here, "../README.md"), "utf8");
ok(/BREAKING/.test(readmeText), "P3 README documents the breaking change");
ok(/omatic_set_active_connection/.test(readmeText), "P3 README documents the set_active_connection migration");
ok(/omatic_select_factory/.test(readmeText), "P3 README documents the select_factory migration");
ok(
  /Codex[\s\S]{0,400}?restart/i.test(readmeText),
  "P3 README warns Codex users they must restart deliberately"
);
ok(
  /never prompted to update/i.test(readmeText),
  "P3 README states Codex users are never prompted to update"
);

if (failures.length) {
  console.error(`startup-modes smoke: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error("  FAIL:", f);
  process.exit(1);
}
console.log(`startup-modes smoke: ${pass} passed, 0 failed`);
