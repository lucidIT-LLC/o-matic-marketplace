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
  // #166 (b) probe recency, #165 payload scoping (decision #246)
  probeIsRecorded,
  probeIsStale,
  probeAgeMs,
  formatProbeAge,
  PROBE_FRESH_WINDOW_MS,
  scopeFactoryForMode,
  deriveLoadedSkills,
  loadCommonsState,
  loadOperatorProfileState,
} = __test__;

let pass = 0;
const failures = [];
const ok = (cond, msg) => (cond ? pass++ : failures.push(msg));

// #166 (b): probe freshness is now a 15-minute window, so a fixture cannot
// hard-code a timestamp. The old fixtures said "2026-08-02T12:00:00Z", which was
// "today" the day they were written and is permanently stale now — exactly the
// class of rot the window exists to expose. Ages are expressed relative to the
// run instead.
const minutesAgo = (m) => new Date(Date.now() - m * 60000).toISOString();
const RECENT = minutesAgo(2); // inside the 15-minute window
const LONG_AGO = minutesAgo(9 * 60); // the 09:00-probe-read-at-18:00 case Smith described

// A READY roster for every agent the closed factory ships. Smith C1: the green
// fixture used to be `agreements: { ok: true, rows: [] }` — an EMPTY roster —
// and the suite asserted GREEN against it. That certified the exact production
// defect: fast wake printing GREEN while zero Agreements are loaded. A green
// fixture must describe a factory that is actually green.
const readyAgreement = (agent, loadedRules = 27) => ({
  agent_name: agent,
  status_label: "READY",
  agreement_version: "2026-02",
  enforcement_model: "halt_on_missing",
  loaded_rules: loadedRules,
});
const READY_ROSTER = ["brandy", "carver", "data", "fred", "monet", "probot"].map((a) => readyAgreement(a));

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
        probed_at: RECENT,
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
  agreements: { ok: true, rows: READY_ROSTER },
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

// ── Smith C1 (decision #246): fast wake must be able to SEE a broken Agreement ──
//
// This block is the whole reason #165 could not ship first. formatFastStartupView
// contained zero references to startup.agreements, and the fixture above used to
// declare an EMPTY roster while this file asserted GREEN against it. The suite
// was pinning the defect: a factory with no Agreement loaded printed
// "Status: GREEN — no red/yellow items."
//
// Case 1 — halt_on_missing agent with zero loaded rules. The literal halt input
// from decision #188 (loaded_rules = 0).
const brokenAgreement = clone(green);
brokenAgreement.agreements.rows = [
  readyAgreement("probot", 47),
  { ...readyAgreement("carver", 0), loaded_rules: 0 },
];
const bav = formatFastStartupView({
  mode: "fast",
  startup: brokenAgreement,
  session: { id: 9 },
  identity: {},
  factory: {},
});
ok(!/Status: GREEN/.test(bav), "C1 a broken Agreement denies GREEN in the fast view");
ok(/HALT/.test(bav), "C1 the fast view calls a broken halt_on_missing Agreement a HALT");
ok(/carver/.test(bav), "C1 the fast view NAMES the failing agent");
ok(!/RED: agreement probot/.test(bav), "C1 the healthy agent is not flagged");

// Case 2 — halt_on_missing agent whose status is not READY, rules loaded or not.
const notReadyAgreement = clone(green);
notReadyAgreement.agreements.rows = [readyAgreement("probot", 47), { ...readyAgreement("smith", 26), status_label: "MISSING_RULES" }];
const nrv = formatFastStartupView({ mode: "fast", startup: notReadyAgreement, session: {}, identity: {}, factory: {} });
ok(!/Status: GREEN/.test(nrv), "C1 a non-READY halt_on_missing Agreement denies GREEN");
ok(/smith/.test(nrv), "C1 the non-READY agent is named");

// Case 3 — the original fixture's own shape. An EMPTY roster is not a green
// factory, it is an unverified one, and it must never read GREEN again.
const emptyRoster = clone(green);
emptyRoster.agreements = { ok: true, rows: [] };
const erv = formatFastStartupView({ mode: "fast", startup: emptyRoster, session: {}, identity: {}, factory: {} });
ok(!/Status: GREEN/.test(erv), "C1 an EMPTY agreement roster is not GREEN (the fixture that certified the bug)");
ok(/EMPTY/.test(erv), "C1 the empty roster is stated in words, not silently skipped");

// Case 4 — an unreadable agreement source is UNKNOWN, never GREEN.
const unreadableAgreements = clone(green);
unreadableAgreements.agreements = { ok: false, error: "relation v_agent_agreement does not exist" };
const uav = formatFastStartupView({ mode: "fast", startup: unreadableAgreements, session: {}, identity: {}, factory: {} });
ok(!/Status: GREEN/.test(uav), "C1 an unreadable agreement roster is not GREEN");
ok(/agent agreements unreadable/.test(uav), "C1 the unreadable agreement source is named");

// Case 5 — an advisory (non-halt_on_missing) agreement with zero rules is a
// finding for the full view, not a fast-wake HALT. The condition is specific.
const advisoryAgreement = clone(green);
advisoryAgreement.agreements.rows = [
  readyAgreement("probot", 47),
  { ...readyAgreement("jake", 0), enforcement_model: "advisory", loaded_rules: 0 },
];
const adv = formatFastStartupView({ mode: "fast", startup: advisoryAgreement, session: {}, identity: {}, factory: {} });
ok(!/HALT/.test(adv), "C1 an advisory agreement with 0 rules is not a HALT");

// ── #166 (b): the 15-minute recency window ──
//
// probeIsMeasured had NO recency test at all. Session identity was the only
// freshness bound in the system, and #166 (a) was about to remove it.
const staleProbe = clone(green);
staleProbe.readiness.rows[0].probed_at = LONG_AGO;
const spv = formatFastStartupView({ mode: "fast", startup: staleProbe, session: {}, identity: {}, factory: {} });
ok(!/Status: GREEN/.test(spv), "#166b a probe outside the freshness window denies GREEN");
ok(/STALE/.test(spv), "#166b a stale probe is labelled STALE, never OK");
ok(/9h ago/.test(spv), "#166b the fast view renders the age of a stale measurement");
ok(!/OK/.test(spv.split("\n").find((l) => /postgres-omatic/.test(l)) || ""), "#166b a stale connector never renders as OK");

const spFull = formatStartupView({
  startup: staleProbe,
  session: { id: 5, platform: "claude-code" },
  identity: { db_name: "o-matic", db_user: "u" },
  factory: {},
});
ok(!/Factory status: GREEN/.test(spFull), "#166b the full view also refuses GREEN on a stale probe");
ok(/STALE \(last probed 9h ago, was OK\)/.test(spFull), "#166b the full view renders stale with its age and its prior label");

// The age is rendered on GOOD measurements too — a reader who cannot date a
// green has to take it on faith.
ok(/probed \d+m ago/.test(formatStartupView({ startup: green, session: {}, identity: {}, factory: {} })), "#166b a fresh OK renders its age");

// The window boundary, both sides, driven by an injected clock so the test is
// deterministic rather than dependent on how long the suite takes to run.
const atEdge = { connector_id: "c", status_label: "OK", probe_result: "connected", probe_note: null, criticality: "critical", probed_at: new Date(1_000_000_000_000).toISOString() };
ok(probeIsMeasured(atEdge, 1_000_000_000_000 + 15 * 60 * 1000) === true, "#166b exactly 15 minutes old is still measured");
ok(probeIsMeasured(atEdge, 1_000_000_000_000 + 15 * 60 * 1000 + 1) === false, "#166b one millisecond past the window is not measured");
ok(probeIsStale(atEdge, 1_000_000_000_000 + 15 * 60 * 1000 + 1) === true, "#166b past the window it is STALE");
ok(probeIsRecorded(atEdge) === true, "#166b a stale probe is still RECORDED — it was genuinely measured, just not recently");
ok(PROBE_FRESH_WINDOW_MS === 15 * 60 * 1000, "#166b the window is 15 minutes, as Smith specified");

// probed_at IS NULL still reports UNKNOWN, not STALE. Task #166's third
// acceptance criterion, preserved verbatim.
const neverProbedRow = { connector_id: "c", status_label: "OK", probe_result: "untested", probed_at: null, probe_note: null, criticality: "critical" };
ok(probeIsRecorded(neverProbedRow) === false, "#166b probed_at NULL is not RECORDED");
ok(probeIsStale(neverProbedRow) === false, "#166b probed_at NULL is UNTESTED, not STALE");
ok(probeState(neverProbedRow) === "UNTESTED", "#166b probed_at NULL still reports UNTESTED");

// An unparseable timestamp must not read as fresh.
const badStamp = { ...atEdge, probed_at: "not-a-date" };
ok(probeIsMeasured(badStamp) === false, "#166b an unparseable probed_at is not a fresh measurement");

// probe_coverage: three buckets, and stale is NEVER folded into measured.
const coverage3 = probeCoverage(
  [
    { connector_id: "fresh", status_label: "OK", probe_result: "connected", probed_at: RECENT, probe_note: null, criticality: "critical" },
    { connector_id: "old", status_label: "OK", probe_result: "connected", probed_at: LONG_AGO, probe_note: null, criticality: "standard" },
    { connector_id: "never", status_label: "OK", probe_result: "untested", probed_at: null, probe_note: "prior: connected", criticality: "standard" },
  ],
  true
);
ok(coverage3.measured === 1, "#166b probe_coverage counts only fresh probes as measured");
ok(coverage3.stale === 1, "#166b probe_coverage reports stale as its own bucket");
ok(coverage3.untested === 1, "#166b probe_coverage still reports untested");
ok(coverage3.measured + coverage3.stale + coverage3.untested === coverage3.total, "#166b the three buckets partition the connector list");
ok(coverage3.stale_connectors[0].connector_id === "old", "#166b the stale connector is named");
ok(/ago$/.test(coverage3.stale_connectors[0].age || ""), "#166b the stale connector carries its age");
ok(coverage3.freshness_window_minutes === 15, "#166b probe_coverage states the window it used");

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
ok(probeGreen.connector_name === "omatic-server-omatic", "A15 probe names the connector it measured");
ok(/session id 42/.test(probeGreen.note), "A15 probe note cites the observed session id");
ok(/returned 7/.test(probeGreen.note), "A15 probe note cites the observed seed value");
ok(
  !/database query path verified/.test(probeGreen.note),
  "A15 probe no longer emits the pre-written 'verified' note"
);

// ── Smith M3 (decision #246): PIN THIS BEFORE ADOPTING SESSION REUSE ──
//
// fn_seed_session_mcp_status ends with ON CONFLICT (session_id, connector_id)
// DO NOTHING and returns GET DIAGNOSTICS ROW_COUNT. On a REUSED session every
// row conflicts, so it returns 0 — a correct result meaning "already seeded",
// not a failure. deriveBuiltInPostgresProbe tests
// `seedValue !== null && seedValue !== undefined`, so 0 passes and the probe
// stays connected.
//
// That is correct today and exactly ONE truthiness refactor — `if (seedValue)`,
// `seedValue > 0`, `Boolean(seedValue)` — away from making EVERY reused-session
// startup self-report degraded. #166 (a) makes reuse the common path, so the
// blast radius went from zero to every second startup of the day. Pinned.
const probeReusedSession = deriveBuiltInPostgresProbe({ sessionId: 42, seedOk: true, seedValue: 0 });
ok(
  probeReusedSession.status === "connected",
  `M3 seedValue === 0 keeps the probe connected — a reused session seeds nothing and that is success (got ${probeReusedSession.status})`
);
ok(/returned 0/.test(probeReusedSession.note), "M3 the probe note reports the observed 0 rather than hiding it");
// The genuinely absent cases stay degraded, so the test above cannot be
// satisfied by making the check unconditional.
ok(
  deriveBuiltInPostgresProbe({ sessionId: 42, seedOk: true, seedValue: null }).status === "degraded",
  "M3 a NULL seed value is still degraded — 0 is a measurement, null is not"
);
ok(
  deriveBuiltInPostgresProbe({ sessionId: 42, seedOk: true, seedValue: undefined }).status === "degraded",
  "M3 an undefined seed value is still degraded"
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
// 34 in 3.0.0, was 99 before B8. Section C adds two base tools with no pinned
// variants — omatic_test_connection and omatic_edit_connection — so 36. #143
// adds omatic_runtime_status, also unpinned, so 37.
ok(surface.length === 37, `B8 tool surface is 37, was 99 (got ${surface.length})`);
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
            probed_at: RECENT,
            probe_note: null,
            criticality: "critical",
          },
        ],
        count: 1,
      };
    }
    // Smith condition 4: a rule_count_target must be present, or the fast view
    // correctly refuses to call the factory green. The old fixture supplied no
    // governance_health at all and the check silently skipped — which is the
    // defect, not the baseline.
    if (/v_startup_summary/.test(sql)) {
      return { rows: [{ open_task_total: "1", governance_health: { active_rule_count: 59, rule_count_target: 59 } }], count: 1 };
    }
    if (/v_agent_agreement/.test(sql)) return { rows: READY_ROSTER, count: READY_ROSTER.length };
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
// exercised; fn_record_probe_result records the omatic-server-{name}
// form. fakeConnections()'s default connection is "omatic".
ok(
  probeCalls[0] === "omatic-server-omatic",
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
ok(/omatic-elementor: UNTESTED \(never probed\)/.test(mixedView), "A5 full view names the unprobed connector");
ok(/filesystem: UNTESTED/.test(mixedView), "A5 full view reports an inherited OK as UNTESTED");
ok(!/filesystem: OK/.test(mixedView), "A5 full view never renders an unmeasured connector as OK");
ok(/Prior verdict: connected/.test(mixedView), "A5 the demoted prior verdict is surfaced as history");
ok(/1\/3 connectors measured OK/.test(mixedView), "A5 only measured connectors count toward the OK tally");
ok(/2 never probed/.test(mixedView), "A5 the unprobed count is stated, not omitted");
ok(/Factory status: CHECK/.test(mixedView), "A5 unprobed connectors deny a GREEN factory status");
ok(!/Factory status: GREEN/.test(mixedView), "A5 a partly-unprobed factory is never GREEN");
ok(/Probe coverage: 1\/3 measured within the last 15 minutes/.test(mixedView), "A5 full view states probe coverage in words");

// A fully-measured factory is still allowed to be GREEN — the point is honesty,
// not pessimism.
ok(/Factory status: GREEN/.test(formatStartupView({ startup: green, session: {}, identity: {}, factory: {} })), "A5 a fully measured factory still reports GREEN");

// Fast view: untested is an UNKNOWN, and UNKNOWNs suppress GREEN.
const mixedFast = formatFastStartupView({ mode: "fast", startup: mixed, session: {}, identity: {}, factory: {} });
ok(!/Status: GREEN/.test(mixedFast), "A5 fast view is never GREEN with unprobed connectors");
ok(/Status: UNKNOWN/.test(mixedFast), "A5 fast view reports UNKNOWN when probes are missing");
ok(/never been probed/.test(mixedFast), "A5 fast view says why");
ok(!/could not be read/.test(mixedFast), "A5 fast view no longer miscalls an unprobed connector an unreadable source");

// Critical unprobed connectors are named individually; the rest collapse.
const manyUntested = clone(green);
for (let i = 0; i < 12; i += 1) {
  manyUntested.readiness.rows.push({ ...clone(untestedRow), connector_id: `enh-${i}`, criticality: "enhancement" });
}
manyUntested.readiness.rows.push({ ...clone(untestedRow), connector_id: "postgres-lucidit", criticality: "critical" });
const manyFast = formatFastStartupView({ mode: "fast", startup: manyUntested, session: {}, identity: {}, factory: {} });
ok(/CRITICAL connector postgres-lucidit has never been probed/.test(manyFast), "A5 an unprobed CRITICAL connector is named individually");
ok(/12 non-critical connectors have never been probed/.test(manyFast), "A5 non-critical unprobed connectors collapse to one line");

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
          { connector_id: "postgres-omatic", status_label: "OK", probe_result: "connected", probed_at: RECENT, probe_note: null, criticality: "critical" },
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
ok(blindCoverage.stale === "UNKNOWN", "#166b unreadable readiness reports UNKNOWN stale, not zero stale");

// ══ #165 / #166 — startup payload scoping (decision #246) ══════════════════
//
// A mode-aware query recorder. Modes were reporting depth in NAME only:
// tools.js assembled one identical payload object regardless of mode and swapped
// only the rendered view string. normal measured 57,243 B and fast 54,881 B —
// a 4.1% difference — so BOTH modes blew the MCP tool-output cap, every startup
// was persisted to disk, and the orchestrator spent an extra round trip reading
// back its own startup packet. Startup could not complete in one call in any
// mode, by construction.
const P1_SAMPLE = Array.from({ length: 8 }, (_, i) => ({ id: 100 + i, title: `task ${i}`, category: "plugin", owner: "carver" }));
function modeConnections(overrides = {}) {
  const seen = [];
  return {
    seen,
    conn: {
      ...fakeConnections(),
      query: async (name, sql, params) => {
        seen.push(sql);
        if (/current_database\(\)/.test(sql)) return { rows: [{ db_name: "f_omatic", db_user: "u" }], count: 1 };
        if (/SELECT id, session_date, platform, session_type\s+FROM factory_sessions/.test(sql)) {
          return overrides.existingSession ? { rows: [overrides.existingSession], count: 1 } : { rows: [], count: 0 };
        }
        if (/INSERT INTO factory_sessions/.test(sql)) {
          return { rows: [{ id: 4242, session_date: "2026-08-07", platform: "claude-code", session_type: "work" }], count: 1 };
        }
        if (/fn_seed_session_mcp_status/.test(sql)) return { rows: [{ seeded: overrides.seeded ?? 5 }], count: 1 };
        if (/fn_record_probe_result/.test(sql)) return { rows: [{ result: "ok" }], count: 1 };
        if (/v_mcp_readiness/.test(sql)) {
          return {
            rows: [{ connector_id: "postgres-omatic", status_label: "OK", probe_result: "connected", probed_at: RECENT, probe_note: null, criticality: "critical" }],
            count: 1,
          };
        }
        if (/v_startup_summary/.test(sql)) {
          // The projection is the point: a fast query asks for five columns and
          // therefore cannot receive sop_index or p1_tasks. Answering with the
          // wide row regardless would let the test pass while the plugin still
          // shipped 17 KB.
          const wide = {
            last_session_id: 4242,
            platform: "claude-code",
            resume_notes: "pick up #165",
            open_task_total: "44",
            governance_health: { active_rule_count: 59, rule_count_target: 59, active_sop_count: 11, combined_governance_target: 70 },
            sop_index: Array.from({ length: 11 }, (_, i) => ({ sop_id: `SOP-${i}`, title: "t", trigger_phrases: ["a", "b"] })),
            p1_tasks: P1_SAMPLE,
            p1_total: 44,
            open_tasks: { plugin: 44 },
          };
          if (/^SELECT last_session_id, platform, resume_notes, open_task_total, governance_health/.test(sql.trim())) {
            const { sop_index, p1_tasks, p1_total, open_tasks, ...narrow } = wide;
            return { rows: [narrow], count: 1 };
          }
          return { rows: [wide], count: 1 };
        }
        if (/v_agent_agreement/.test(sql)) return { rows: READY_ROSTER, count: READY_ROSTER.length };
        if (/v_startup_rules/.test(sql)) return { rows: [{ id: 1, enforcement: "hard", rule: "x" }], count: 1 };
        return { rows: [], count: 0 };
      },
    },
  };
}

const fastRec = modeConnections();
const fastRun = parse(await handleToolCall(fastRec.conn, "omatic_factory_startup_run", { mode: "fast" }));
const normalRec = modeConnections();
const normalRun = parse(await handleToolCall(normalRec.conn, "omatic_factory_startup_run", { mode: "normal" }));
const auditRec = modeConnections();
const auditRun = parse(await handleToolCall(auditRec.conn, "omatic_factory_startup_run", { mode: "audit" }));

// Smith binding condition 3 — QUERY-LEVEL projection, not payload deletion.
// `startup.sop_index` never existed as a payload key: sop_index is a COLUMN of
// v_startup_summary arriving inside startup.summary.rows[0]. Deleting it after
// the fact would have meant mutating the protected summary object.
ok(
  fastRec.seen.some((s) => /^SELECT last_session_id, platform, resume_notes, open_task_total, governance_health FROM v_startup_summary/.test(s.trim())),
  "C3 fast projects five columns off v_startup_summary instead of SELECT *"
);
ok(!fastRec.seen.some((s) => /SELECT \* FROM v_startup_summary/.test(s)), "C3 fast never issues SELECT * against the summary view");
ok(normalRec.seen.some((s) => /SELECT \* FROM v_startup_summary/.test(s)), "C3 normal still takes the full summary");
ok(auditRec.seen.some((s) => /SELECT \* FROM v_startup_summary/.test(s)), "C3 audit still takes the full summary");
ok(fastRun.startup.summary.rows[0].sop_index === undefined, "C3 sop_index is absent from the fast payload because it was never selected");
ok(fastRun.startup.summary.rows[0].p1_tasks === undefined, "C3 p1_tasks is absent from the fast payload");
ok(
  fastRec.seen.some((s) => /SELECT connector_id, status_label, probe_result, probed_at, probe_note, criticality FROM v_mcp_readiness/.test(s)),
  "C3 fast narrows readiness to the six columns VIEW_COLUMNS declares are read"
);
ok(!fastRec.seen.some((s) => /SELECT \* FROM v_mcp_readiness/.test(s)), "C3 fast does not SELECT * the fifteen-column readiness view");

// #188 HIGH-1 — the halt inputs are fetched FRESH and arrive WHOLE in every
// mode. This is the clause the 4 KB target was pressuring an engineer to break.
for (const [label, run] of [["fast", fastRun], ["normal", normalRun], ["audit", auditRun]]) {
  ok(run.startup.agreements && run.startup.agreements.ok === true, `#188 ${label} carries a fresh agreements block`);
  ok(run.startup.agreements.rows.length === READY_ROSTER.length, `#188 ${label} carries the WHOLE agreement roster, untrimmed`);
  ok(run.startup.agreements.rows[0].loaded_rules !== undefined, `#188 ${label} keeps loaded_rules, the halt input`);
  ok(run.startup.agreements.rows[0].enforcement_model !== undefined, `#188 ${label} keeps enforcement_model`);
  ok(run.startup.summary && run.startup.summary.ok === true, `#188 ${label} carries a fresh summary block with its ok flag`);
  ok(run.startup.probe_coverage !== undefined, `#188 ${label} carries probe coverage`);
}

// #165 (1) — rules is reporting detail, omitted on fast only. The QUERY still
// runs, so a read failure still reaches the envelope.
ok(fastRun.startup.rules === undefined, "#165 startup.rules is omitted on fast");
ok(fastRec.seen.some((s) => /v_startup_rules/.test(s)), "#165 the rules query still RUNS on fast — reporting changed, checking did not");
ok(normalRun.startup.rules !== undefined, "#165 startup.rules is kept on normal");
ok(auditRun.startup.rules !== undefined, "#165 startup.rules is kept on audit");

// #165 (3) — loaded_skills was a verbatim duplicate of agreements.
ok(fastRun.startup.loaded_skills === undefined, "#165 loaded_skills is not duplicated into the fast payload");
ok(normalRun.startup.loaded_skills === undefined, "#165 loaded_skills is not duplicated into the normal payload either");
ok(Array.isArray(auditRun.startup.loaded_skills), "#165 audit still returns everything, loaded_skills included");
// And the roster still renders, because the renderer derives it.
ok(/Core roster: brandy, carver, data, fred, monet, probot/.test(normalRun.view), "#165 the roster still renders from agreements after the dedupe");
const derived = deriveLoadedSkills({ ok: true, rows: READY_ROSTER });
ok(derived.length === READY_ROSTER.length, "#165 deriveLoadedSkills rebuilds one entry per READY agreement");
ok(derived.every((s) => s.factory_mode === "always_on_core_roster"), "#165 the core roster classification survives the move");
ok(deriveLoadedSkills({ ok: false }).length === 0, "#165 an unreadable agreement source derives an empty roster, not a fabricated one");

// Smith binding condition 5 — resolved_via stays in EVERY mode; only the
// candidate trace goes.
const cleanFactory = {
  factory_id: "omatic",
  resolution: {
    resolved_via: "CLAUDE_PROJECT_DIR",
    using_plugin_install_root: false,
    explicit_factory_json_path: "/x/.omatic/factory.json",
    roots_considered: ["a", "b"],
    candidates: [{ source: "a" }, { source: "b" }],
    rejected_pins: [{ why: "duplicate" }],
    state_durable: true,
  },
};
for (const mode of ["fast", "normal"]) {
  const scoped = scopeFactoryForMode(cleanFactory, mode);
  ok(scoped.resolution.resolved_via === "CLAUDE_PROJECT_DIR", `C5 ${mode} keeps resolution.resolved_via`);
  ok(scoped.resolution.using_plugin_install_root === false, `C5 ${mode} keeps using_plugin_install_root`);
  ok(scoped.resolution.state_durable === true, `C5 ${mode} keeps the state_* keys`);
  ok(scoped.resolution.candidates === undefined, `C5 ${mode} drops the candidate trace`);
  ok(scoped.resolution.roots_considered === undefined, `C5 ${mode} drops roots_considered`);
  ok(scoped.resolution.rejected_pins === undefined, `C5 ${mode} drops rejected_pins`);
}
ok(scopeFactoryForMode(cleanFactory, "audit").resolution.candidates !== undefined, "C5 audit returns the full resolution trace");
// A resolution that did NOT cleanly succeed keeps its trace in every mode —
// that is the only time anyone wants to read it.
const brokenResolution = clone(cleanFactory);
brokenResolution.resolution.using_plugin_install_root = true;
ok(scopeFactoryForMode(brokenResolution, "fast").resolution.candidates !== undefined, "C5 a factory resolved from the plugin install root keeps its trace on fast");
const unresolved = clone(cleanFactory);
unresolved.resolution.resolved_via = null;
ok(scopeFactoryForMode(unresolved, "fast").resolution.candidates !== undefined, "C5 a factory that never resolved keeps its trace on fast");
ok(scopeFactoryForMode(null, "fast") === null, "C5 scoping tolerates a missing factory");
ok(scopeFactoryForMode({ factory_id: "x" }, "fast").factory_id === "x", "C5 scoping tolerates a factory with no resolution block");

// #165 — queue depth comes from p1_total, so the view can ship a sample.
ok(/\.\.\.and 36 more P1 tasks/.test(normalRun.view), "#165 the overflow line is computed from p1_total (44) minus the 8 shown, not from the array length");
const noTotal = clone(green);
noTotal.summary.rows[0].p1_tasks = P1_SAMPLE.concat([{ id: 999, title: "extra", category: "c", owner: "o" }]);
ok(
  /\.\.\.and 1 more P1 task/.test(formatStartupView({ startup: noTotal, session: {}, identity: {}, factory: {} })),
  "#165 a view without p1_total still renders a correct overflow from the array length"
);

// Smith binding condition 4 — the rule guard must not fail open.
//
// The failure on record: a migration drops or renames the probot rule scope.
// v_startup_rules returns 0 rows with ok:true — no query failure, outcome stays
// complete. governance_health still reads its unaffected aggregate. Once
// startup.rules is omitted on fast, governance_health is the SOLE rule signal,
// and this branch used to SKIP ENTIRELY when the target was missing or zero.
for (const [label, gov] of [
  ["missing", { active_rule_count: 59 }],
  ["zero", { active_rule_count: 59, rule_count_target: 0 }],
  ["null", { active_rule_count: 59, rule_count_target: null }],
]) {
  const noTarget = clone(green);
  noTarget.summary.rows[0].governance_health = gov;
  const nv = formatFastStartupView({ mode: "fast", startup: noTarget, session: {}, identity: {}, factory: {} });
  ok(!/Status: GREEN/.test(nv), `H1 a ${label} rule_count_target denies GREEN in the fast view`);
  ok(/rule_count_target is missing or zero/.test(nv), `H1 a ${label} rule_count_target produces an explicit UNKNOWN item, never a skip`);
  const nfv = formatStartupView({ startup: noTarget, session: {}, identity: {}, factory: {} });
  ok(/UNKNOWN rules/.test(nfv), `H1 the full view labels a ${label} rule target UNKNOWN, not OK`);
  ok(!/Factory status: GREEN/.test(nfv), `H1 a ${label} rule target denies GREEN in the full view`);
  ok(!/OK 59 rules|OK 59\/59 rules/.test(nfv), `H1 a ${label} rule target never renders as OK 59 rules`);
}
// A real target still renders normally, so the fix cannot be satisfied by
// making everything UNKNOWN.
ok(/OK 40\/40 rules/.test(formatStartupView({ startup: green, session: {}, identity: {}, factory: {} })), "H1 a satisfied rule target still renders OK");
ok(/Status: GREEN/.test(formatFastStartupView({ mode: "fast", startup: green, session: {}, identity: {}, factory: {} })), "H1 a healthy factory is still allowed to be GREEN");

// #166 (a) — session hygiene. Reuse the open same-day per-platform row instead
// of minting one per startup_run. This confers NO freshness authority: rows 137,
// 138 and 150 stop accumulating, and nothing else about staleness changes.
const reuseRec = modeConnections({ existingSession: { id: 150, session_date: "2026-08-07", platform: "claude-code", session_type: "work" }, seeded: 0 });
const reuseRun = parse(await handleToolCall(reuseRec.conn, "omatic_factory_startup_run", { mode: "normal" }));
ok(reuseRun.session.id === 150, "#166a an open same-day row is reused rather than a new one minted");
ok(reuseRun.session.reused === true, "#166a the packet states that the session was reused, so nobody reads it as verified");
ok(!reuseRec.seen.some((s) => /INSERT INTO factory_sessions/.test(s)), "#166a no factory_sessions row is minted when one already exists today");
// M3 in the integration path, not only the unit: a reused session seeds 0 rows
// and the built-in probe must still report connected.
ok(
  reuseRun.probe_results[0].status === "connected",
  `M3 a reused session (seed returns 0) still yields a connected probe (got ${reuseRun.probe_results[0].status})`
);
ok(reuseRun.seeded === 0, "M3 the observed seed value of 0 is reported honestly rather than coerced");
ok(normalRun.session.reused === false, "#166a a genuinely new session is marked not-reused");
ok(normalRec.seen.some((s) => /INSERT INTO factory_sessions/.test(s)), "#166a a row is still minted when no same-day row exists");

// ══ #167 — the commons and operator-profile loads rules #267 and #319 mandate ══
//
// The finding that makes this a correctness fix rather than a convenience one:
// factory_commons content lives in schema `kb` while search_path is
// {pg_catalog, public}, so an UNQUALIFIED query returns zero rows with
// success=true and results_trustworthy=true — a silent empty result that reads
// exactly like an empty commons. Probot hit this and had to probe
// information_schema by hand. This is almost certainly the root cause of #138.
const commonsConn = (rows, { ok = true, has = true, error = null } = {}) => ({
  ...fakeConnections(),
  has: () => has,
  query: async () => {
    if (!ok) throw new Error(error || "boom");
    return { rows, count: rows.length };
  },
});

const commonsGood = await loadCommonsState(commonsConn([{ documents: "69", chunks: "484", semantic_index: "63" }]));
ok(commonsGood.loaded === true, "#167 a populated commons reports loaded");
ok(commonsGood.counts.documents === 69 && commonsGood.counts.chunks === 484, "#167 the commons row counts are reported");

// A zero-row commons is a FAILED load, never a quiet success (decision #226).
const commonsEmpty = await loadCommonsState(commonsConn([{ documents: "0", chunks: "0", semantic_index: "0" }]));
ok(commonsEmpty.loaded === false, "#167 a zero-row commons is a FAILED load, not a quiet success");
ok(commonsEmpty.reason === "empty", "#167 the empty commons states why it failed");
const commonsBroken = await loadCommonsState(commonsConn([], { ok: false, error: 'relation "kb.documents" does not exist' }));
ok(commonsBroken.loaded === false, "#167 an unreadable commons is a failed load");
ok(/does not exist/.test(commonsBroken.detail), "#167 the commons failure carries the real error");
const commonsAbsent = await loadCommonsState(commonsConn([], { has: false }));
ok(commonsAbsent.loaded === false && commonsAbsent.reason === "connection_not_configured", "#167 a missing kb connection is declared, not skipped");

// The query must be SCHEMA-QUALIFIED. This is the bug, so it is asserted on the
// SQL text rather than only on the result.
let commonsSql = "";
await loadCommonsState({ ...fakeConnections(), has: () => true, query: async (_n, sql) => { commonsSql = sql; return { rows: [{ documents: 1, chunks: 1, semantic_index: 1 }], count: 1 }; } });
ok(/kb\.documents/.test(commonsSql), "#167 the commons query names the kb schema explicitly");
ok(/kb\.document_chunks/.test(commonsSql) && /kb\.semantic_index/.test(commonsSql), "#167 every commons relation is schema-qualified");
ok(!/FROM documents\b/.test(commonsSql), "#167 no unqualified relation survives — that is the silent-zero-rows bug");

// Rule #319 verbatim returns ~80 KB across 26 dimensions and blows the output
// cap. The packet carries the INDEX; bodies stay on demand.
let profileSql = "";
const profileState = await loadOperatorProfileState({
  ...fakeConnections(),
  has: () => true,
  query: async (_n, sql) => {
    profileSql = sql;
    return { rows: [{ dimension: "voice", access_tier: "private", rows: "12" }, { dimension: "history", access_tier: "team", rows: "4" }], count: 2 };
  },
});
ok(profileState.loaded === true, "#167 a populated operator profile reports loaded");
ok(profileState.dimensions.length === 2, "#167 the profile index lists its dimensions");
ok(profileState.dimensions[0].access_tier === "private", "#167 the profile index carries access_tier");
ok(!/\bcontent\b/.test(profileSql), "#167 the profile query never selects dimension BODIES — that is the 80 KB");
ok(/GROUP BY/.test(profileSql), "#167 the profile query is an aggregate index, not a table dump");
const profileEmpty = await loadOperatorProfileState({ ...fakeConnections(), has: () => true, query: async () => ({ rows: [], count: 0 }) });
ok(profileEmpty.loaded === false && profileEmpty.reason === "empty", "#167 an empty operator profile is a FAILED load");
const profileAbsent = await loadOperatorProfileState({ ...fakeConnections(), has: () => false });
ok(profileAbsent.loaded === false, "#167 a missing aboutjimmy connection is declared, not skipped");

// Neither load may HALT the factory, and both must be DECLARED. The mode
// fixtures have no kb/aboutjimmy connection, so both come back not-loaded.
ok(fastRun.commons !== undefined, "#167 commons state travels in the fast packet");
ok(fastRun.operator_profile !== undefined, "#167 operator profile state travels in the fast packet");
ok(fastRun.success === true, "#167 a failed commons load does not halt the factory");
ok(
  fastRun.degraded_reasons.some((r) => /commons_load/.test(r)),
  "#167 a failed commons load is DECLARED in degraded_reasons rather than silently skipped"
);
ok(
  fastRun.degraded_reasons.some((r) => /operator_profile_load/.test(r)),
  "#167 a failed operator-profile load is declared too"
);
ok(/local-brain-only/.test(fastRun.degraded_reasons.find((r) => /commons_load/.test(r)) || ""), "#167 the commons degradation names its fallback (rule #267)");
// And it is visible in what a human reads, not only in the JSON — the C1 lesson.
ok(/Commons: NOT LOADED/.test(fastRun.view), "#167 the fast view states the commons load state");
ok(/Required Loads/.test(normalRun.view), "#167 the full view has a Required Loads block");

// Q3 — the tool schema no longer describes a cache that does not exist.
const modeTool = buildToolList(fakeConnections()).find((t) => t.name === "omatic_factory_startup_run");
const modeDesc = modeTool.inputSchema.properties.mode.description;
ok(!/green-check cache|short-TTL|bypassing the cache/i.test(modeDesc), "Q3 the mode description no longer advertises a green-check cache that was never built");
ok(!/served from|repeat starts/i.test(modeDesc), "Q3 the mode description no longer implies a repeat fast start is served from anything");
ok(/runs fresh on every call in every mode/.test(modeDesc), "Q3 the mode description states that the battery runs fresh in every mode");
ok(/nothing is cached, skipped, or inherited/.test(modeDesc), "Q3 the mode description rules out inheritance between calls");
ok(/REPORTING DEPTH only/.test(modeDesc), "Q3 the mode description says what mode actually controls");
ok(/mode=fast\|normal\|audit/.test(modeTool.description), "Q3 the top-level tool description mentions that modes exist");
ok(!/cache/i.test(modeTool.description), "Q3 the top-level description does not mention a cache at all");

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
  // Re-captured 2026-08-07 after task #163: `p1_total` was added to
  // v_startup_summary as a trailing column in the same release, so the renderer
  // could stop deriving queue depth from the length of the p1_tasks array.
  // `sop_index` still exists — #163 dropped the `summary` prose from inside the
  // JSON value, not the column.
  summary: "last_session_id, session_date, platform, session_type, resume_notes, open_tasks, open_task_total, p1_tasks, agents, embedding_health, decommissioned_terms, sop_index, governance_health, p1_total".split(", "),
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

// ─────────────────────────────────────────────────────────────────────────────
// Section C — the connection surface (issue #6)
//
// The operator's ask: see the connections, test one, fix a bad one, without
// leaving the session. The failure modes these guard against are all the same
// shape — a response that looks fine and isn't. A saved connection that never
// connected. A "***" where a credential used to be. A configured sslmode
// reported as if it were the negotiated one. A write reported as successful
// when the probe failed.
//
// Every write path below runs against a real temp-dir factory.json with an
// injected probe, so "writes nothing on failure" is proven by reading the file,
// not by trusting the response.
// ─────────────────────────────────────────────────────────────────────────────

const {
  describeConnectionRow,
  assertNoCredentials,
  buildConnEntryFromArgs,
  mergeConnEntry,
  connEntryDiff,
  buildProbeTarget,
  normalizeSslModeArg,
  normalizePortArg,
  EDITABLE_CONN_FIELDS,
  setProbeConnection,
  resetProbeConnection,
} = __test__;

const osMod = require("node:os");
const pathMod = require("node:path");
const connectionsMod = require(resolve(here, "../server/connections.js"));

// Asserts that fn throws. Declared up front — several blocks below use it.
const throwsWith = (fn, label) => {
  try {
    fn();
    failures.push(label);
  } catch {
    pass++;
  }
};

const SECRET = "hunter2-do-not-emit-this";
const cfgFixture = {
  name: "omatic",
  host: "cabinet.blue-triggerfish.ts.net",
  port: 5432,
  database: "o-matic",
  user: "o-matic-llm",
  password: SECRET,
  sslMode: "disable",
  // parseConnectionEntry always materializes a permission, so a fixture without
  // one is not a shape the rest of the system ever produces.
  permission: "read_write",
};

// ── C1: the listing row ──
const okProbe = {
  ok: true,
  info: { database: "o-matic", user: "o-matic-llm" },
  latency_ms: 12,
  ssl: {
    configured: "disable",
    negotiated: "plaintext",
    encrypted: false,
    protocol: null,
    cipher: null,
    authorized: null,
    fell_back: false,
  },
};
const tlsProbe = {
  ok: true,
  info: { database: "o-matic", user: "o-matic-llm" },
  latency_ms: 30,
  ssl: {
    configured: "require",
    negotiated: "encrypted",
    encrypted: true,
    protocol: "TLSv1.3",
    cipher: { name: "TLS_AES_256_GCM_SHA384" },
    authorized: false,
    authorization_error: "self signed certificate",
    fell_back: true,
  },
};
const failProbe = {
  ok: false,
  latency_ms: 8,
  error: 'password authentication failed for user "o-matic-llm"',
  ssl: { configured: "disable", negotiated: null, encrypted: null },
};

const rowUnprobed = describeConnectionRow(cfgFixture, null);
const rowOk = describeConnectionRow(cfgFixture, okProbe);
const rowTls = describeConnectionRow({ ...cfgFixture, sslMode: "require" }, tlsProbe);
const rowFail = describeConnectionRow(cfgFixture, failProbe);

// The whole reason this section exists: the password must not be in the answer.
// Not the value, not a placeholder standing in its slot, not a length hint.
for (const [label, row] of [["unprobed", rowUnprobed], ["ok", rowOk], ["tls", rowTls], ["fail", rowFail]]) {
  ok(!("password" in row), `C1 ${label} row has no password key at all`);
  ok(!JSON.stringify(row).includes(SECRET), `C1 ${label} row does not contain the password value`);
  ok(!/\*{2,}/.test(JSON.stringify(row)), `C1 ${label} row emits no masked-password placeholder`);
}
ok(rowOk.password_configured === true, "C1 password_configured reports presence as a boolean");
ok(
  describeConnectionRow({ ...cfgFixture, password: "" }, okProbe).password_configured === false,
  "C1 password_configured is false when no password is set"
);
ok(
  describeConnectionRow({ ...cfgFixture, password: "x" }, okProbe).password_configured ===
    describeConnectionRow({ ...cfgFixture, password: "xxxxxxxxxxxxxxxxxxxx" }, okProbe).password_configured,
  "C1 password_configured is identical for a 1-char and a 20-char password (no length leak)"
);

ok(rowUnprobed.reachable === null, "C1 an unprobed row reports reachable:null, not false");
ok(rowUnprobed.reachability_checked === false, "C1 an unprobed row says reachability was not checked");
ok(rowOk.reachable === true && rowOk.reachability_checked === true, "C1 a successful probe reports reachable:true");
ok(rowFail.reachable === false, "C1 a failed probe reports reachable:false");
ok(rowFail.probe_error === failProbe.error, "C1 the failed row carries the raw Postgres error, unparaphrased");
ok(rowOk.probe_error === null, "C1 a reachable row carries no probe error");
ok(rowOk.latency_ms === 12, "C1 the row reports measured latency");
ok(rowOk.connected_database === "o-matic", "C1 the row reports the database actually connected to");
ok(rowOk.connected_user === "o-matic-llm", "C1 the row reports the user actually connected as");
ok(rowFail.connected_database === null, "C1 a failed probe reports no connected database");

// Configured vs negotiated as separate fields — the point of C1.
ok("ssl_mode_configured" in rowTls && "ssl_negotiated" in rowTls, "C1 configured and negotiated TLS are separate keys");
ok(rowTls.ssl_mode_configured === "require", "C1 ssl_mode_configured reflects the config, not the handshake");
ok(rowTls.ssl_negotiated === "encrypted", "C1 ssl_negotiated reflects the handshake, not the config");
ok(rowOk.ssl_mode_configured === "disable" && rowOk.ssl_negotiated === "plaintext", "C1 the two fields can agree");
ok(
  rowTls.ssl_mode_configured !== rowTls.ssl_negotiated,
  "C1 the two fields can disagree without either being overwritten"
);
ok(rowTls.tls_protocol === "TLSv1.3", "C1 the negotiated TLS protocol is reported (D9 readback)");
ok(rowTls.tls_cipher === "TLS_AES_256_GCM_SHA384", "C1 the negotiated cipher name is reported");
ok(rowTls.tls_authorized === false, "C1 the peer-authorization result is reported");
ok(rowTls.tls_authorization_error === "self signed certificate", "C1 the authorization error is reported verbatim");
ok(rowTls.ssl_fell_back === true, "C1 an sslmode fallback is disclosed");
ok(rowTls.encrypted === true && rowOk.encrypted === false, "C1 encrypted is a measured boolean, not the config");

// ── assertNoCredentials: defence in depth on every response ──
let credThrew = false;
try {
  assertNoCredentials({ note: `dsn=postgres://u:${SECRET}@h/db` }, [SECRET]);
} catch {
  credThrew = true;
}
ok(credThrew, "C1 assertNoCredentials throws rather than shipping a payload containing a credential");
ok(
  assertNoCredentials({ name: "omatic", host: "h" }, [SECRET]).name === "omatic",
  "C1 assertNoCredentials passes a clean payload through unchanged"
);
ok(
  assertNoCredentials({ password_configured: false }, ["", null, undefined]).password_configured === false,
  "C1 assertNoCredentials ignores empty secrets rather than matching everything"
);
let nestedThrew = false;
try {
  assertNoCredentials({ a: { b: [{ c: SECRET }] } }, [SECRET]);
} catch {
  nestedThrew = true;
}
ok(nestedThrew, "C1 assertNoCredentials catches a credential nested anywhere in the payload");

// The structural half. A substring scan cannot help with a short password —
// a one-character secret matches almost any response — so a credential-shaped
// key holding anything but a presence boolean is rejected on sight, with no
// reference to the secret at all.
throwsWith(() => assertNoCredentials({ password: "p" }, []), "C1 a password key holding a value is rejected outright");
throwsWith(() => assertNoCredentials({ password: "***" }, []), "C1 a masked-password placeholder is rejected too");
throwsWith(
  () => assertNoCredentials({ conns: [{ name: "a", db_password: "x" }] }, []),
  "C1 a credential-shaped key nested in an array is rejected"
);
throwsWith(() => assertNoCredentials({ api_key: "sk-1" }, []), "C1 an api_key field is rejected");
throwsWith(() => assertNoCredentials({ token: "t" }, []), "C1 a token field is rejected");
ok(
  assertNoCredentials({ password_configured: true, nested: { password_configured: false } }, []).password_configured ===
    true,
  "C1 a credential-shaped key holding a presence boolean is allowed — that is the design"
);
ok(
  assertNoCredentials({ password_configured: null }, []).password_configured === null,
  "C1 an unknown presence flag (null) is allowed"
);
ok(
  assertNoCredentials({ note: "short secrets are not substring-scannable" }, ["p", "ab"]).note.length > 0,
  "C1 a sub-8-character secret does not trigger the substring scan (it would match everything)"
);

// ── C2: merge semantics — an edit is not an overwrite ──
const mergedPw = mergeConnEntry(cfgFixture, { password: "new-secret" });
ok(mergedPw.password === "new-secret", "C2 an edit applies the supplied password");
ok(mergedPw.host === cfgFixture.host, "C2 an edit carries the unsupplied host across unchanged");
ok(mergedPw.database === cfgFixture.database, "C2 an edit carries the unsupplied database across unchanged");
ok(mergedPw.sslMode === "disable", "C2 an omitted ssl_mode keeps the configured mode, it does not reset to a default");
ok(mergeConnEntry(cfgFixture, { port: "5433" }).port === 5433, "C2 a string port is normalized to an integer");
ok(mergeConnEntry(cfgFixture, { sslmode: "require" }).sslMode === "require", "C2 the libpq sslmode spelling is accepted");
ok(mergeConnEntry(cfgFixture, { ssl_mode: "verify-full" }).sslMode === "verify-full", "C2 ssl_mode is accepted");

throwsWith(() => mergeConnEntry(cfgFixture, { port: 0 }), "C2 an out-of-range port is rejected");
throwsWith(() => mergeConnEntry(cfgFixture, { port: 70000 }), "C2 a port above 65535 is rejected");
throwsWith(() => mergeConnEntry(cfgFixture, { port: "not-a-port" }), "C2 a non-numeric port is rejected");
throwsWith(() => mergeConnEntry(cfgFixture, { ssl_mode: "sorta" }), "C2 an invalid ssl_mode is rejected");
throwsWith(() => mergeConnEntry(cfgFixture, { host: "" }), "C2 an edit may not clear the host");
throwsWith(() => mergeConnEntry(cfgFixture, { user: "" }), "C2 an edit may not clear the user");
throwsWith(() => mergeConnEntry(cfgFixture, { database: "" }), "C2 an edit may not clear the database");
throwsWith(() => buildConnEntryFromArgs({ name: "Bad Name!" }), "C2 an invalid connection name is rejected");
throwsWith(() => normalizeSslModeArg({ ssl_mode: "tls" }, "require"), "C2 normalizeSslModeArg rejects an unknown mode");
ok(normalizeSslModeArg({}, "disable") === "disable", "C2 normalizeSslModeArg falls back when nothing is supplied");
ok(normalizePortArg(undefined, 5432) === 5432, "C2 normalizePortArg falls back when nothing is supplied");

ok(
  JSON.stringify(connEntryDiff(cfgFixture, mergedPw)) === JSON.stringify(["password"]),
  "C2 the diff names the changed field"
);
ok(connEntryDiff(cfgFixture, cfgFixture).length === 0, "C2 the diff is empty when nothing moved");
ok(
  !JSON.stringify(connEntryDiff(cfgFixture, mergedPw)).includes("new-secret") &&
    !JSON.stringify(connEntryDiff(cfgFixture, mergedPw)).includes(SECRET),
  "C2 the diff names a password change without carrying either value"
);
ok(
  connEntryDiff(cfgFixture, mergeConnEntry(cfgFixture, { host: "h2", user: "u2" })).join(",") === "host,user",
  "C2 the diff names every changed field and nothing else"
);
ok(EDITABLE_CONN_FIELDS.includes("password") && !EDITABLE_CONN_FIELDS.includes("name"),
  "C2 the connection name is not an editable field (remove and re-add instead)");

// ── C3: probe-target resolution ──
const fakeEnvFactory = (file) => ({ OMATIC_FACTORY_JSON_PATH: file, OMATIC_STATE_DIR: pathMod.dirname(file) });
const tmpRoot = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), "omatic-section-c-"));
const factoryFile = pathMod.join(tmpRoot, "factory.json");
const writeFactory = (conns) =>
  fsMod.writeFileSync(
    factoryFile,
    JSON.stringify({ factory_id: "omatic", platform_profile: "claude-code", connections: conns }, null, 2)
  );
const readFactory = () => JSON.parse(fsMod.readFileSync(factoryFile, "utf8"));
const storedConn = {
  name: "omatic",
  host: "cabinet.blue-triggerfish.ts.net",
  port: 5432,
  database: "o-matic",
  user: "o-matic-llm",
  password: SECRET,
  ssl_mode: "disable",
};

const fakeConnMgr = () => {
  const env = fakeEnvFactory(factoryFile);
  return {
    env: () => env,
    project: () => ({ factory_id: "omatic", platform_profile: "claude-code", resolution: {} }),
    names: () => ["omatic"],
    defaultName: () => "omatic",
    activeName: "omatic",
    has: (n) => n === "omatic",
    getConfig: () => cfgFixture,
    reload: async () => ({ ok: true, total: 1, added: [], removed: [] }),
  };
};

writeFactory([storedConn]);
const mgr = fakeConnMgr();

const discrete = buildProbeTarget(mgr, { host: "h", database: "d", user: "u", password: "p" });
ok(discrete.entry.port === 5432, "C3 an unspecified port defaults to 5432");
ok(discrete.entry.sslMode === "require", "C3 an unspecified ssl_mode defaults to require, never inferred from the host");
ok(discrete.source === "supplied fields", "C3 the source of a discrete-field probe is reported");
ok(
  buildProbeTarget(mgr, { host: "100.64.1.1", database: "d", user: "u" }).entry.sslMode === "require",
  "C3 a CGNAT/tailnet host does not silently downgrade ssl_mode (D5)"
);
ok(
  buildProbeTarget(mgr, { database_url: "postgresql://u:p@h:5555/db" }).entry.port === 5555,
  "C3 a database_url is parsed"
);
ok(buildProbeTarget(mgr, { connection: "omatic" }).entry.database === "o-matic", "C3 a stored connection can be probed by name");
ok(
  buildProbeTarget(mgr, { connection: "omatic" }).source === 'stored connection "omatic"',
  "C3 probing a stored connection says so"
);
const overridden = buildProbeTarget(mgr, { connection: "omatic", password: "guess" });
ok(overridden.entry.password === "guess", "C3 a field may be overridden for the test only");
ok(overridden.entry.host === storedConn.host, "C3 an override leaves the rest of the stored connection intact");
ok(/overridden for this test only/.test(overridden.source), "C3 an override is disclosed in the source string");
ok(
  readFactory().connections[0].password === SECRET,
  "C3 resolving a probe target does not touch the stored config on disk"
);
throwsWith(() => buildProbeTarget(mgr, {}), "C3 a probe with no target at all is rejected");
throwsWith(() => buildProbeTarget(mgr, { host: "h" }), "C3 a probe missing database and user is rejected");
throwsWith(() => buildProbeTarget(mgr, { connection: "nope" }), "C3 an unknown stored connection name is rejected");
throwsWith(() => buildProbeTarget(mgr, { database_url: "not-a-dsn" }), "C3 an unparseable database_url is rejected");

// ── C2/C5: the write paths, proven against a real file ──
const parseResp = (r) => JSON.parse(r.content[0].text);

// Failing probe. The file must be untouched — that is the assertion, not the
// response field claiming so.
setProbeConnection(async () => ({
  ok: false,
  error: 'FATAL: password authentication failed for user "o-matic-llm"',
  ssl: { configured: "disable", negotiated: null, encrypted: null },
}));

writeFactory([storedConn]);
const addFail = await handleToolCall(fakeConnMgr(), "omatic_add_connection", {
  name: "newconn",
  host: "cabinet.blue-triggerfish.ts.net",
  database: "o-matic",
  user: "o-matic-llm",
  password: "wrong",
  ssl_mode: "disable",
});
const addFailBody = parseResp(addFail);
ok(addFail.isError === true, "C2 add with a failing probe sets isError");
ok(addFailBody.success === false, "C2 add with a failing probe is not a success");
ok(addFailBody.outcome === "failed", "C2 add with a failing probe reports outcome=failed");
ok(addFailBody.results_trustworthy === false, "C2 add with a failing probe is not trustworthy");
ok(addFailBody.wrote === false, "C2 add with a failing probe reports wrote:false");
ok(
  addFailBody.postgres_error === 'FATAL: password authentication failed for user "o-matic-llm"',
  "C2 add returns the real Postgres error verbatim, not a paraphrase"
);
ok(/password authentication failed/.test(addFailBody.error), "C2 the error summary carries the server's own words");
ok(readFactory().connections.length === 1, "C2 add with a failing probe wrote NOTHING to factory.json");
ok(!readFactory().connections.some((c) => c.name === "newconn"), "C2 the rejected connection is absent from the file");
ok(!JSON.stringify(addFailBody).includes("wrong"), "C2 a rejected add does not echo the attempted password");

// Failing probe on edit — the existing connection must survive intact.
const editFail = await handleToolCall(fakeConnMgr(), "omatic_edit_connection", {
  name: "omatic",
  password: "also-wrong",
});
const editFailBody = parseResp(editFail);
ok(editFail.isError === true, "C2 edit with a failing probe sets isError");
ok(editFailBody.wrote === false && editFailBody.unchanged === true, "C2 edit with a failing probe changes nothing");
ok(/password authentication failed/.test(editFailBody.postgres_error), "C2 edit returns the real Postgres error");
ok(readFactory().connections[0].password === SECRET, "C2 a failed edit leaves the stored password exactly as it was");
ok(!JSON.stringify(editFailBody).includes("also-wrong"), "C2 a rejected edit does not echo the attempted password");
ok(
  Array.isArray(editFailBody.would_have_changed) && editFailBody.would_have_changed.includes("password"),
  "C2 a rejected edit says which field it would have changed"
);

// Unknown connection.
const editMissing = parseResp(await handleToolCall(fakeConnMgr(), "omatic_edit_connection", { name: "ghost" }));
ok(editMissing.success === false, "C2 editing a connection that does not exist fails");
ok(/omatic_add_connection/.test(editMissing.error), "C2 the not-found error points at the tool that would create it");

// Passing probe.
setProbeConnection(async (entry) => ({
  ok: true,
  info: { database: entry.database, user: entry.user },
  ssl: { configured: entry.sslMode, negotiated: "plaintext", encrypted: false, fell_back: false },
}));

const addOkBody = parseResp(
  await handleToolCall(fakeConnMgr(), "omatic_add_connection", {
    name: "newconn",
    host: "cabinet.blue-triggerfish.ts.net",
    database: "factory_commons",
    user: "o-matic-llm",
    password: SECRET,
    ssl_mode: "disable",
  })
);
ok(addOkBody.success === true && addOkBody.outcome === "complete", "C2 add with a passing probe succeeds cleanly");
ok(addOkBody.persisted === true, "C5 add reports the write was read back from disk");
ok(readFactory().connections.some((c) => c.name === "newconn"), "C5 the added connection is on disk");
ok(addOkBody.verified.reachable === true, "C2 add reports the connection it just proved");
ok(!JSON.stringify(addOkBody).includes(SECRET), "C2 a successful add never echoes the password");

const editOkBody = parseResp(
  await handleToolCall(fakeConnMgr(), "omatic_edit_connection", { name: "omatic", password: "fixed-secret" })
);
ok(editOkBody.success === true, "C2 edit with a passing probe succeeds");
ok(JSON.stringify(editOkBody.changed_fields) === JSON.stringify(["password"]), "C2 edit names the field it changed");
ok(readFactory().connections[0].password === "fixed-secret", "C5 the edited password is persisted to factory.json");
ok(readFactory().connections[0].host === storedConn.host, "C2 the edit left every other field alone");
ok(!JSON.stringify(editOkBody).includes("fixed-secret"), "C2 a successful edit never echoes the new password");
ok(editOkBody.persisted === true, "C5 edit reports the write was read back from disk");

// C5: a fresh manager reading the same file sees the edit — the respawn case.
ok(
  connectionsMod
    .normalizeFactoryConnections(readFactory(), "omatic")
    .find((c) => c.name === "omatic").password === "fixed-secret",
  "C5 a fresh load of factory.json sees the edit (survives a respawn)"
);
ok(
  connectionsMod.normalizeFactoryConnections(readFactory(), "omatic").some((c) => c.name === "newconn"),
  "C5 a fresh load of factory.json sees the added connection"
);

// No-op edit.
const noopBody = parseResp(
  await handleToolCall(fakeConnMgr(), "omatic_edit_connection", { name: "omatic", password: "fixed-secret" })
);
ok(noopBody.outcome === "no_op", "C2 an edit that changes nothing reports outcome=no_op, not complete");
ok(noopBody.wrote === false, "C2 a no-op edit does not rewrite the file");
ok(noopBody.no_op_reasons.length > 0, "C2 a no-op edit says why nothing happened");

// test=false must never come back clean.
const unverifiedBody = parseResp(
  await handleToolCall(fakeConnMgr(), "omatic_add_connection", {
    name: "unverified",
    host: "h",
    database: "d",
    user: "u",
    password: "p",
    ssl_mode: "disable",
    test: false,
  })
);
ok(unverifiedBody.outcome === "degraded", "C2 a connection written with test=false is degraded, never complete");
ok(
  unverifiedBody.degraded_reasons.some((r) => /never been proven to connect/.test(r)),
  "C2 an unverified write says out loud that it has never connected"
);
ok(unverifiedBody.results_trustworthy === false, "C2 an unverified write is not trustworthy");

// ── C1: the listing handler ──
writeFactory([storedConn, { ...storedConn, name: "kb", database: "factory_commons" }]);

const listNoProbe = parseResp(await handleToolCall(fakeConnMgr(), "omatic_list_connections", { probe: false }));
ok(listNoProbe.probed === false, "C1 probe=false is honoured");
ok(listNoProbe.connections.every((c) => c.reachability_checked === false), "C1 an unprobed listing says so per row");
ok(listNoProbe.outcome === "complete", "C1 an unprobed listing is complete — it measured nothing and claims nothing");

const listOk = parseResp(await handleToolCall(fakeConnMgr(), "omatic_list_connections", {}));
ok(listOk.probed === true, "C1 probing is the default");
ok(listOk.count === 2 && listOk.reachable_count === 2, "C1 the listing counts reachable connections");
ok(listOk.outcome === "complete", "C1 an all-reachable listing is complete");
ok(!JSON.stringify(listOk).includes(SECRET), "C1 the listing never contains a password");
ok(listOk.connections.every((c) => !("password" in c)), "C1 no listing row carries a password key");
ok(listOk.connections.every((c) => "ssl_mode_configured" in c && "ssl_negotiated" in c),
  "C1 every listing row separates configured from negotiated TLS");
ok(Array.isArray(listOk.field_guide) && listOk.field_guide.length >= 4, "C1 the listing explains its own fields for a non-engineer reader");

setProbeConnection(async (entry) =>
  entry.name === "kb"
    ? { ok: false, error: 'FATAL: database "factory_commons" does not exist', ssl: { configured: entry.sslMode } }
    : { ok: true, info: { database: entry.database, user: entry.user }, ssl: { configured: entry.sslMode, negotiated: "plaintext", encrypted: false } }
);
const listMixed = parseResp(await handleToolCall(fakeConnMgr(), "omatic_list_connections", {}));
ok(listMixed.outcome === "degraded", "C1 an unreachable connection degrades the listing");
ok(listMixed.results_trustworthy === false, "C1 a degraded listing is not clean");
ok(listMixed.reachable_count === 1 && listMixed.unreachable_count === 1, "C1 the listing counts both sides");
ok(
  listMixed.degraded_reasons.some((r) => /connection:kb/.test(r) && /does not exist/.test(r)),
  "C1 the degraded reason names the connection and carries the real Postgres error"
);
ok(
  listMixed.connections.find((c) => c.name === "kb").probe_error === 'FATAL: database "factory_commons" does not exist',
  "C1 the unreachable row carries the unparaphrased error"
);
ok(listMixed.connections.find((c) => c.name === "omatic").reachable === true, "C1 one bad connection does not taint the others");

// ── C3: the test handler ──
setProbeConnection(async () => ({
  ok: false,
  error: 'FATAL: password authentication failed for user "o-matic-llm"',
  ssl: { configured: "disable", negotiated: null, encrypted: null },
}));
const beforeTest = fsMod.readFileSync(factoryFile, "utf8");
const testFail = await handleToolCall(fakeConnMgr(), "omatic_test_connection", {
  host: "cabinet.blue-triggerfish.ts.net",
  database: "o-matic",
  user: "o-matic-llm",
  password: "wrong",
  ssl_mode: "disable",
});
const testFailBody = parseResp(testFail);
ok(testFail.isError === true, "C3 a failed test is reported as a failure, not a clean envelope");
ok(testFailBody.reachable === false, "C3 a failed test reports reachable:false");
ok(
  testFailBody.postgres_error === 'FATAL: password authentication failed for user "o-matic-llm"',
  "C3 a failed test returns the real Postgres error"
);
ok(testFailBody.mutated_config === false, "C3 a failed test states that it changed nothing");
ok(testFailBody.target.password_configured === true, "C3 the test reports that a password was supplied");
ok(!JSON.stringify(testFailBody).includes("wrong"), "C3 the test never echoes the password it was given");
ok(fsMod.readFileSync(factoryFile, "utf8") === beforeTest, "C3 a failed test left factory.json byte-identical");

setProbeConnection(async (entry) => ({
  ok: true,
  info: { database: entry.database, user: entry.user },
  ssl: { configured: entry.sslMode, negotiated: "plaintext", encrypted: false, fell_back: false },
}));
const testOkBody = parseResp(
  await handleToolCall(fakeConnMgr(), "omatic_test_connection", {
    host: "cabinet.blue-triggerfish.ts.net",
    database: "o-matic",
    user: "o-matic-llm",
    password: SECRET,
    sslmode: "disable",
  })
);
ok(testOkBody.success === true && testOkBody.reachable === true, "C3 a successful test reports reachable:true");
ok(testOkBody.connected_database === "o-matic", "C3 a successful test reports the database it landed on");
ok(testOkBody.target.ssl_mode_configured === "disable", "C3 the libpq sslmode spelling reaches the probe");
ok(testOkBody.mutated_config === false, "C3 a successful test still changes nothing");
ok(fsMod.readFileSync(factoryFile, "utf8") === beforeTest, "C3 a successful test left factory.json byte-identical");
ok(/omatic_add_connection/.test(testOkBody.note), "C3 a successful test tells the operator how to keep the settings");
ok(!JSON.stringify(testOkBody).includes(SECRET), "C3 a successful test never echoes the password");

resetProbeConnection();
// tmpRoot is not removed here — the C6 block below reuses the same factory
// file. Cleanup happens once, at the end of C6.

// ── C4: discoverability ──
const cSurface = buildToolList(fakeConnections());
const cNames = cSurface.map((t) => t.name);
const CONNECTION_TOOLS = [
  "omatic_list_connections",
  "omatic_test_connection",
  "omatic_add_connection",
  "omatic_edit_connection",
  "omatic_remove_connection",
  "omatic_set_active_connection",
];
for (const name of CONNECTION_TOOLS) {
  ok(cNames.includes(name), `C4 ${name} is published in the tool surface`);
  ok(Buffer.byteLength(name, "utf8") <= 64, `C4 ${name} fits the 64-byte Codex tool-name budget`);
  const def = cSurface.find((t) => t.name === name);
  ok(def && typeof def.description === "string" && def.description.length > 80,
    `C4 ${name} has a description substantial enough to choose it by`);
}
ok(new Set(cNames).size === cNames.length, "C4 every published tool name is unique");

const listDef = cSurface.find((t) => t.name === "omatic_list_connections");
ok(/reachab/i.test(listDef.description), "C4 the listing description advertises live reachability");
ok(/negotiat/i.test(listDef.description), "C4 the listing description advertises negotiated TLS");
ok(/password is never returned/i.test(listDef.description), "C4 the listing description states passwords are never returned");
const testDef = cSurface.find((t) => t.name === "omatic_test_connection");
ok(/nothing is saved/i.test(testDef.description), "C4 the test description states nothing is saved");
ok(testDef.inputSchema.properties.host && testDef.inputSchema.properties.password,
  "C4 the test tool takes a host and a password — the operator's original ask");
ok(testDef.inputSchema.properties.sslmode && testDef.inputSchema.properties.ssl_mode,
  "C4 the test tool accepts both ssl_mode spellings");
const editDef = cSurface.find((t) => t.name === "omatic_edit_connection");
ok(/test-connected before anything is written/i.test(editDef.description),
  "C4 the edit description states it tests before writing");
const addDef = cSurface.find((t) => t.name === "omatic_add_connection");
ok(/writes nothing|nothing written|aborts without touching/i.test(addDef.description),
  "C4 the add description states a failed probe writes nothing");

const cInstructions = buildServerInstructions();
ok(/omatic_list_connections/.test(cInstructions), "C4 the server instructions name the listing tool");
ok(/omatic_test_connection/.test(cInstructions), "C4 the server instructions name the test tool");
ok(/omatic_edit_connection/.test(cInstructions), "C4 the server instructions name the edit tool");

const guideBody = parseResp(await handleToolCall(fakeConnMgr(), "omatic_usage_guide", { include_connections: false }));
ok(typeof guideBody.connection_management === "object", "C4 the usage guide carries a connection_management section");
for (const name of CONNECTION_TOOLS) {
  ok(JSON.stringify(guideBody).includes(name), `C4 the usage guide names ${name}`);
}
ok(
  /configured/i.test(guideBody.connection_management.configured_vs_actual) &&
    /negotiat/i.test(guideBody.connection_management.configured_vs_actual),
  "C4 the usage guide explains configured vs negotiated TLS"
);
ok(/survive a respawn/i.test(guideBody.connection_management.persistence), "C4 the usage guide states changes persist");
ok(guideBody.version === require(resolve(here, "../server/package.json")).version,
  "C4 the usage guide reports the real plugin version rather than a stale literal");

// The B4 resolution error is where an operator with no factory ends up, so it
// is where the connection surface has to be named.
const unresolvedText = connectionsMod.unresolvedFactoryError({
  OMATIC_STATE_DIR: pathMod.join(osMod.tmpdir(), "omatic-section-c-nonexistent"),
}).message;
for (const name of ["omatic_list_connections", "omatic_test_connection", "omatic_add_connection", "omatic_edit_connection", "omatic_remove_connection"]) {
  ok(unresolvedText.includes(name), `C4 the unresolved-factory error names ${name}`);
}
ok(/omatic_select_factory/.test(unresolvedText), "C4 the unresolved-factory error still leads with select_factory");

// ─────────────────────────────────────────────────────────────────────────────
// C6 — per-connection permissions
//
// benecard is a client database and dbadmin connects as a superuser. Before
// this, the only thing stopping a tool writing to either was the model choosing
// not to: a rule loaded, not a rule obeyed (#321). These assertions exist
// because "the model will behave" is not a control.
//
// The bypass attempts matter as much as the happy path. J1 deleted the
// switchable guardDestructive and the ten execute_sql aliases that hard-coded
// it off; nothing here may reintroduce that shape.
// ─────────────────────────────────────────────────────────────────────────────

const {
  TOOL_ACCESS,
  toolAccessKind,
  sqlIsReadOnly,
  stripSqlNoise,
  checkConnectionPermission,
  normalizePermissionArg,
  permissionForConnection,
  PERMISSION_MEANS,
} = __test__;

// ── Statement classification ──
const READS = [
  "SELECT 1",
  "select * from tasks where id = 3",
  "  \n SELECT now()",
  "WITH t AS (SELECT 1) SELECT * FROM t",
  "EXPLAIN SELECT * FROM tasks",
  "SHOW server_version",
  "TABLE tasks",
  "VALUES (1),(2)",
  "SELECT * FROM tasks; SELECT * FROM sessions",
  "SELECT 'delete from tasks' AS harmless_text",
  "SELECT 1 -- delete from tasks",
  "SELECT 1 /* update tasks set x=1 */",
];
for (const sql of READS) ok(sqlIsReadOnly(sql) === true, `C6 classified as a read: ${sql.trim().slice(0, 48)}`);

const WRITES = [
  "INSERT INTO tasks (title) VALUES ('x')",
  "insert into tasks (title) values ('x')",
  "UPDATE tasks SET title = 'x'",
  "DELETE FROM tasks",
  "TRUNCATE tasks",
  "DROP TABLE tasks",
  "ALTER TABLE tasks ADD COLUMN c int",
  "CREATE TABLE t (id int)",
  "GRANT ALL ON tasks TO public",
  "REVOKE ALL ON tasks FROM public",
  "REFRESH MATERIALIZED VIEW mv",
  "VACUUM tasks",
  "REINDEX TABLE tasks",
  "COPY tasks FROM '/tmp/x'",
  "CALL do_something()",
  "DO $$ BEGIN PERFORM 1; END $$",
  "MERGE INTO tasks USING src ON true WHEN MATCHED THEN DELETE",
  // The CTE case: leads with WITH, writes anyway. A leading-keyword check alone
  // would wave this through.
  "WITH gone AS (DELETE FROM tasks RETURNING *) SELECT * FROM gone",
  "WITH added AS (INSERT INTO tasks (title) VALUES ('x') RETURNING *) SELECT * FROM added",
  // A read followed by a write in one batch is a write.
  "SELECT 1; DELETE FROM tasks",
  "SELECT * INTO new_table FROM tasks",
  "SELECT * FROM tasks FOR UPDATE",
  "SELECT * FROM tasks FOR NO KEY UPDATE",
  "SET session_replication_role = replica",
  "LOCK TABLE tasks",
  "BEGIN",
  "",
  "   ",
];
for (const sql of WRITES) ok(sqlIsReadOnly(sql) === false, `C6 classified as a write: ${sql.trim().slice(0, 48) || "(empty)"}`);

ok(!/delete/i.test(stripSqlNoise("SELECT 'delete' AS x")), "C6 string literals are stripped before classification");
ok(!/update/i.test(stripSqlNoise("SELECT 1 -- update tasks")), "C6 line comments are stripped before classification");
ok(!/drop/i.test(stripSqlNoise("SELECT 1 /* drop table t */")), "C6 block comments are stripped before classification");

// ── Tool classification ──
ok(toolAccessKind("omatic_search_memory", {}) === "read", "C6 a memory search is a read");
ok(toolAccessKind("omatic_list_tasks", {}) === "read", "C6 listing tasks is a read");
ok(toolAccessKind("omatic_record_decision", {}) === "write", "C6 recording a decision is a write");
ok(toolAccessKind("omatic_claim_work", {}) === "write", "C6 claiming work is a write");
ok(toolAccessKind("omatic_factory_startup_run", {}) === "write", "C6 startup_run is a write — it seeds and records");
ok(toolAccessKind("omatic_list_connections", {}) === "meta", "C6 the connection surface is meta, not a DB access");
ok(toolAccessKind("omatic_execute_sql", { sql: "SELECT 1" }) === "read", "C6 execute_sql is classified per statement");
ok(toolAccessKind("omatic_execute_sql", { sql: "DELETE FROM t" }) === "write", "C6 a DELETE through execute_sql is a write");
ok(
  toolAccessKind("omatic_some_tool_added_next_year", {}) === "write",
  "C6 an unclassified tool defaults to write — the guard fails closed"
);
// confirm_destructive is the operator approving a destructive statement. It is
// not, and must never become, a permission override.
ok(
  toolAccessKind("omatic_execute_sql", { sql: "DELETE FROM t", confirm_destructive: true }) === "write",
  "C6 confirm_destructive does not reclassify a write as a read"
);

// ── The refusal decision ──
ok(checkConnectionPermission("read_write", "write", "omatic", "t") === null, "C6 read_write permits a write");
ok(checkConnectionPermission("read_write", "read", "omatic", "t") === null, "C6 read_write permits a read");
ok(checkConnectionPermission("read_only", "read", "benecard", "t") === null, "C6 read_only permits a read");
ok(checkConnectionPermission("read_only", "write", "benecard", "t") !== null, "C6 read_only refuses a write");
ok(checkConnectionPermission("disabled", "read", "benecard", "t") !== null, "C6 disabled refuses even a read");
ok(checkConnectionPermission("disabled", "write", "benecard", "t") !== null, "C6 disabled refuses a write");
ok(checkConnectionPermission("disabled", "meta", "benecard", "t") === null, "C6 the connection surface stays usable on a disabled connection");
ok(checkConnectionPermission("read_only", "meta", "benecard", "t") === null, "C6 the connection surface stays usable on a read_only connection");

const roRefusal = checkConnectionPermission("read_only", "write", "benecard", "omatic_record_decision");
ok(/benecard/.test(roRefusal.message), "C6 the refusal names the connection");
ok(/read_only/.test(roRefusal.message), "C6 the refusal names the mode");
ok(/omatic_record_decision/.test(roRefusal.message), "C6 the refusal names the tool that was stopped");
ok(/never reached the database/.test(roRefusal.message), "C6 the refusal states the database was never reached");
ok(/omatic_edit_connection/.test(roRefusal.message), "C6 the refusal says how to change the mode");
ok(roRefusal.detail.reached_database === false, "C6 the refusal detail records that nothing reached the database");
ok(roRefusal.detail.refused_by === "connection_permission", "C6 the refusal detail names the guard that fired");

// ── Argument normalization ──
ok(normalizePermissionArg({}, "read_write") === "read_write", "C6 an absent permission keeps the current mode");
ok(normalizePermissionArg({ permission: "read-only" }, "read_write") === "read_only", "C6 a hyphenated mode is accepted");
ok(normalizePermissionArg({ permission: "READ_ONLY" }, "read_write") === "read_only", "C6 mode matching is case-insensitive");
throwsWith(() => normalizePermissionArg({ permission: "readonly" }, "read_write"), "C6 an unknown mode is rejected");
throwsWith(() => normalizePermissionArg({ permission: "admin" }, "read_write"), "C6 an invented mode is rejected");
ok(
  connectionsMod.normalizeFactoryConnections({ connections: [{ ...storedConn }] }, "omatic")[0].permission ===
    "read_write",
  "C6 a factory.json entry with no permission defaults to read_write (existing files are unaffected)"
);
ok(
  connectionsMod.normalizeFactoryConnections(
    { connections: [{ ...storedConn, permission: "read_only" }] },
    "omatic"
  )[0].permission === "read_only",
  "C6 a stored permission is read back off disk"
);
throwsWith(
  () => connectionsMod.normalizeFactoryConnections({ connections: [{ ...storedConn, permission: "god" }] }, "omatic"),
  "C6 an invalid permission in factory.json is rejected at load"
);
ok(
  connectionsMod.VALID_PERMISSIONS.size === 3 && connectionsMod.DEFAULT_PERMISSION === "read_write",
  "C6 there are exactly three modes and the default is read_write"
);

// ── Second layer: the pool itself ──
const roPoolOpts = connectionsMod.poolOptionsFor({ ...cfgFixture, permission: "read_only" }, false, {});
ok(
  roPoolOpts.options === "-c default_transaction_read_only=on",
  "C6 a read_only connection's pool runs with default_transaction_read_only=on"
);
ok(
  connectionsMod.poolOptionsFor({ ...cfgFixture, permission: "read_write" }, false, {}).options === undefined,
  "C6 a read_write connection's pool carries no read-only session option"
);

// ── The chokepoint, end to end ──
const permMgr = (permission) => {
  const env = fakeEnvFactory(factoryFile);
  return {
    env: () => env,
    project: () => ({ factory_id: "omatic", platform_profile: "claude-code", resolution: {} }),
    names: () => ["omatic", "benecard"],
    defaultName: () => "omatic",
    activeName: "omatic",
    has: (n) => ["omatic", "benecard"].includes(n),
    getConfig: (n) => ({ ...cfgFixture, name: n, permission: n === "benecard" ? permission : "read_write" }),
    permissionOf: (n) => (n === "benecard" ? permission : "read_write"),
    reload: async () => ({ ok: true }),
    // If the guard ever lets a call through, this is what it would reach. Any
    // assertion below that expects a refusal would instead see this throw,
    // which is the failure we want to be loud.
    execute: async () => {
      throw new Error("GUARD LEAKED: a refused call reached the database layer");
    },
    query: async () => {
      throw new Error("GUARD LEAKED: a refused call reached the database layer");
    },
  };
};

const refusedBody = async (permission, tool, args) =>
  parseResp(await handleToolCall(permMgr(permission), tool, args));

// read_only: writes refused, reads permitted through to the DB layer.
const roWrite = await handleToolCall(permMgr("read_only"), "omatic_execute_sql:benecard", {
  sql: "INSERT INTO members (name) VALUES ('x')",
});
const roWriteBody = parseResp(roWrite);
ok(roWrite.isError === true, "C6 an INSERT on a read_only connection sets isError");
ok(roWriteBody.outcome === "failed", "C6 a refused write reports outcome=failed");
ok(roWriteBody.refused === true, "C6 a refused write is marked refused");
ok(roWriteBody.reached_database === false, "C6 a refused write never reached the database");
ok(roWriteBody.connection === "benecard" && roWriteBody.permission === "read_only",
  "C6 the refusal payload names the connection and its mode");
ok(/read_only/.test(roWriteBody.error), "C6 the refusal message states the mode");

const roRead = parseResp(
  await handleToolCall(permMgr("read_only"), "omatic_execute_sql:benecard", { sql: "SELECT count(*) FROM members" })
);
ok(/GUARD LEAKED/.test(JSON.stringify(roRead)) === false || roRead.refused !== true,
  "C6 a SELECT on a read_only connection is not refused by the permission guard");
ok(roRead.refused === undefined, "C6 a SELECT on a read_only connection passes the guard");

// Every write tool, not just SQL. Most of these have no pinned variant (B8
// publishes pinned names only for the three read families), so they are driven
// through the unsuffixed path with the guarded connection as the session
// default — which is exactly how an operator reaches them.
const activePermMgr = (permission) => {
  const m = permMgr(permission);
  m.defaultName = () => "benecard";
  return m;
};
const activeBody = async (permission, tool, args = {}) =>
  parseResp(await handleToolCall(activePermMgr(permission), tool, args));

for (const tool of [
  "omatic_record_decision",
  "omatic_record_session_event",
  "omatic_record_probe_result",
  "omatic_claim_work",
  "omatic_release_work",
  "omatic_factory_startup_run",
]) {
  const body = await activeBody("read_only", tool);
  ok(body.refused === true, `C6 ${tool} is refused on a read_only connection`);
  ok(body.reached_database === false, `C6 ${tool} never reached the database`);
  ok(body.connection === "benecard", `C6 the ${tool} refusal names the connection`);
}

// Read tools stay available on read_only.
for (const tool of ["omatic_search_memory", "omatic_list_tasks", "omatic_embedding_status", "omatic_factory_health_check"]) {
  const body = await activeBody("read_only", tool);
  ok(body.refused === undefined, `C6 ${tool} is permitted on a read_only connection`);
}

// disabled: nothing DB-touching, reads included.
for (const tool of [
  "omatic_execute_sql",
  "omatic_search_memory",
  "omatic_list_tasks",
  "omatic_embedding_status",
  "omatic_record_decision",
  "omatic_factory_startup",
]) {
  const body = await activeBody("disabled", tool, { sql: "SELECT 1" });
  ok(body.refused === true, `C6 ${tool} is refused on a disabled connection`);
  ok(/disabled/.test(body.error), `C6 the ${tool} refusal states the connection is disabled`);
}

// ...but the connection surface still works on a disabled connection, or the
// operator has no way to un-park it.
const disabledList = parseResp(await handleToolCall(permMgr("disabled"), "omatic_list_connections", { probe: false }));
ok(disabledList.refused === undefined, "C6 a disabled connection can still be listed");
ok(
  parseResp(await handleToolCall(permMgr("disabled"), "omatic_usage_guide", { include_connections: false })).refused ===
    undefined,
  "C6 the usage guide is reachable regardless of permission"
);

// read_write is unchanged — the default must not alter existing behaviour.
for (const tool of ["omatic_execute_sql", "omatic_record_decision", "omatic_claim_work"]) {
  const body = await refusedBody("read_write", `${tool}:benecard`, { sql: "DELETE FROM t" });
  ok(body.refused === undefined, `C6 ${tool} is permitted on a read_write connection`);
}

// ── Bypass attempts ──
// The guard runs before the switch, so the pinned variant and the unsuffixed
// tool reach it identically; and no argument reaches the decision at all.
const bypassAttempts = [
  ["confirm_destructive", { sql: "DELETE FROM members", confirm_destructive: true }],
  ["uppercase SQL", { sql: "delete FROM members" }],
  ["leading whitespace and comments", { sql: "  /* just a read, honest */ DELETE FROM members" }],
  ["a write hidden behind a read in a batch", { sql: "SELECT 1; DELETE FROM members" }],
  ["a write hidden in a CTE", { sql: "WITH g AS (DELETE FROM members RETURNING *) SELECT * FROM g" }],
  ["SELECT INTO", { sql: "SELECT * INTO copy_of_members FROM members" }],
  ["SELECT FOR UPDATE", { sql: "SELECT * FROM members FOR UPDATE" }],
];
for (const [label, args] of bypassAttempts) {
  const body = await refusedBody("read_only", "omatic_execute_sql:benecard", args);
  ok(body.refused === true, `C6 bypass refused on read_only — ${label}`);
  ok(body.reached_database === false, `C6 bypass never reached the database — ${label}`);
}

// The removed raw aliases must not have come back as an unguarded path.
const permSurfaceNames = buildToolList(fakeConnections()).map((t) => t.name);
ok(
  !permSurfaceNames.some((n) => /^o-matic-server-|^postgres-cabinet-/.test(n)),
  "C6 the removed raw execute_sql aliases have not returned as a permission bypass"
);
// Every published tool that can reach a database must be classified. An
// unclassified tool defaults to write, so this is a discoverability check
// rather than a safety hole — but an unintentional write classification on a
// read tool is its own bug.
for (const name of permSurfaceNames) {
  const base = name.includes(":") ? name.slice(0, name.indexOf(":")) : name;
  ok(TOOL_ACCESS.has(base), `C6 ${base} has an explicit access classification`);
}

// Pinned and unsuffixed reach the same verdict.
const pinnedRefusal = await refusedBody("read_only", "omatic_execute_sql:benecard", { sql: "DELETE FROM t" });
const activeMgr = permMgr("read_only");
activeMgr.defaultName = () => "benecard";
const unsuffixedRefusal = parseResp(await handleToolCall(activeMgr, "omatic_execute_sql", { sql: "DELETE FROM t" }));
ok(pinnedRefusal.refused === true && unsuffixedRefusal.refused === true,
  "C6 the pinned variant and the unsuffixed tool are guarded identically");
ok(unsuffixedRefusal.connection === "benecard", "C6 the unsuffixed path resolves the active connection before guarding");

// A disabled connection may not be made the session default.
const setActiveDisabled = parseResp(
  await handleToolCall(permMgr("disabled"), "omatic_set_active_connection", { name: "benecard" })
);
ok(setActiveDisabled.refused === true, "C6 a disabled connection cannot be made the session default");
ok(/omatic_edit_connection/.test(setActiveDisabled.error), "C6 that refusal says how to re-enable it");
ok(
  parseResp(await handleToolCall(permMgr("read_only"), "omatic_set_active_connection", { name: "benecard" })).refused ===
    undefined,
  "C6 a read_only connection can still be made the session default"
);

// ── Round trip through the file, which is the operator's actual workflow ──
setProbeConnection(async (entry) => ({
  ok: true,
  info: { database: entry.database, user: entry.user },
  ssl: { configured: entry.sslMode, negotiated: "plaintext", encrypted: false },
}));
writeFactory([storedConn, { ...storedConn, name: "benecard", database: "benecard" }]);

const toReadOnly = parseResp(
  await handleToolCall(fakeConnMgr(), "omatic_edit_connection", { name: "benecard", permission: "read_only" })
);
ok(toReadOnly.success === true, "C6 a connection can be set to read_only through the edit tool");
ok(toReadOnly.changed_fields.includes("permission"), "C6 the permission change is reported as a changed field");
ok(
  readFactory().connections.find((c) => c.name === "benecard").permission === "read_only",
  "C6 the permission is persisted to factory.json"
);
ok(
  connectionsMod.normalizeFactoryConnections(readFactory(), "omatic").find((c) => c.name === "benecard").permission ===
    "read_only",
  "C5/C6 a fresh load sees the permission — it survives a respawn"
);

const permListing = parseResp(await handleToolCall(fakeConnMgr(), "omatic_list_connections", { probe: false }));
const benecardRow = permListing.connections.find((c) => c.name === "benecard");
ok(benecardRow.permission === "read_only", "C6 the listing shows the permission as a first-class field");
ok(typeof benecardRow.permission_means === "string", "C6 the listing explains what the mode means in plain English");
ok(
  Array.isArray(permListing.permissions) && permListing.permissions.some((p) => p.connection === "benecard"),
  "C6 the listing carries a per-connection permission summary"
);

// Parking a connection is never blocked by a failing probe — that is the case
// the mode exists for.
setProbeConnection(async () => ({ ok: false, error: "FATAL: the host is gone" }));
const parkIt = parseResp(
  await handleToolCall(fakeConnMgr(), "omatic_edit_connection", { name: "benecard", permission: "disabled" })
);
ok(parkIt.success === true, "C6 a broken connection can still be parked as disabled");
ok(parkIt.tested === false, "C6 parking a connection does not probe it");
ok(
  readFactory().connections.find((c) => c.name === "benecard").permission === "disabled",
  "C6 the disabled mode is persisted"
);
const parkedListing = parseResp(await handleToolCall(fakeConnMgr(), "omatic_list_connections", {}));
const parkedRow = parkedListing.connections.find((c) => c.name === "benecard");
ok(parkedRow.reachability_checked === false, "C6 a disabled connection is listed but never connected to");
ok(parkedRow.permission === "disabled", "C6 a parked connection is still visible in the listing");

// And back again.
setProbeConnection(async (entry) => ({
  ok: true,
  info: { database: entry.database, user: entry.user },
  ssl: { configured: entry.sslMode, negotiated: "plaintext", encrypted: false },
}));
const restore = parseResp(
  await handleToolCall(fakeConnMgr(), "omatic_edit_connection", { name: "benecard", permission: "read_write" })
);
ok(restore.success === true && restore.tested === true, "C6 re-enabling a connection re-tests it");
ok(
  readFactory().connections.find((c) => c.name === "benecard").permission === "read_write",
  "C6 the connection is restored to read_write"
);

// Adding straight to read_only.
const addRo = parseResp(
  await handleToolCall(fakeConnMgr(), "omatic_add_connection", {
    name: "client-db",
    host: "h",
    database: "d",
    user: "u",
    password: SECRET,
    ssl_mode: "disable",
    permission: "read_only",
  })
);
ok(addRo.permission === "read_only", "C6 a connection can be added directly as read_only");
ok(
  readFactory().connections.find((c) => c.name === "client-db").permission === "read_only",
  "C6 an added read_only connection is persisted with its mode"
);
ok(
  parseResp(
    await handleToolCall(fakeConnMgr(), "omatic_add_connection", {
      name: "default-perm",
      host: "h",
      database: "d",
      user: "u",
      password: SECRET,
      ssl_mode: "disable",
    })
  ).permission === "read_write",
  "C6 an add that says nothing about permission defaults to read_write"
);

resetProbeConnection();
fsMod.rmSync(tmpRoot, { recursive: true, force: true });

// ── C6 discoverability ──
ok(/permission/i.test(listDef.description), "C6 the listing description advertises the permission field");
ok(/read_only/.test(editDef.description), "C6 the edit description advertises read_only");
ok(/disabled/.test(editDef.description), "C6 the edit description advertises disabled");
ok(
  editDef.inputSchema.properties.permission &&
    Array.isArray(editDef.inputSchema.properties.permission.enum) &&
    editDef.inputSchema.properties.permission.enum.length === 3,
  "C6 the edit tool takes permission as an enum of exactly the three modes"
);
ok(
  addDef.inputSchema.properties.permission &&
    addDef.inputSchema.properties.permission.default === "read_write",
  "C6 the add tool defaults permission to read_write"
);
const sqlDef = cSurface.find((t) => t.name === "omatic_execute_sql");
ok(/cannot be overridden/i.test(sqlDef.description), "C6 the SQL tool states the permission cannot be overridden");
ok(/read_only/.test(sqlDef.description), "C6 the SQL tool description names the read_only behaviour");
ok(/permission/i.test(cInstructions), "C6 the server instructions describe per-connection permissions");
ok(/read_only/.test(cInstructions), "C6 the server instructions name the read_only mode");
ok(
  typeof guideBody.connection_management.control_access === "string" &&
    /no argument, flag or alias that bypasses it/.test(guideBody.connection_management.control_access),
  "C6 the usage guide states there is no bypass"
);
ok(
  Array.isArray(guideBody.connection_management.permission_modes) &&
    guideBody.connection_management.permission_modes.length === 3,
  "C6 the usage guide documents all three modes"
);
ok(
  guideBody.safety_rules.some((r) => /confirm_destructive does not override it/.test(r)),
  "C6 the safety rules state confirm_destructive is not a permission override"
);
ok(Object.keys(PERMISSION_MEANS).length === 3, "C6 every mode has a plain-English gloss");
ok(
  permissionForConnection({ getConfig: () => ({ permission: "read_only" }) }, "x") === "read_only",
  "C6 the permission resolver falls back to the stored config when permissionOf is absent"
);

// ── Section C documentation ──
// The docs are part of the deliverable: C4 is discoverability, and a tool an
// operator cannot find is a tool that does not exist for them.
const cReadme = fsMod.readFileSync(resolve(here, "../README.md"), "utf8");
for (const name of CONNECTION_TOOLS) {
  ok(cReadme.includes(name), `C4 the README documents ${name}`);
}
ok(/## The connection surface/.test(cReadme), "C4 the README has a connection surface section");
ok(/password is never returned/i.test(cReadme), "C4 the README states passwords are never returned");
ok(/Configured and negotiated are separate fields/i.test(cReadme),
  "C1 the README explains configured vs negotiated TLS");
ok(/### Per-connection permissions/.test(cReadme), "C6 the README documents per-connection permissions");
ok(/read_write/.test(cReadme) && /read_only/.test(cReadme) && /disabled/.test(cReadme),
  "C6 the README names all three permission modes");
ok(/no argument, flag or alias that bypasses it/i.test(cReadme), "C6 the README states there is no bypass");
ok(/fails closed/i.test(cReadme), "C6 the README states the guard fails closed");
ok(/default_transaction_read_only/.test(cReadme), "C6 the README documents the second enforcement layer");
ok(/\*\*21 base tools\*\*/.test(cReadme), "C4 the README reports the current base tool count");
ok(/total of \*\*36\*\*/.test(cReadme), "C4 the README reports the current total tool count");

const cChangelog = fsMod.readFileSync(resolve(here, "../CHANGELOG.md"), "utf8");
ok(/^## 3\.0\.1/m.test(cChangelog), "the CHANGELOG has a 3.0.1 entry");
ok(/omatic_test_connection/.test(cChangelog), "the CHANGELOG records the new test tool");
ok(/omatic_edit_connection/.test(cChangelog), "the CHANGELOG records the new edit tool");
ok(/Per-connection permissions/i.test(cChangelog), "the CHANGELOG records per-connection permissions");

if (failures.length) {
  console.error(`startup-modes smoke: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error("  FAIL:", f);
  process.exit(1);
}
console.log(`startup-modes smoke: ${pass} passed, 0 failed`);
