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
// Usage:
//   node scripts/sync-shared-skills.mjs            # apply
//   node scripts/sync-shared-skills.mjs --check    # CI: exit 1 if any consumer is stale
//   node scripts/sync-shared-skills.mjs --dry-run  # report only

import { copyFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const check = args.has("--check");

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

const pluginsRoot = resolve(repoRoot, "..");
let stale = 0;

for (const skill of SHARED) {
  if (!existsSync(skill.source)) {
    console.error(`MISSING canonical source: ${skill.source}`);
    process.exitCode = 1;
    continue;
  }
  const canonical = readFileSync(skill.source);
  for (const rel of skill.consumers) {
    const target = resolve(pluginsRoot, rel);
    const current = existsSync(target) ? readFileSync(target) : null;
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

if (check && stale > 0) process.exitCode = 1;
if (!dryRun && !check) console.log(`done — ${stale} consumer(s) updated`);
