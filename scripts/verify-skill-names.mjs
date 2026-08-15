#!/usr/bin/env node
// Task #310. A SKILL.md whose frontmatter `name` does not match its parent
// directory FAILS TO LOAD ON VS CODE — silently. No error, no warning, no
// missing-file message. The skill simply is not there, and the only way to
// notice is that something you expected to be able to call cannot be called.
//
// Measured 2026-08-15, before this check existed:
//   .agents/skills/smith/SKILL.md  ->  name: crit-o-matic-smith   MISMATCH
//   .agents/skills/tim/SKILL.md    ->  name: tool-o-matic-tim     MISMATCH
// Two of four .agents skills, shipped, dead on one host, undetected.
//
// The frontmatter name is canonical — it is the name the skill is invoked by.
// So a mismatch is fixed by renaming the DIRECTORY, never by editing the name
// to match a wrong folder: that would silently rename the skill for every host
// that loads it correctly today.
//
// Pure file inspection. No network, no database, no host state — there was
// never a reason for this to be manual.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);

function findSkillFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      findSkillFiles(join(dir, e.name), out);
    } else if (e.name === "SKILL.md") {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

function frontmatterName(file) {
  const text = readFileSync(file, "utf8");
  if (!text.startsWith("---")) return { name: null, reason: "no frontmatter block" };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { name: null, reason: "unterminated frontmatter block" };
  const block = text.slice(3, end);
  const m = block.match(/^name:\s*(\S+)\s*$/m);
  if (!m) return { name: null, reason: "no `name:` key in frontmatter" };
  return { name: m[1], reason: null };
}

const files = findSkillFiles(repoRoot);
let bad = 0;

for (const file of files) {
  const dir = basename(dirname(file));
  const rel = relative(repoRoot, file);
  const { name, reason } = frontmatterName(file);

  if (!name) {
    console.error(`FAIL  ${rel}\n      ${reason} — a skill with no name cannot be invoked`);
    bad += 1;
    continue;
  }
  if (name !== dir) {
    console.error(
      `FAIL  ${rel}\n` +
        `      frontmatter name : ${name}\n` +
        `      parent directory : ${dir}\n` +
        `      This skill loads on some hosts and is SILENTLY ABSENT on VS Code.\n` +
        `      Fix by renaming the DIRECTORY to "${name}" — the frontmatter name is canonical.`
    );
    bad += 1;
    continue;
  }
  console.log(`ok    ${rel}`);
}

// A check that examined nothing has proved nothing (task #354).
if (files.length === 0) {
  console.error("::error::verify-skill-names found ZERO SKILL.md files — it examined nothing and proved nothing");
  process.exit(1);
}

console.log(`\n${files.length} skill file(s) checked, ${bad} mismatch(es).`);
process.exit(bad > 0 ? 1 : 0);
