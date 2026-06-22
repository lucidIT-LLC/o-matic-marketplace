#!/usr/bin/env node
// version-align.mjs — rule #287 alignment gate for the o-matic-marketplace.
//
// Enforces, per plugin:
//   (a) existence   — every declared version source must exist
//   (b) equality    — all present sources must equal the canonical catalog version
//   (c) canonical   — marketplace.json is the source of truth
//   (d) monotonic   — catalog version must be >= the highest existing <plugin>-vX.Y.Z tag
//   (e) parity      — root and .claude-plugin catalog files must be byte-identical
//   (f) runtime     — runtime MCP server identity is read and reported, never silently skipped
//
// Exit 0 = aligned. Exit 1 = drift / regression / missing source. Designed for CI.
//
// Flags: --json (machine-readable report)  --no-tags (skip monotonicity; for shallow checkouts)

import { readFileSync } from "node:fs";
import {
  loadMap,
  collectPlugin,
  highestTagVersion,
  semverCmp,
  REPO_ROOT,
} from "./lib/versions.mjs";
import { join } from "node:path";

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const skipTags = args.includes("--no-tags");

const map = loadMap();
const report = { ok: true, plugins: [], catalogParity: null };

// (e) catalog parity — both files must be identical (Claude Code reads .claude-plugin/).
{
  const files = map.catalogFiles.map((f) => join(REPO_ROOT, f));
  try {
    const [a, b] = files.map((f) => readFileSync(f, "utf8"));
    report.catalogParity = a === b;
    if (a !== b) report.ok = false;
  } catch (e) {
    report.catalogParity = false;
    report.ok = false;
    report.catalogParityError = e.message;
  }
}

for (const name of Object.keys(map.plugins)) {
  const p = collectPlugin(name, map);
  const findings = [];
  const canonical = p.canonical;

  if (canonical == null) {
    findings.push({ level: "fail", msg: "no canonical catalog version found" });
  }

  let runtimeChecked = false;
  for (const s of p.sources) {
    const isRuntime = /runtime/i.test(s.label);
    if (isRuntime) runtimeChecked = true;

    if (!s.exists) {
      findings.push({ level: "fail", source: s.label, msg: `declared source missing: ${s.path}` });
      continue;
    }
    if (s.error) {
      findings.push({ level: "fail", source: s.label, msg: s.error });
      continue;
    }
    if (s.path === "marketplace.json") continue; // canonical, nothing to compare against itself
    if (canonical != null && s.value !== canonical) {
      findings.push({
        level: "fail",
        source: s.label,
        msg: `${s.value} != canonical ${canonical}`,
      });
    }
  }

  // (f) runtime identity: if this plugin ships an MCP server, a runtime source MUST be declared.
  if (p.runtime && !runtimeChecked) {
    findings.push({
      level: "fail",
      source: "runtime",
      msg: "runtime MCP server identity is UNVERIFIED — declare a runtime source in version-sources.json (no silent 3-of-4)",
    });
  }

  // (d) monotonicity vs highest existing tag.
  if (!skipTags && canonical != null) {
    const hi = highestTagVersion(name);
    if (hi && semverCmp(canonical, hi) < 0) {
      findings.push({
        level: "fail",
        source: "monotonicity",
        msg: `catalog ${canonical} is LOWER than released tag ${name}-v${hi} — version cannot go backwards`,
      });
    }
  }

  const ok = findings.filter((f) => f.level === "fail").length === 0;
  if (!ok) report.ok = false;
  report.plugins.push({
    name,
    canonical,
    runtime: p.runtime,
    runtimeChecked,
    sources: p.sources.map((s) => ({ label: s.label, value: s.value, exists: s.exists })),
    findings,
    ok,
  });
}

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

// Human report
const tick = (b) => (b ? "OK  " : "FAIL");
console.log("rule #287 version-alignment check\n");
console.log(`catalog parity (root == .claude-plugin): ${tick(report.catalogParity)}`);
if (report.catalogParityError) console.log(`  ${report.catalogParityError}`);
console.log("");

for (const pl of report.plugins) {
  console.log(`${tick(pl.ok)} ${pl.name}  (canonical ${pl.canonical ?? "?"})${pl.runtime ? "  [runtime MCP]" : ""}`);
  for (const s of pl.sources) {
    const mark = !s.exists ? "✗ missing" : s.value === pl.canonical ? "✓" : `≠ canonical ${pl.canonical}`;
    console.log(`      ${String(s.value ?? "—").padEnd(8)} ${mark}  ${s.label}`);
  }
  if (pl.runtime) {
    console.log(`      runtime identity: ${pl.runtimeChecked ? "verified" : "UNVERIFIED"}`);
  }
  for (const f of pl.findings) {
    console.log(`      → ${f.level.toUpperCase()} [${f.source || "plugin"}]: ${f.msg}`);
  }
  console.log("");
}

console.log(report.ok ? "RESULT: aligned ✅" : "RESULT: drift detected ❌");
process.exit(report.ok ? 0 : 1);
