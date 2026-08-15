#!/usr/bin/env node
// Task #311, reopened by the Pass 2 Smith gate 2026-08-15.
//
// The ROOT agent-pack.json is the host-neutral distribution manifest — it is what
// print-system-prompt.mjs and build-ollama-modelfile.mjs read for the Gemini and
// Ollama surfaces. It carries a `version` for every agent it ships.
//
// version-align.mjs CANNOT SEE IT. Its undeclared-source sweep walks
// REPO_ROOT/<plugin>/<well-known-file>, and this file sits at the repo root, under
// no plugin directory. So it is structurally invisible: not declared, and not
// caught by the check that exists to catch things nobody declared.
//
// The cost was measured, not theorised. #311 ("three-way version drift on Tim")
// was closed as "verified already resolved" because version-align printed
// `RESULT: aligned ✅`. At that moment this file carried Tim at 4.0.2 against a
// canonical 4.0.4, and Smith at 7.1.2 against 7.1.3. The gate was green over
// two-version drift on a real distribution surface, and the ticket was closed on
// the strength of that green.
//
// A gate that reports aligned while a shipped manifest is two versions behind is
// worse than no gate: it converts "nobody checked" into "someone checked."
//
// Pure file comparison. No network, no host state — so it runs anywhere,
// including a clean CI runner.

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packPath = join(repoRoot, "agent-pack.json");
const catalogPath = join(repoRoot, "marketplace.json");

if (!existsSync(packPath)) {
  console.error("::error::agent-pack.json is absent from the repo root — nothing to verify, and this check examined nothing");
  process.exit(1);
}

const pack = JSON.parse(readFileSync(packPath, "utf8"));
const catalog = JSON.parse(readFileSync(catalogPath, "utf8"));

// Canonical version per plugin, from the marketplace catalog (rule #287).
const canonical = new Map();
for (const p of catalog.plugins || []) {
  if (p.name && p.version) canonical.set(p.name, p.version);
}

// An agent entry identifies its skill by the directory in its codex_skill path,
// e.g. ".agents/skills/tool-o-matic-tim/SKILL.md" -> "tool-o-matic-tim". That
// directory name is also the frontmatter `name` (enforced by verify-skill-names).
function skillKey(entry) {
  if (typeof entry?.codex_skill !== "string") return null;
  const parts = entry.codex_skill.split("/");
  return parts.length >= 2 ? parts[parts.length - 2] : null;
}

// The catalog keys plugins by plugin name; the pack keys agents by skill name.
// These differ for the consulting-pack agents, so map explicitly rather than
// guessing — a wrong guess would silently skip an entry.
const SKILL_TO_PLUGIN = {
  "crit-o-matic-smith": "smith",
  "tool-o-matic-tim": "tim",
  jo: "jo",
  rimmer: "rimmer",
};

const entries = [];
(function walk(node) {
  if (Array.isArray(node)) return node.forEach(walk);
  if (node && typeof node === "object") {
    if (skillKey(node) && node.version) entries.push(node);
    Object.values(node).forEach(walk);
  }
})(pack);

// EXACT count, not "more than zero". Added at the Pass 2 re-gate, where Smith
// proved the collector silently shrinks: the walk admits a node only when BOTH
// skillKey(node) and node.version are truthy, so deleting an entry — or just its
// `codex_skill` or `version` key — drops it from the checked population and the
// script then reports "3 entries checked, 0 mismatches" and exits 0.
//
// The same commit that created this file raised the workflow's consumer guard
// from `-lt 1` to an exact count for precisely this reason, and applied the same
// principle to SKILL_TO_PLUGIN ("an unmapped entry is an unchecked entry") —
// then left the collector three lines below it unguarded. A population that can
// shrink unnoticed is not a control.
//
// When an agent is legitimately added or removed, this fails and you change the
// number in the same commit. That cost is the point.
const EXPECTED_AGENTS = 4;

if (entries.length !== EXPECTED_AGENTS) {
  console.error(
    `::error::agent-pack.json yielded ${entries.length} versioned agent entries, expected ${EXPECTED_AGENTS}. ` +
      `An entry missing its codex_skill or version key is dropped from this check SILENTLY. ` +
      `If you added or removed an agent, update EXPECTED_AGENTS in scripts/verify-agent-pack.mjs in the same commit.`
  );
  process.exit(1);
}

let bad = 0;
for (const e of entries) {
  const skill = skillKey(e);
  const plugin = SKILL_TO_PLUGIN[skill];
  if (!plugin) {
    console.error(`FAIL  ${skill}: no plugin mapping. Add it to SKILL_TO_PLUGIN — an unmapped entry is an unchecked entry.`);
    bad += 1;
    continue;
  }
  const want = canonical.get(plugin);
  if (!want) {
    console.error(`FAIL  ${skill}: plugin "${plugin}" is not in marketplace.json, so there is no canonical version to compare against.`);
    bad += 1;
    continue;
  }
  if (e.version !== want) {
    console.error(
      `FAIL  ${skill}\n` +
        `      agent-pack.json : ${e.version}\n` +
        `      canonical       : ${want}  (marketplace.json, plugin "${plugin}")\n` +
        `      This manifest ships to the Gemini and Ollama surfaces.`
    );
    bad += 1;
    continue;
  }
  console.log(`ok    ${skill.padEnd(22)} ${e.version}`);
}

console.log(`\n${entries.length} agent entr(ies) checked, ${bad} mismatch(es).`);
process.exit(bad > 0 ? 1 : 0);
