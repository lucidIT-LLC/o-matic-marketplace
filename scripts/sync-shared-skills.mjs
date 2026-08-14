#!/usr/bin/env node
// sync-shared-skills.mjs — Canonical-source sync for skills that ship in more than one O-Matic pack.
//
// WHY (Session 108, decision #172): After absorbing the consulting plugins, the
// o-matic-marketplace repo is the CANONICAL home for the standalone skills (smith,
// jo, tim, rimmer). Jo also ships bundled inside the WordPress Factory. The copies
// drifted once (v4.0.1 vs v4.0.0). This syncs the canonical SKILL.md into each
// consumer byte-identically so they can never drift again.
//
// Byte-identical by design: diff == empty is the whole test. The package-label line
// is intentionally NOT rewritten — labeling is a branding decision (Brandy's lane).
//
// It also syncs FRAGMENTS: a marker-delimited BLOCK that must read identically inside
// several otherwise-different SKILL.md files (see the FRAGMENTS table below).
//
// Usage:
//   node scripts/sync-shared-skills.mjs                  # apply everything
//   node scripts/sync-shared-skills.mjs --check          # CI: exit 1 if anything is stale
//   node scripts/sync-shared-skills.mjs --dry-run        # report only
//   node scripts/sync-shared-skills.mjs --only=<name>    # one shared skill or fragment

import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const args = new Set(argv);
const dryRun = args.has("--dry-run");
const check = args.has("--check");

// --only=<name> restricts the run to one shared skill or fragment. Needed because
// consumers of a shared skill may live in a sibling repo that is not checked out in
// every workspace; without it you cannot sync a fragment here without also touching
// (or tripping over) an unrelated consumer.
const only = (argv.find((a) => a.startsWith("--only=")) || "").slice("--only=".length) || null;
const selected = (name) => !only || only === name;

// `source` is the canonical SKILL.md inside THIS marketplace repo.
// `consumers` are paths RELATIVE TO THE WORKSPACE PLUGINS ROOT (repoRoot/..).
const SHARED = [
  {
    name: "jo",
    source: join(repoRoot, "jo", "skills", "jo", "SKILL.md"),
    consumers: [
      // wp-factory carries a source copy (top-level) AND the packaged plugin copy
      // (nested under plugins/) that the marketplace actually ships. Both track canonical.
      "o-matic-wordpress-factory/skills/jo/SKILL.md",
      "o-matic-wordpress-factory/plugins/o-matic-wordpress-factory/skills/jo/SKILL.md",
    ],
  },
];

// FRAGMENTS — a canonical BLOCK of prose/SQL that must read identically inside
// several otherwise-different SKILL.md files. Whole-file sync cannot express this:
// Data, Fred and Probot are different skills that must state one shared fact the
// same way. Task #276: the pre-System-5 detection test was written out three times
// and all three drifted into a key-name check that false-positived every factory
// it was run against. One source, marker-delimited, byte-identical.
//
// The canonical .md file must itself begin and end with its marker pair.
const FRAGMENTS = [
  {
    name: "system-5-detection",
    source: join(repoRoot, "shared", "system-5-detection.md"),
    consumers: [
      "o-matic-marketplace/omatic-server-connection/skills/data-o-matic-data/SKILL.md",
      "o-matic-marketplace/omatic-server-connection/skills/find-o-matic-fred/SKILL.md",
      "o-matic-marketplace/omatic-server-connection/skills/orch-o-matic-probot/SKILL.md",
    ],
  },
];

const pluginsRoot = resolve(repoRoot, "..");
let stale = 0;

for (const skill of SHARED) {
  if (!selected(skill.name)) continue;
  if (!existsSync(skill.source)) {
    console.error(`MISSING canonical source: ${skill.source}`);
    process.exitCode = 1;
    continue;
  }
  const canonical = readFileSync(skill.source);
  for (const rel of skill.consumers) {
    const target = resolve(pluginsRoot, rel);
    // A consumer that is not present is a reportable gap, not a stale copy. Treating
    // it as stale used to make apply-mode throw ENOENT inside copyFileSync.
    if (!existsSync(target)) {
      console.error(`MISSING consumer: ${skill.name} -> ${rel} (not checked out in this workspace)`);
      process.exitCode = 1;
      continue;
    }
    const current = readFileSync(target);
    if (current && current.equals(canonical)) {
      console.log(`ok:    ${skill.name} -> ${rel} (in sync)`);
      continue;
    }
    stale += 1;
    if (dryRun || check) {
      console.log(`STALE: ${skill.name} -> ${rel} (would update)`);
      continue;
    }
    copyFileSync(skill.source, target);
    console.log(`sync:  ${skill.name} -> ${rel} (updated to canonical)`);
  }
}

for (const frag of FRAGMENTS) {
  if (!selected(frag.name)) continue;
  if (!existsSync(frag.source)) {
    console.error(`MISSING canonical fragment: ${frag.source}`);
    process.exitCode = 1;
    continue;
  }
  const startMark = `<!-- shared:${frag.name} start -->`;
  const endMark = `<!-- shared:${frag.name} end -->`;
  const block = readFileSync(frag.source, "utf8").trimEnd();
  if (!block.startsWith(startMark) || !block.endsWith(endMark)) {
    console.error(`MALFORMED canonical fragment (marker pair missing): ${frag.source}`);
    process.exitCode = 1;
    continue;
  }
  for (const rel of frag.consumers) {
    const target = resolve(pluginsRoot, rel);
    if (!existsSync(target)) {
      console.error(`MISSING consumer: ${frag.name} -> ${rel}`);
      process.exitCode = 1;
      continue;
    }
    const current = readFileSync(target, "utf8");
    const start = current.indexOf(startMark);
    const end = current.indexOf(endMark);
    if (start === -1 || end === -1 || end < start) {
      console.error(`NO MARKERS: ${frag.name} -> ${rel} (insert the ${startMark} / ${endMark} pair)`);
      process.exitCode = 1;
      continue;
    }
    const next = current.slice(0, start) + block + current.slice(end + endMark.length);
    if (next === current) {
      console.log(`ok:    ${frag.name} -> ${rel} (in sync)`);
      continue;
    }
    stale += 1;
    if (dryRun || check) {
      console.log(`STALE: ${frag.name} -> ${rel} (would update)`);
      continue;
    }
    writeFileSync(target, next);
    console.log(`sync:  ${frag.name} -> ${rel} (updated to canonical)`);
  }
}

if (check && stale > 0) process.exitCode = 1;
if (!dryRun && !check) console.log(`done — ${stale} consumer(s) updated`);
