#!/usr/bin/env node
// Smoke test for Factory 3.0 startup modes (workstream C): green-check cache +
// fast-wake view. Pure logic only — no DB, no network. See decision #186.
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const { __test__ } = require(resolve(here, "../server/tools.js"));
const {
  startupHealthIsGreen,
  getCachedStartupHealth,
  setCachedStartupHealth,
  formatFastStartupView,
  STARTUP_HEALTH_TTL_MS,
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
};
const clone = (o) => JSON.parse(JSON.stringify(o));
const warnConn = clone(green);
warnConn.readiness.rows[0].status_label = "DEGRADED";
const warnStale = clone(green);
warnStale.embedding.rows[0].stale = 5;
const warnRules = clone(green);
warnRules.summary.rows[0].governance_health.active_rule_count = 30;

// health detection
ok(startupHealthIsGreen(green) === true, "green snapshot is green");
ok(startupHealthIsGreen(warnConn) === false, "degraded connector -> not green");
ok(startupHealthIsGreen(warnStale) === false, "stale embeddings -> not green");
ok(startupHealthIsGreen(warnRules) === false, "rules below target -> not green");
ok(startupHealthIsGreen(null) === false, "null -> not green");

// cache lifecycle
const now = 1_000_000;
ok(setCachedStartupHealth("omatic", green, now) === true, "green is cached");
ok(getCachedStartupHealth("omatic", now + 1000) !== null, "cache hit within TTL");
ok(getCachedStartupHealth("omatic", now + STARTUP_HEALTH_TTL_MS + 1) === null, "cache expires after TTL");
ok(setCachedStartupHealth("t2", warnConn, now) === false, "non-green not cached");
ok(getCachedStartupHealth("t2", now) === null, "non-green absent from cache");
setCachedStartupHealth("omatic", green, now);
setCachedStartupHealth("omatic", warnStale, now);
ok(getCachedStartupHealth("omatic", now) === null, "non-green write evicts prior green");

// fast view — green
const gv = formatFastStartupView({
  mode: "fast",
  health_source: "fresh",
  startup: green,
  session: { id: 42, platform: "claude-code" },
  identity: { db_name: "o-matic" },
  factory: { factory_id: "omatic" },
});
ok(/FAST WAKE/.test(gv), "fast view header present");
ok(/Status: GREEN/.test(gv), "green fast view says GREEN");
ok(/Resume: resume here/.test(gv), "fast view shows resume point");
ok(/Open P1\+ tasks: 3/.test(gv), "fast view shows open task count");

// fast view — warnings surfaced
const wv = formatFastStartupView({
  mode: "fast",
  health_source: "cache",
  startup: warnConn,
  session: { id: 7 },
  identity: {},
  factory: {},
});
ok(/need attention/.test(wv), "warn fast view flags attention");
ok(/DEGRADED: connector postgres-omatic/.test(wv), "warn fast view names degraded connector");

if (failures.length) {
  console.error(`startup-modes smoke: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error("  FAIL:", f);
  process.exit(1);
}
console.log(`startup-modes smoke: ${pass} passed, 0 failed`);
