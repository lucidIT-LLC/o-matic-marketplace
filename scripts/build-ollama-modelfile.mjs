#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [agentId, baseModel = "llama3.1:8b"] = process.argv.slice(2);

if (!agentId) {
  console.error("Usage: node scripts/build-ollama-modelfile.mjs <smith|jo|tim|rimmer> [base-model]");
  process.exit(2);
}

const pack = JSON.parse(readFileSync(resolve(root, "agent-pack.json"), "utf8"));
const requestedAgent = agentId.toLowerCase();
const agent = pack.agents.find((item) => {
  const displayName = item.display_name?.toLowerCase();
  return item.id === requestedAgent || displayName === requestedAgent;
});

if (!agent) {
  console.error(`Unknown agent: ${agentId}`);
  process.exit(2);
}

const skill = readFileSync(resolve(root, agent.canonical_skill), "utf8").replaceAll('"""', '\\"\\"\\"');

process.stdout.write(`FROM ${baseModel}
PARAMETER temperature 0.2
SYSTEM """
${skill}
"""
`);
