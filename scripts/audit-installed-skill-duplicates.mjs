#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const allCache = args.has("--all-cache");
const allowSameSignature = args.has("--allow-same-signature");
const codexHome = resolve(valueArg("--codex-home") || process.env.CODEX_HOME || join(homedir(), ".codex"));
const configPath = resolve(valueArg("--config") || join(codexHome, "config.toml"));
const cacheRoot = resolve(valueArg("--plugin-cache") || join(codexHome, "plugins", "cache"));
const enabledPlugins = allCache ? null : readEnabledPlugins(configPath);
const skills = collectSkills(cacheRoot, enabledPlugins);
const groups = groupBy(skills, (skill) => skill.name);
const duplicates = [...groups.values()]
  .filter((group) => group.length > 1)
  .map((group) => {
    const sameSignature = new Set(group.map((skill) => `${skill.version}|${skill.signature}|${skill.sha256}`)).size === 1;
    return {
      name: group[0].name,
      sameSignature,
      providers: group.sort((a, b) => a.pluginKey.localeCompare(b.pluginKey)),
    };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

if (json) {
  console.log(JSON.stringify({ configPath, cacheRoot, allCache, duplicates }, null, 2));
} else if (!duplicates.length) {
  console.log("ok: no duplicate installed skill providers");
} else {
  for (const duplicate of duplicates) {
    const status = duplicate.sameSignature ? "same signature/content" : "drift";
    console.log(`DUPLICATE: ${duplicate.name} (${status})`);
    for (const provider of duplicate.providers) {
      console.log(`  - ${provider.pluginKey} v${provider.version} sig ${provider.signature}: ${provider.file}`);
    }
  }
}

if (duplicates.some((duplicate) => !allowSameSignature || !duplicate.sameSignature)) {
  process.exitCode = 1;
}

function collectSkills(root, enabled) {
  const skills = [];
  for (const marketplace of safeDirs(root)) {
    const marketplaceDir = join(root, marketplace);
    for (const plugin of safeDirs(marketplaceDir)) {
      const pluginDir = join(marketplaceDir, plugin);
      for (const version of safeDirs(pluginDir)) {
        const pluginKey = `${plugin}@${marketplace}`;
        if (enabled && !enabled.has(pluginKey)) continue;
        const skillsDir = join(pluginDir, version, "skills");
        collectSkillFiles(skillsDir, pluginKey, skills);
      }
    }
  }
  return skills;
}

function collectSkillFiles(dir, pluginKey, out) {
  if (!existsSync(dir)) return;
  for (const entry of safeDirs(dir)) {
    const skillDir = join(dir, entry);
    const file = join(skillDir, "SKILL.md");
    if (!existsSync(file)) {
      collectSkillFiles(skillDir, pluginKey, out);
      continue;
    }
    const text = readFileSync(file, "utf8");
    const frontmatter = parseFrontmatter(text);
    out.push({
      name: frontmatter.name || basename(skillDir),
      pluginKey,
      version: parseVersion(text),
      signature: parseSignature(text),
      sha256: createHash("sha256").update(text).digest("hex"),
      file,
    });
  }
}

function readEnabledPlugins(file) {
  if (!existsSync(file)) return new Set();
  const enabled = new Set();
  const text = readFileSync(file, "utf8");
  const re = /\[plugins\."([^"]+)"\]\s*\nenabled\s*=\s*true/g;
  for (const match of text.matchAll(re)) enabled.add(match[1]);
  return enabled;
}

function parseFrontmatter(text) {
  if (!text.startsWith("---\n")) return {};
  const end = text.indexOf("\n---\n", 4);
  if (end < 0) return {};
  return Object.fromEntries(
    text
      .slice(4, end)
      .split(/\r?\n/)
      .map((line) => {
        const index = line.indexOf(":");
        if (index < 0) return ["", ""];
        return [line.slice(0, index).trim(), line.slice(index + 1).trim().replace(/^"|"$/g, "")];
      })
      .filter(([key]) => key)
  );
}

function parseVersion(text) {
  return text.match(/<!--\s*version:\s*([0-9]+(?:\.[0-9]+){0,2})\b/i)?.[1] || "0.0.0";
}

function parseSignature(text) {
  return text.match(/\|\s*sig:\s*([0-9]+)\b/i)?.[1] || "0";
}

function safeDirs(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

function groupBy(items, keyFn) {
  const groups = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  }
  return groups;
}

function valueArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : "";
}
