#!/usr/bin/env node
// backfill-versions.mjs — one-time reconciliation of drifted version sources.
//
// Forces every non-canonical source UP to its plugin's canonical catalog version
// (package.json, server/package.json, hardcoded runtime constants). FILE EDITS ONLY —
// it never tags, pushes, or publishes. Review with `git diff`, commit via PR, merge to
// `stable`, and release.yml cuts the missing immutable tags automatically.
//
// Default is a dry run. Pass --write to actually edit files.

import { loadMap, collectPlugin, writeSource } from "./lib/versions.mjs";

const write = process.argv.includes("--write");
const map = loadMap();

let changes = 0;
console.log(`backfill-versions ${write ? "(WRITE)" : "(dry run — pass --write to apply)"}\n`);

for (const name of Object.keys(map.plugins)) {
  const def = map.plugins[name];
  const p = collectPlugin(name, map);
  const canonical = p.canonical;
  if (canonical == null) {
    console.log(`SKIP ${name}: no canonical version`);
    continue;
  }

  for (let i = 0; i < def.sources.length; i++) {
    const source = def.sources[i];
    const read = p.sources[i];
    if (source.type === "marketplace") continue;
    if (!read.exists) {
      console.log(`  ${name}: ${source.label} missing (${source.path}) — not creating it here`);
      continue;
    }
    if (read.value === canonical) continue;

    console.log(`  ${name}: ${source.label}  ${read.value} -> ${canonical}`);
    changes++;
    if (write) writeSource(name, source, canonical);
  }
}

console.log(`\n${changes} source(s) ${write ? "rewritten" : "would change"}.`);
if (write) {
  console.log("Next: review `git diff`, open a PR into stable. release.yml will cut the missing tags on merge.");
} else if (changes > 0) {
  console.log("Re-run with --write to apply, then verify with: node scripts/version-align.mjs --no-tags");
}
