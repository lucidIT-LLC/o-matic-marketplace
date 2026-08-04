#!/usr/bin/env node
// build-mcpb.mjs — package a plugin as an .mcpb desktop-extension bundle.
//
// An .mcpb is a zip with manifest.json at its ROOT (not nested in a folder).
// Getting that wrong produces a file the host rejects with no useful message,
// so the layout is asserted after packing rather than assumed.
//
// The manifest version is NOT authored here. It is read from the plugin's
// declared canonical version, because a version literal in a build script is
// exactly the undeclared second source of truth that rule #287 and KB-0414
// Step 5 exist to eliminate — and this repo has already been bitten by one.
//
// Usage: node scripts/build-mcpb.mjs <plugin-dir> [--out dist]

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from "node:fs";
import { join, resolve, basename } from "node:path";
import { execFileSync } from "node:child_process";

const args = process.argv.slice(2);
const pluginDir = args[0];
if (!pluginDir) {
  console.error("usage: node scripts/build-mcpb.mjs <plugin-dir> [--out dist]");
  process.exit(2);
}
const outIdx = args.indexOf("--out");
const outDir = resolve(outIdx >= 0 ? args[outIdx + 1] : "dist");

const repoRoot = resolve(new URL("..", import.meta.url).pathname);
const pluginPath = resolve(repoRoot, pluginDir);
const pluginName = basename(pluginPath);

function readJson(p) {
  return JSON.parse(readFileSync(p, "utf8"));
}

// Canonical version: the marketplace catalog entry, same source the alignment
// gate treats as authoritative.
const catalog = readJson(join(repoRoot, "marketplace.json"));
const entry = (catalog.plugins || []).find((p) => p.name === pluginName);
if (!entry) {
  console.error(`FAIL: ${pluginName} has no marketplace catalog entry`);
  process.exit(1);
}
const canonical = entry.version;

const manifestPath = join(pluginPath, "manifest.json");
if (!existsSync(manifestPath)) {
  console.error(`FAIL: ${pluginName}/manifest.json is missing — an .mcpb cannot be built without it`);
  process.exit(1);
}
const manifest = readJson(manifestPath);

// Required fields per the MCPB manifest spec. Checked here so a malformed
// bundle fails at build time rather than at install time on someone's desktop.
const required = ["manifest_version", "name", "version", "description", "author", "server"];
const missing = required.filter((k) => !manifest[k]);
if (missing.length) {
  console.error(`FAIL: manifest.json missing required field(s): ${missing.join(", ")}`);
  process.exit(1);
}
if (!manifest.author?.name) {
  console.error("FAIL: manifest.json author.name is required");
  process.exit(1);
}
if (!manifest.server?.entry_point || !manifest.server?.mcp_config?.command) {
  console.error("FAIL: manifest.json needs server.entry_point and server.mcp_config.command");
  process.exit(1);
}
if (manifest.version !== canonical) {
  console.error(`FAIL: manifest.json version ${manifest.version} != canonical ${canonical}`);
  process.exit(1);
}
const entryPointPath = join(pluginPath, manifest.server.entry_point);
if (!existsSync(entryPointPath)) {
  console.error(`FAIL: server.entry_point does not exist: ${manifest.server.entry_point}`);
  process.exit(1);
}

mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, `${pluginName}-${canonical}.mcpb`);
if (existsSync(outFile)) rmSync(outFile);

// Zip from INSIDE the plugin directory so manifest.json lands at the archive
// root. Excludes are the ones that make a bundle needlessly large or leak local
// state; .omatic in particular can hold a factory.json with connection details.
const excludes = [
  "*.DS_Store", "__MACOSX/*", ".git/*", ".git",
  "dist/*", "node_modules/.cache/*", ".omatic/*", "*.mcpb",
];
execFileSync(
  "zip",
  ["-r", "-q", outFile, ".", "-x", ...excludes],
  { cwd: pluginPath, stdio: "inherit" }
);

// Assert the layout rather than trusting it: manifest.json must be at the root
// of the archive, and the declared entry point must be present.
const listing = execFileSync("unzip", ["-Z1", outFile], { encoding: "utf8" }).split("\n");
const hasRootManifest = listing.includes("manifest.json");
const hasEntry = listing.includes(manifest.server.entry_point);
const sizeMb = (readFileSync(outFile).length / 1024 / 1024).toFixed(1);

console.log(`  built ${outFile}`);
console.log(`  size: ${sizeMb} MB, ${listing.filter(Boolean).length} entries`);
console.log(`  manifest.json at archive root: ${hasRootManifest ? "yes" : "NO"}`);
console.log(`  entry_point present (${manifest.server.entry_point}): ${hasEntry ? "yes" : "NO"}`);

if (!hasRootManifest || !hasEntry) {
  console.error("FAIL: bundle layout is wrong; the host would reject this");
  process.exit(1);
}

// Record the checksum so a published bundle can be tied back to a build.
const sha = execFileSync("shasum", ["-a", "256", outFile], { encoding: "utf8" }).split(" ")[0];
writeFileSync(`${outFile}.sha256`, `${sha}  ${basename(outFile)}\n`);
console.log(`  sha256: ${sha}`);
