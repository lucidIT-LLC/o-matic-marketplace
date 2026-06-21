#!/usr/bin/env node
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const {
  ConnectionManager,
  loadConnections,
  ensureFactoryJsonFromEnv,
} = require("./connections.js");
const {
  buildServerInstructions,
  buildToolList,
  handleToolCall,
  setNotifyToolsChanged,
} = require("./tools.js");

const PLUGIN_VERSION = "2.1.7";

async function main() {
  // A9 — upgrade migration: write factory.json from legacy hardcoded DSN if
  // none exists yet at the resolved project root. No-op once factory.json is
  // present, or if root looks like a plugin install dir.
  ensureFactoryJsonFromEnv();

  let connections;
  try {
    connections = new ConnectionManager(loadConnections());
  } catch (err) {
    process.stderr.write(`[omatic-server-connection] config error: ${err.message}\n`);
    process.exit(1);
  }

  const server = new Server(
    { name: "omatic-server-connection", version: PLUGIN_VERSION },
    {
      capabilities: { tools: { listChanged: true } },
      instructions: buildServerInstructions(),
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolList(connections),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(connections, name, args || {});
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // A2 — wire the tools/list_changed notifier. Tool handlers call this after
  // CRUD that changes the tool surface (add/remove/set_active connection).
  // Claude Code 2.1.0+ refreshes its tool list on receipt — no restart.
  setNotifyToolsChanged(() => server.sendToolListChanged());

  const shutdown = async () => {
    try {
      await connections.shutdown();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stderr.write(
    `[omatic-server-connection] ready — ${connections.names().length} connection(s): ${connections.names().join(", ") || "(none)"}\n`
  );
}

main().catch((err) => {
  process.stderr.write(`[omatic-server-connection] fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
