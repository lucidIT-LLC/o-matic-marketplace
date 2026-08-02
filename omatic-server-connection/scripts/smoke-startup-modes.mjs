#!/usr/bin/env node
// Smoke test for Factory 3.0 startup modes (workstream C). Modes are reporting
// depth only — no cache (Smith gate, decision #188). Pure logic, no DB/network.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { __test__ } = require(resolve(here, "../server/tools.js"));
const {
  formatFastStartupView,
  formatStartupView,
  startupViewForMode,
  OutcomeCollector,
  runWithOutcome,
  currentOutcome,
  successResponse,
  errorResponse,
} = __test__;

let pass = 0;
const failures = [];
const ok = (cond, msg) => (cond ? pass++ : failures.push(msg));

// queryResult shape mirrors optionalQuery output: { ok, rows, count }
const green = {
  readiness: { ok: true, rows: [{ status_label: "OK", connector_name: "postgres-omatic" }] },
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

if (failures.length) {
  console.error(`startup-modes smoke: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error("  FAIL:", f);
  process.exit(1);
}
console.log(`startup-modes smoke: ${pass} passed, 0 failed`);
