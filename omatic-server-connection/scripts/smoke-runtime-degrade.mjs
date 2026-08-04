#!/usr/bin/env node
// Task #143 — prove the plugin refuses to fail silently when its runtime is
// absent.
//
// The defect this covers is invisible from inside a host that works, which is
// why it survived repeated diagnosis (KB-0418) and cost a full session
// (KB-0417). A test that only passes when everything works is exactly what
// FA-2026-01 Step 6 says to stop writing, so this drives the launcher through
// BOTH outcomes and asserts the failing one is loud.

import { spawn } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const launcher = join(pluginRoot, "bin", "omatic-launch.sh");
const degraded = join(pluginRoot, "bin", "omatic-degraded-server.sh");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

// Speak MCP to a spawned process over stdio and collect the framed replies.
function handshake(env, { timeoutMs = 15000 } = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/sh", [launcher], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`handshake timed out after ${timeoutMs}ms\nstderr:\n${stderr}`));
    }, timeoutMs);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const messages = stdout
        .split("\n")
        .filter((l) => l.trim().startsWith("{"))
        .map((l) => {
          try {
            return JSON.parse(l);
          } catch {
            return null;
          }
        })
        .filter(Boolean);
      resolvePromise({ messages, stderr, stdout });
    });

    for (const msg of [
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "smoke", version: "0" } } },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list" },
    ]) {
      child.stdin.write(JSON.stringify(msg) + "\n");
    }
    child.stdin.end();
  });
}

const failures = [];
function check(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => console.log(`  ok   ${name}`))
    .catch((err) => {
      failures.push(`${name}: ${err.message}`);
      console.log(`  FAIL ${name}\n       ${err.message}`);
    });
}

console.log("smoke-runtime-degrade");

// 1. The launcher and its fallback must exist and be executable. A manifest
//    pointing at a non-executable shim reproduces the original defect with a
//    new cause.
await check("launcher and degraded server exist and are executable", () => {
  for (const path of [launcher, degraded]) {
    assert(existsSync(path), `missing: ${path}`);
    assert((statSync(path).mode & 0o111) !== 0, `not executable: ${path}`);
  }
});

// 2. No shipped manifest may name a bare interpreter. This is KB-0418 defect A
//    stated as an assertion instead of a warning.
await check("no shipped manifest declares a bare interpreter command", () => {
  const manifests = [
    join(pluginRoot, ".claude-plugin", "plugin.json"),
    join(pluginRoot, ".mcp.json"),
  ];
  for (const path of manifests) {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const servers = raw.mcpServers || raw.mcp_servers || raw;
    for (const [name, cfg] of Object.entries(servers)) {
      if (!cfg || typeof cfg !== "object" || !cfg.command) continue;
      assert(
        cfg.command.startsWith("/"),
        `${path} -> ${name} declares a non-absolute command "${cfg.command}"; GUI hosts do not inherit the login shell PATH`
      );
    }
  }
});

// 3. THE ONE THAT MATTERS. With the runtime forced absent, the host must still
//    get a complete handshake and a tool that names the cause.
await check("no runtime -> advisory server completes handshake and publishes a diagnostic tool", async () => {
  const { messages, stderr } = await handshake({
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: process.env.HOME || "/tmp",
    OMATIC_FORCE_NO_RUNTIME: "1",
  });

  const init = messages.find((m) => m.id === 1);
  assert(init, `no initialize response. stderr:\n${stderr}`);
  assert(init.result?.protocolVersion, "initialize returned no protocolVersion");
  assert(
    /advisory mode/i.test(init.result?.instructions || ""),
    "initialize instructions do not declare advisory mode"
  );

  // KB-0414 Step 5 — every file carrying a version must be declared to whatever
  // checks versions. The advisory server cannot read package.json (that needs
  // the runtime it is reporting missing), so the launcher lifts it with sed.
  // This proves the relay works instead of trusting it.
  const declaredVersion = JSON.parse(readFileSync(join(pluginRoot, "package.json"), "utf8")).version;
  assert(
    init.result?.serverInfo?.version === `${declaredVersion}-advisory`,
    `advisory serverInfo.version is "${init.result?.serverInfo?.version}", expected "${declaredVersion}-advisory" — the version relay has drifted`
  );

  const list = messages.find((m) => m.id === 2);
  assert(list, "no tools/list response");
  const tools = list.result?.tools || [];
  assert(tools.length === 1, `expected exactly 1 advisory tool, got ${tools.length}`);
  assert(
    tools[0].name === "omatic_runtime_status",
    `expected omatic_runtime_status, got ${tools[0].name}`
  );
  assert(
    /advisory mode/i.test(tools[0].description || ""),
    "advisory tool description does not name the cause"
  );
  assert(
    /advisory mode/i.test(stderr),
    "advisory mode was not written to stderr, so it will not reach the host log"
  );
});

// 4. The normal path must be untouched: a resolvable runtime still yields the
//    real server and its full tool surface.
await check("runtime present -> real server starts with the full tool surface", async () => {
  const { messages, stderr } = await handshake({
    ...process.env,
    OMATIC_NODE: process.execPath,
  });

  const list = messages.find((m) => m.id === 2);
  assert(list, `no tools/list response from the real server. stderr:\n${stderr}`);
  const tools = list.result?.tools || [];
  assert(
    tools.length > 1,
    `expected the real tool surface, got ${tools.length} tool(s) — this is the advisory server, not the real one`
  );
  assert(
    tools.some((t) => t.name === "omatic_resolve_factory"),
    "real server did not publish omatic_resolve_factory"
  );
  assert(
    /runtime resolved by launcher/.test(stderr),
    "launcher did not record the resolved runtime in the host log"
  );
});

console.log("");
if (failures.length) {
  console.error(`smoke-runtime-degrade FAILED (${failures.length})`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("smoke-runtime-degrade passed");
