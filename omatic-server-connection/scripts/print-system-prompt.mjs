#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pack = JSON.parse(readFileSync(resolve(root, "agent-pack.json"), "utf8"));
const skillId = process.argv[2];

if (!skillId) {
  console.error("Usage: node scripts/print-system-prompt.mjs <omatic-server-connection|embedder|probot|fred|data>");
  process.exit(2);
}

const requested = skillId.toLowerCase();
const skill = pack.skills.find((item) => {
  const displayName = item.display_name?.toLowerCase();
  return item.id === requested || displayName === requested;
});

if (!skill) {
  console.error(`Unknown skill: ${skillId}`);
  process.exit(2);
}

process.stdout.write(readFileSync(resolve(root, skill.canonical_skill), "utf8"));
