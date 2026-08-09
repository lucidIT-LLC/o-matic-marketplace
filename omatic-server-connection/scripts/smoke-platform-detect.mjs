#!/usr/bin/env node
// smoke-platform-detect.mjs — the surface label must be derived, and must say
// where it came from.
//
// One .mcp.json ships to Codex, Claude Code and Cowork, so it cannot assert the
// host. It used to try: OMATIC_PLATFORM was hardcoded to "codex" for every
// surface. This suite pins the replacement behaviour.
//
// It also pins platform_profile_source. The VALUE alone is unfalsifiable —
// factory.json carries a literal platform_profile, so a reader cannot tell a
// detected surface from a string typed months ago. A capture that reads the
// value without the source proves nothing about the host.

import { readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const pluginRoot = resolve(new URL("..", import.meta.url).pathname);
const factoryMod = require(join(pluginRoot, "server/factory.js"));

let failed = 0;
const ok = (cond, msg) => {
  if (!cond) failed++;
  console.log(`  ${cond ? "ok  " : "FAIL"} ${msg}`);
};

// ── the manifest must not assert a host ───────────────────────────────────────
console.log("smoke-platform-detect");
const mcp = JSON.parse(readFileSync(join(pluginRoot, ".mcp.json"), "utf8"));
const serverEnv = mcp.mcpServers["omatic-server-connection"].env || {};
for (const key of ["OMATIC_PLATFORM", "OMATIC_PROJECT_ROOT", "OMATIC_FACTORY_JSON_PATH"]) {
  ok(serverEnv[key] === undefined, `.mcp.json does not hardcode ${key}`);
}

// ── detection, per host env shape ─────────────────────────────────────────────
// detectPlatform is module-private. Read it out of source rather than widening
// the export surface for a test; the slice is asserted so a refactor that moves
// the function fails loudly instead of silently testing nothing.
const src = readFileSync(join(pluginRoot, "server/factory.js"), "utf8");
const detectStart = src.indexOf("function detectPlatform");
const resolvedStart = src.indexOf("function resolvedOrNull");
const resolvedEnd = src.indexOf("function loadProjectContext");
ok(detectStart >= 0, "detectPlatform() is present in factory.js");
ok(resolvedStart > detectStart && resolvedEnd > resolvedStart, "resolvedOrNull() follows it and is extractable");
if (detectStart < 0 || resolvedEnd < 0) {
  console.log("\nsmoke-platform-detect FAILED: could not locate functions");
  process.exit(1);
}
const detectPlatform = new Function(
  src.slice(resolvedStart, resolvedEnd) + src.slice(detectStart, resolvedStart) + "\nreturn detectPlatform;"
)();

const LITERAL = "${CODEX_WORKSPACE}";
for (const [name, env, want] of [
  ["codex", { CODEX_WORKSPACE: "/w/p" }, "codex"],
  ["codex wins over an unexpanded Claude var", { CODEX_WORKSPACE: "/w/p", CLAUDE_PROJECT_DIR: "${CLAUDE_PROJECT_DIR}" }, "codex"],
  ["claude-code", { CLAUDE_PROJECT_DIR: "/u/p", CLAUDE_PLUGIN_DATA: "/d" }, "claude-code"],
  ["cowork", { CLAUDE_PLUGIN_ROOT: "/r", CLAUDE_PLUGIN_DATA: "/d" }, "cowork"],
  ["cowork, old manifest literal survives", { CODEX_WORKSPACE: LITERAL, CLAUDE_PLUGIN_ROOT: "/r" }, "cowork"],
  ["cowork, host expanded CODEX to empty", { CODEX_WORKSPACE: "", CLAUDE_PLUGIN_ROOT: "/r" }, "cowork"],
  ["unknown host yields null, not a guess", {}, null],
]) {
  ok(detectPlatform(env) === want, `detect ${name} -> ${String(want)}`);
}

// ── platform_profile_source: the capture-defeating case ───────────────────────
// factory.json pins platform_profile to a literal. Detection must outrank it,
// and the reported source must make that visible.
const root = mkdtempSync(join(tmpdir(), "omatic-detect-"));
mkdirSync(join(root, ".omatic"), { recursive: true });
writeFileSync(
  join(root, ".omatic", "factory.json"),
  JSON.stringify({
    factory_id: "t",
    platform_profile: "claude-code", // the literal that made Step 1 unfalsifiable
    connections: [{ name: "a", host: "h", port: 5432, database: "d", user: "u", password: "p" }],
  })
);
const state = mkdtempSync(join(tmpdir(), "omatic-detect-state-"));
const base = { OMATIC_PROJECT_ROOT: root, OMATIC_STATE_DIR: state, HOME: state };

const detected = factoryMod.loadProjectContext({ ...base, CLAUDE_PLUGIN_ROOT: "/r" });
ok(detected.platform_profile === "cowork", `detection outranks the factory.json literal (got ${detected.platform_profile})`);
ok(detected.platform_profile_source === "host detection", `source names detection (got ${detected.platform_profile_source})`);

const overridden = factoryMod.loadProjectContext({ ...base, OMATIC_PLATFORM: "claude-desktop" });
ok(overridden.platform_profile === "claude-desktop", "an explicit OMATIC_PLATFORM still wins");
ok(overridden.platform_profile_source === "OMATIC_PLATFORM", "source names the env override");

const fromFile = factoryMod.loadProjectContext({ ...base });
ok(fromFile.platform_profile === "claude-code", "unrecognisable host falls back to factory.json");
ok(fromFile.platform_profile_source === "factory.json", "source names the file, so a capture can discount it");

rmSync(root, { recursive: true, force: true });
rmSync(state, { recursive: true, force: true });

console.log(failed ? `\nsmoke-platform-detect FAILED (${failed})` : "\nsmoke-platform-detect passed");
process.exit(failed ? 1 : 0);
