#!/usr/bin/env node
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const marketplaceRoot = resolve(pluginRoot, "../..");

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const codexPluginPath = join(pluginRoot, ".codex-plugin", "plugin.json");
const claudePluginPath = join(pluginRoot, ".claude-plugin", "plugin.json");
const mcpPath = join(pluginRoot, ".mcp.json");
const agentPackPath = join(pluginRoot, "agent-pack.json");
const serverPackagePath = join(pluginRoot, "server", "package.json");
const serverIndexPath = join(pluginRoot, "server", "index.js");
const codexMarketplacePath = join(marketplaceRoot, ".agents", "plugins", "marketplace.json");
const claudeMarketplacePath = join(marketplaceRoot, ".claude-plugin", "marketplace.json");
const genericSkillPath = join(pluginRoot, "skills", "omatic-server-connection", "SKILL.md");

for (const path of [codexPluginPath, claudePluginPath, mcpPath, agentPackPath, serverPackagePath, serverIndexPath, genericSkillPath]) {
  assert(existsSync(path), `Missing required package file: ${path}`);
}

const codexPlugin = readJson(codexPluginPath);
const claudePlugin = readJson(claudePluginPath);
const mcp = readJson(mcpPath);
const agentPack = readJson(agentPackPath);
const serverPackage = readJson(serverPackagePath);
const serverIndex = readFileSync(serverIndexPath, "utf8");
const genericSkill = readFileSync(genericSkillPath, "utf8");

const version = codexPlugin.version;
assert(/^\d+\.\d+\.\d+$/.test(version), `Plugin version must be strict semver: ${version}`);
assert(claudePlugin.version === version, "Claude plugin version does not match Codex plugin version");
assert(agentPack.version === version, "agent-pack version does not match plugin version");
assert(serverPackage.version === version, "server/package.json version does not match plugin version");
assert(serverIndex.includes(`PLUGIN_VERSION = "${version}"`), "server/index.js PLUGIN_VERSION does not match plugin version");
assert(genericSkill.includes(`<!-- version: ${version} |`), "generic O-Matic Server skill version does not match plugin version");

if (existsSync(codexMarketplacePath)) {
  const codexMarketplace = readJson(codexMarketplacePath);
  const codexEntry = codexMarketplace.plugins?.find((entry) => entry.name === codexPlugin.name);
  assert(codexEntry?.version === version, "Codex marketplace version does not match plugin version");
}

if (existsSync(claudeMarketplacePath)) {
  const claudeMarketplace = readJson(claudeMarketplacePath);
  const claudeEntry = claudeMarketplace.plugins?.find((entry) => entry.name === codexPlugin.name);
  assert(claudeEntry?.version === version, "Claude marketplace version does not match plugin version");
}

assert(codexPlugin.mcpServers === "./.mcp.json", "Codex plugin manifest must point mcpServers at ./.mcp.json");
assert(!Object.prototype.hasOwnProperty.call(mcp, "mcp_servers"), "Codex .mcp.json must not use the stale mcp_servers key");
assert(Object.prototype.hasOwnProperty.call(mcp, "mcpServers"), "Codex .mcp.json must use mcpServers");
assert(mcp.mcpServers?.["omatic-server-connection"], "Codex .mcp.json must register omatic-server-connection");

const serverConfig = mcp.mcpServers["omatic-server-connection"];
assert(serverConfig.command === "node", "Codex MCP server command must be node");
assert(Array.isArray(serverConfig.args) && serverConfig.args.includes("${PLUGIN_ROOT}/server/index.js"), "Codex MCP args must launch ${PLUGIN_ROOT}/server/index.js");
assert(!Object.prototype.hasOwnProperty.call(serverConfig, "cwd"), "Codex MCP config must not pin cwd; Cowork falls back to process.cwd() when env vars are not expanded");
assert(serverConfig.env?.OMATIC_PLATFORM === "codex", "Codex MCP env must set OMATIC_PLATFORM=codex");
assert(serverConfig.env?.OMATIC_PROJECT_ROOT === "${CODEX_WORKSPACE}", "Codex MCP env must set OMATIC_PROJECT_ROOT=${CODEX_WORKSPACE}");
assert(serverConfig.env?.OMATIC_FACTORY_JSON_PATH === "${CODEX_WORKSPACE}/.omatic/factory.json", "Codex MCP env must set OMATIC_FACTORY_JSON_PATH from CODEX_WORKSPACE");

console.log(`smoke-codex-plugin ok: ${codexPlugin.name}@${version}`);
