#!/usr/bin/env node
// release-reconcile.mjs — STATE RECONCILIATION release driver.
//
// Desired state = each plugin's canonical catalog version.
// Actual state  = the set of immutable git tags `<plugin>-vX.Y.Z`.
// This script drives actual -> desired: for every plugin whose canonical version has
// no matching tag, it creates that immutable tag and publishes a GitHub Release.
//
// Properties (Smith pre-mortem):
//   - Idempotent: a plugin whose tag already exists is a clean no-op (never `git tag -f`).
//   - Handles N plugins bumped in one push (loops all; does not pick "the one").
//   - Never creates or moves the `stable` tag (decision #180).
//   - Never cuts the marketplace-wide `vX.Y.Z` milestone (that is MANUAL — decision #177).
//   - Per-plugin release notes scoped to the plugin's path (no monorepo commit soup).
//
// Default is a dry run. Pass --write to create tags + releases (CI passes --write).
// Requires: git, and for --write the `gh` CLI authenticated (GITHUB_TOKEN in Actions).

import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  loadMap,
  collectPlugin,
  tagExists,
  releaseExists,
  highestTagVersion,
  git,
  REPO_ROOT,
} from "./lib/versions.mjs";

const write = process.argv.includes("--write");
const map = loadMap();

function sh(cmd, cmdArgs) {
  return execFileSync(cmd, cmdArgs, { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

// Commits touching this plugin's path since its previous tag (scoped notes — Smith #11).
function releaseNotes(name, version) {
  const prev = highestTagVersion(name);
  const range = prev ? `${name}-v${prev}..HEAD` : "HEAD";
  let log = "";
  try {
    log = git(["log", "--no-merges", "--pretty=format:- %s (%h)", range, "--", `${name}/`]);
  } catch {
    log = "";
  }
  const changelog = join(REPO_ROOT, name, "CHANGELOG.md");
  const header = `Release ${name} v${version}`;
  const body =
    (log ? `### Changes\n${log}\n` : "### Changes\n- (no path-scoped commits found since previous tag)\n") +
    (existsSync(changelog) ? `\nSee \`${name}/CHANGELOG.md\` for the maintained changelog.\n` : "");
  return { header, body };
}

console.log(`release-reconcile ${write ? "(WRITE)" : "(dry run — pass --write to publish)"}\n`);

let cut = 0;
let repaired = 0;
let skipped = 0;
for (const name of Object.keys(map.plugins)) {
  const p = collectPlugin(name, map);
  const version = p.canonical;
  if (version == null) {
    console.log(`SKIP ${name}: no canonical version`);
    continue;
  }
  const tag = `${name}-v${version}`;
  const hasTag = tagExists(tag);
  const hasRelease = hasTag && releaseExists(tag);

  // Desired state = tag AND published Release both present.
  if (hasTag && hasRelease) {
    console.log(`  = ${tag} already released — no-op`);
    skipped++;
    continue;
  }

  const publishRelease = () => {
    const { header, body } = releaseNotes(name, version);
    sh("gh", [
      "release",
      "create",
      tag,
      "--repo",
      "lucidIT-LLC/o-matic-marketplace",
      "--title",
      header,
      "--notes",
      body,
      "--verify-tag",
    ]);
    console.log(`    published release ${tag}`);
  };

  // Tag exists but the Release is missing — publish on the EXISTING tag, never re-tag.
  if (hasTag && !hasRelease) {
    console.log(`  ~ ${tag} tag exists without a Release — publishing Release on existing tag`);
    repaired++;
    if (!write) continue;
    publishRelease();
    continue;
  }

  // No tag at all — cut the immutable tag at HEAD (never -f), then publish.
  console.log(`  + ${tag} — needs tag + release`);
  cut++;
  if (!write) continue;
  const { header } = releaseNotes(name, version);
  sh("git", ["tag", "-a", tag, "-m", header]);
  sh("git", ["push", "origin", `refs/tags/${tag}`]);
  publishRelease();
}

console.log(
  `\n${cut} tag(s) ${write ? "cut" : "would be cut"}, ${repaired} orphan tag(s) ${write ? "got releases" : "would get releases"}, ${skipped} already released.`
);
