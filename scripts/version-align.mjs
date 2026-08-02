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
//   (g) undeclared  — a manifest that CARRIES a version but is not declared is a failure
//
// Exit 0 = aligned. Exit 1 = drift / regression / missing source. Designed for CI.
//
// Flags: --json (machine-readable report)  --no-tags (skip monotonicity; for shallow checkouts)

import { readFileSync, existsSync } from "node:fs";
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

// Files a plugin can carry a version in. Presence on disk plus a `version` key
// means it is a distribution surface and must be declared. Add to this list when
// a new manifest kind appears; that is cheaper than discovering it in production.
const WELL_KNOWN_VERSION_FILES = [
  ".claude-plugin/plugin.json",
  ".codex-plugin/plugin.json",
  "agent-pack.json",
  "package.json",
  "server/package.json",
];

// (e) catalog parity.
//
// Two distinct checks, because the catalogs are not all the same kind of file.
// The two Claude catalogs are literal copies and must stay byte-identical.
// The Codex catalog is structurally different by design (it carries a per-plugin
// release{} key the Claude manifests dropped in decision #194), so comparing its
// bytes is meaningless — what must hold is that every catalog agrees on every
// plugin VERSION.
//
// This previously destructured `const [a, b]`, so a third catalog was read and
// silently discarded. Adding .agents/plugins/marketplace.json to catalogFiles
// therefore changed nothing, and the gate reported aligned while never looking
// at it. That is not hypothetical: the shipped v2.2.1 tag carried a Codex
// manifest reading 2.2.0.
{
  const files = map.catalogFiles.map((f) => ({ rel: f, abs: join(REPO_ROOT, f) }));
  const problems = [];

  // byte parity across the Claude copies only
  const claudeCopies = files.filter((f) => !f.rel.startsWith(".agents/"));
  try {
    const texts = claudeCopies.map((f) => readFileSync(f.abs, "utf8"));
    if (!texts.every((t) => t === texts[0])) {
      problems.push(`Claude catalog copies differ: ${claudeCopies.map((f) => f.rel).join(" vs ")}`);
    }
  } catch (e) {
    problems.push(`unreadable Claude catalog: ${e.message}`);
  }

  // version parity across EVERY catalog, including Codex
  const versionsByPlugin = new Map();
  for (const f of files) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(f.abs, "utf8"));
    } catch (e) {
      problems.push(`unreadable catalog ${f.rel}: ${e.message}`);
      continue;
    }
    for (const entry of parsed.plugins || []) {
      if (!entry || !entry.name) continue;
      const seen = versionsByPlugin.get(entry.name) || new Map();
      const where = seen.get(entry.version) || [];
      where.push(f.rel);
      seen.set(entry.version, where);
      versionsByPlugin.set(entry.name, seen);
    }
  }
  for (const [plugin, byVersion] of versionsByPlugin) {
    if (byVersion.size > 1) {
      const detail = [...byVersion].map(([v, where]) => `${v} in ${where.join(", ")}`).join(" | ");
      problems.push(`${plugin} version disagrees across catalogs: ${detail}`);
    }
  }

  report.catalogParity = problems.length === 0;
  report.catalogsChecked = files.map((f) => f.rel);
  if (problems.length) {
    report.ok = false;
    report.catalogParityError = problems.join("; ");
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

  // (g) undeclared version sources.
  //
  // A file that carries a `version` but is absent from version-sources.json is
  // invisible to every check above, so it can ship a wrong version with nothing
  // to catch it. This is not hypothetical: o-matic-wordpress-factory shipped
  // 1.0.2 to Codex operators for exactly this reason while this gate printed
  // "aligned ✅" — its .codex-plugin/plugin.json was never declared. Checking
  // only what someone remembered to declare makes a green result meaningless.
  for (const rel of WELL_KNOWN_VERSION_FILES) {
    const abs = join(REPO_ROOT, name, rel);
    if (!existsSync(abs)) continue;
    let carriesVersion = false;
    try {
      carriesVersion = JSON.parse(readFileSync(abs, "utf8")).version != null;
    } catch {
      findings.push({ level: "fail", source: "undeclared", msg: `${name}/${rel} is unparseable` });
      continue;
    }
    if (!carriesVersion) continue;
    if (!p.sources.some((s) => s.path === `${name}/${rel}`)) {
      findings.push({
        level: "fail",
        source: "undeclared",
        msg: `${name}/${rel} carries a version but is not declared in version-sources.json — this gate cannot see it`,
      });
    }
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
