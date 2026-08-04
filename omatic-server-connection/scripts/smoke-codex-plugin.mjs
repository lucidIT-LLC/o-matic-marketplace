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
for (const path of [codexPluginPath, claudePluginPath, mcpPath, agentPackPath, serverPackagePath, serverIndexPath]) {
  assert(existsSync(path), `Missing required package file: ${path}`);
}

// Follow agent-pack.json's declared canonical_skill paths rather than restating
// one here. A hardcoded copy is a second source of truth that only announces
// itself when the two disagree — which is exactly what happened when the
// operating-guide skill was renamed and this line still named the old directory.
// Checking every declared skill is also strictly stronger than checking one.
const declaredSkills = readJson(agentPackPath)?.skills || [];
assert(declaredSkills.length > 0, "agent-pack.json declares no skills");
for (const skill of declaredSkills) {
  assert(skill.canonical_skill, `agent-pack.json skill "${skill.name || "?"}" declares no canonical_skill`);
  const skillPath = join(pluginRoot, skill.canonical_skill);
  assert(
    existsSync(skillPath),
    `agent-pack.json declares a skill file that does not exist: ${skill.canonical_skill}`
  );
}
const genericSkillPath = join(pluginRoot, declaredSkills[0].canonical_skill);

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
// #143 — this used to require command === "node", which enforced the exact
// defect KB-0418 names: a bare interpreter is unresolvable on a GUI-launched
// host, because it does not inherit the login shell PATH. The server was then
// never spawned and the host reported no tools, which is indistinguishable from
// an unresolved factory. The contract is now an ABSOLUTE command that always
// exists, with interpreter discovery moved into the launcher — a strictly
// stronger assertion than the one it replaces.
assert(
  typeof serverConfig.command === "string" && serverConfig.command.startsWith("/"),
  `Codex MCP server command must be an absolute path, got "${serverConfig.command}"`
);
assert(
  Array.isArray(serverConfig.args) && serverConfig.args.includes("${PLUGIN_ROOT}/bin/omatic-launch.sh"),
  "Codex MCP args must launch ${PLUGIN_ROOT}/bin/omatic-launch.sh"
);
assert(
  existsSync(join(pluginRoot, "bin", "omatic-launch.sh")),
  "Codex manifest points at a launcher that does not exist in the package"
);
assert(!Object.prototype.hasOwnProperty.call(serverConfig, "cwd"), "Codex MCP config must not pin cwd; Cowork falls back to process.cwd() when env vars are not expanded");
assert(serverConfig.env?.OMATIC_PLATFORM === "codex", "Codex MCP env must set OMATIC_PLATFORM=codex");
assert(serverConfig.env?.OMATIC_PROJECT_ROOT === "${CODEX_WORKSPACE}", "Codex MCP env must set OMATIC_PROJECT_ROOT=${CODEX_WORKSPACE}");
assert(serverConfig.env?.OMATIC_FACTORY_JSON_PATH === "${CODEX_WORKSPACE}/.omatic/factory.json", "Codex MCP env must set OMATIC_FACTORY_JSON_PATH from CODEX_WORKSPACE");

console.log(`smoke-codex-plugin ok: ${codexPlugin.name}@${version}`);
