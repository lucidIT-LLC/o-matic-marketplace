#!/usr/bin/env node
// Regenerate THIRD-PARTY-NOTICES.md from the vendored dependency tree.
//
// The plugin runtime is vendored deliberately — no host runs an install step, so
// the committed node_modules IS what ships, and this repository redistributes
// every package in it. MIT and BSD both require the license and copyright notice
// travel with the redistribution. A generated manifest is the auditable form of
// that, and generating it means it cannot drift from what is actually vendored.
//
//   node scripts/gen-third-party-notices.mjs           # write
//   node scripts/gen-third-party-notices.mjs --check    # exit 1 if stale (CI)

import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const modules = resolve(root, "omatic-server-connection/server/node_modules");
const target = resolve(root, "THIRD-PARTY-NOTICES.md");
const check = process.argv.includes("--check");

function readPkg(dir) {
  const p = join(dir, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function licenseOf(pkg) {
  const l = pkg.license ?? pkg.licenses;
  if (typeof l === "string") return l;
  if (Array.isArray(l)) return l.map((x) => x.type ?? x).join(" OR ");
  if (l && typeof l === "object") return l.type ?? "UNDECLARED";
  return "UNDECLARED";
}

const rows = [];
for (const entry of readdirSync(modules)) {
  if (entry.startsWith(".")) continue;
  const dir = join(modules, entry);
  if (entry.startsWith("@")) {
    // Scoped packages nest one level deeper.
    for (const scoped of readdirSync(dir)) {
      const pkg = readPkg(join(dir, scoped));
      if (pkg?.name) rows.push([pkg.name, pkg.version ?? "", licenseOf(pkg)]);
    }
    continue;
  }
  const pkg = readPkg(dir);
  if (pkg?.name) rows.push([pkg.name, pkg.version ?? "", licenseOf(pkg)]);
}
rows.sort((a, b) => a[0].localeCompare(b[0]));

const body = [
  "# Third-Party Notices",
  "",
  "`omatic-server-connection` vendors its runtime dependencies: no host runs an install",
  "step at plugin install, so the committed `node_modules` tree is what ships. The packages",
  "below are redistributed as part of this repository under their own licenses, reproduced",
  "in each package's directory under `omatic-server-connection/server/node_modules/`.",
  "",
  "Regenerate with `node scripts/gen-third-party-notices.mjs`.",
  "",
  "| Package | Version | License |",
  "|---|---|---|",
  ...rows.map(([n, v, l]) => `| \`${n}\` | ${v} | ${l} |`),
  "",
  `**${rows.length} packages.**`,
  "",
].join("\n");

if (check) {
  const current = existsSync(target) ? readFileSync(target, "utf8") : "";
  if (current === body) {
    console.log(`THIRD-PARTY-NOTICES.md matches the vendored tree — ${rows.length} packages ✅`);
    process.exit(0);
  }
  console.error("THIRD-PARTY-NOTICES.md is stale. Regenerate:");
  console.error("  node scripts/gen-third-party-notices.mjs");
  process.exit(1);
}

writeFileSync(target, body);
console.log(`wrote THIRD-PARTY-NOTICES.md — ${rows.length} packages`);

const undeclared = rows.filter(([, , l]) => l === "UNDECLARED");
if (undeclared.length) {
  console.warn(`\n${undeclared.length} package(s) declare no license:`);
  for (const [n] of undeclared) console.warn("  " + n);
  console.warn("Redistributing a package with no license grant is a legal exposure. Review before shipping.");
}
