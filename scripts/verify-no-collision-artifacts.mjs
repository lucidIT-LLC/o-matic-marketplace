#!/usr/bin/env node
// Task #379. Finder collision artifacts — "factory 2.js" beside "factory.js" —
// are a SECOND DEFINITION that looks like a first one. The plugin loader does
// not distinguish them from real source.
//
// Measured 2026-08-14, before this check existed: 864 of them in the plugins
// working tree. 862 were noise inside vendored node_modules, but two were not:
//
//   omatic-server-connection/server/factory 2.js
//       a STALE VARIANT of live server/factory.js — ~16 diff lines apart, so
//       which one got loaded depended on the import path someone typed.
//   omatic-server-connection/scripts/smoke-startup-modes 2.mjs
//       had NO live original at all, and imported server/connections — the
//       module 5.0.0 deleted. A dead script wearing a filename that made it
//       look like a harmless duplicate of something safe.
//
// Nothing in the release path looked. Found by hand, during task #317.
//
// Pure file inspection. No network, no database, no host state — there was
// never a reason for this to be manual.

import { readdirSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ONE implementation, two trees. The same defect recurred in the factory repo
// (`/Users/lucid/Documents/Work/O-Matic`) within hours of this guard shipping here,
// because CI fires on push and Finder-made untracked files never get that far — the
// trigger did not match how the defect arrives. Rather than write a second checker
// that drifts from this one, the root and the required directories are arguments.
//   --root <path>       tree to scan          (default: this repo)
//   --require a,b,c     directories that must be descended into, or the run FAILS
const argv = process.argv.slice(2);
function argOf(flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : null;
}
const repoRoot = argOf("--root") || join(dirname(fileURLToPath(import.meta.url)), "..");

// Skipped by DIRECTORY NAME, never by matching a substring of the full path.
// A path-substring exclusion (`grep -v node_modules`) silently swallows the
// ENTIRE tree the moment the checkout lands under a directory that happens to
// contain the word — on a CI runner that path is not ours to choose. Name-based
// skipping cannot do that: it only ever skips a directory literally so named.
// Note "build" AND "Build": this comparison is case-sensitive even though macOS
// filesystems usually are not, and Xcode's directory is capitalised. Pointed at a
// tree containing an Xcode build, an uncalibrated scan returns thousands of
// intermediates and roughly 4MB of output — and a guard that loud is switched off
// within a week, which is exactly how `find-unwired.sh` stopped being used.
// Scope calibration is part of the check, not a convenience.
const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "Build", ".trash",
  "DerivedData", "Intermediates.noindex", ".venv", "__pycache__",
  ...(argOf("--skip") || "").split(",").map((s) => s.trim()).filter(Boolean),
]);

// The Finder shape: "<name> <n>.<ext>" or "<name> <n>", n >= 2.
const COLLISION = / [2-9]\d*(\.[A-Za-z0-9]+)?$/;

// Deliberate exceptions. A legitimately-named file ("Chapter 2.md") goes here
// EXPLICITLY, so that widening what this check tolerates requires saying so in
// the diff — the same principle as EXPECTED_CONSUMERS in smoke.yml.
const ALLOWLIST = new Set([]);

// The check must fail if it cannot RUN, not merely if it finds nothing. These
// directories must exist and must be descended into; if the repo layout changes
// under it, this check reports that instead of passing on an empty scan.
const REQUIRED_ROOTS = (argOf("--require") || "omatic-server-connection,o-matic-wordpress-factory,scripts")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const scanned = [];
const rootsSeen = new Set();

function walk(dir) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      const rel = relative(repoRoot, full);
      if (!rel.includes("/")) rootsSeen.add(rel);
      walk(full);
    } else {
      scanned.push(full);
    }
  }
}

walk(repoRoot);

// --- vacuous-pass guards, before any verdict -------------------------------

if (scanned.length === 0) {
  console.error(
    "::error::verify-no-collision-artifacts scanned ZERO files — it examined nothing and proved nothing"
  );
  process.exit(1);
}

const missingRoots = REQUIRED_ROOTS.filter((r) => !rootsSeen.has(r));
if (missingRoots.length > 0) {
  console.error(
    `::error::verify-no-collision-artifacts did not descend into: ${missingRoots.join(", ")}. ` +
      `The repo layout changed, or the checkout is not the repo root — this check cannot ` +
      `prove anything about directories it never entered. Fix the path or update REQUIRED_ROOTS.`
  );
  process.exit(1);
}

// --- the actual check -------------------------------------------------------

const hits = [];
for (const full of scanned) {
  const rel = relative(repoRoot, full);
  if (ALLOWLIST.has(rel)) continue;
  const name = rel.split("/").pop();
  if (COLLISION.test(name)) hits.push(rel);
}

for (const rel of hits) {
  console.error(
    `FAIL  ${rel}\n` +
      `      Finder collision artifact. This is a second definition of a file that\n` +
      `      the loader cannot tell from the first. Delete it, or — if it holds a\n` +
      `      change you want — diff it against the original and port that change\n` +
      `      deliberately. Never resolve it by renaming the original.`
  );
}

console.log(
  `${scanned.length} file(s) scanned across ${rootsSeen.size} top-level director(ies), ` +
    `${hits.length} collision artifact(s).`
);
process.exit(hits.length > 0 ? 1 : 0);
