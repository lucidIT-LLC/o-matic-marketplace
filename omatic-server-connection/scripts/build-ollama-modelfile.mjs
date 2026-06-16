#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [skillId, baseModel = "llama3.1:8b"] = process.argv.slice(2);

if (!skillId) {
  console.error("Usage: node scripts/build-ollama-modelfile.mjs <omatic-server-connection|probot|fred|data> [base-model]");
  process.exit(2);
}

const pack = JSON.parse(readFileSync(resolve(root, "agent-pack.json"), "utf8"));
const requested = skillId.toLowerCase();
const skill = pack.skills.find((item) => {
  const displayName = item.display_name?.toLowerCase();
  return item.id === requested || displayName === requested;
});

if (!skill) {
  console.error(`Unknown skill: ${skillId}`);
  process.exit(2);
}

const body = readFileSync(resolve(root, skill.canonical_skill), "utf8").replaceAll('"""', '\\"\\"\\"');
const limitation = "Runtime note: this Modelfile provides prompt-only behavior. O-Matic factory DB operations require an MCP-capable host or an external tool bridge.";

process.stdout.write(`FROM ${baseModel}
PARAMETER temperature 0.2
SYSTEM """
${limitation}

${body}
"""
`);
