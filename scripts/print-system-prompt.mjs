#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pack = JSON.parse(readFileSync(resolve(root, "agent-pack.json"), "utf8"));
const agentId = process.argv[2];

if (!agentId) {
  console.error("Usage: node scripts/print-system-prompt.mjs <smith|jo|tim|rimmer>");
  process.exit(2);
}

const requestedAgent = agentId.toLowerCase();
const agent = pack.agents.find((item) => {
  const displayName = item.display_name?.toLowerCase();
  return item.id === requestedAgent || displayName === requestedAgent;
});

if (!agent) {
  console.error(`Unknown agent: ${agentId}`);
  process.exit(2);
}

const skillPath = resolve(root, agent.canonical_skill);
process.stdout.write(readFileSync(skillPath, "utf8"));
