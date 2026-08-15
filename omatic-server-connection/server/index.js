#!/usr/bin/env node
const { Server } = require("@modelcontextprotocol/sdk/server/index.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} = require("@modelcontextprotocol/sdk/types.js");

const {
  loadProjectContext,
  readSelectionState,
  restoreSelection,
} = require("./factory.js");
const {
  buildServerInstructions,
  buildToolList,
  handleToolCall,
  setNotifyToolsChanged,
  setClientSupportsResources,
  FactoryContext,
} = require("./tools.js");
const {
  buildResourceList,
  buildPromptList,
  readResource,
  getPrompt,
} = require("./resources.js");

// A literal on purpose: version-align.mjs (rule #287, source (f)) greps this
// exact pattern and fails CI unless it equals the canonical catalog version, so
// the runtime version cannot silently drift from what marketplace.json ships.
const PLUGIN_VERSION = "5.4.0";

// `--version` must answer and exit. It previously fell through to main(), which
// booted the whole server, resolved a factory, and only exited when stdin closed
// — so `npm run check` hung forever on a terminal. The check that was supposed to
// prove the server starts instead guaranteed nobody ran it.
if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(`omatic-server-connection ${PLUGIN_VERSION}\n`);
  process.exit(0);
}

// #143 — if the launcher resolved an interpreter the host could not see, say so
// in the host log. KB-0417 E1 makes the host log the first place to look when a
// tool surface is absent, so the log is where the evidence has to be. A silent
// success here is what made the PATH failure take a session to find.
const MIN_NODE_MAJOR = 18;
{
  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (process.env.OMATIC_RESOLVED_NODE) {
    process.stderr.write(
      `[omatic-server-connection] runtime resolved by launcher: ${process.env.OMATIC_RESOLVED_NODE} (node ${process.versions.node})\n`
    );
  }
  if (!Number.isFinite(nodeMajor) || nodeMajor < MIN_NODE_MAJOR) {
    process.stderr.write(
      `[omatic-server-connection] WARNING: running Node ${process.versions.node}; this server requires >= ${MIN_NODE_MAJOR}. Continuing, but treat every result as unsupported.\n`
    );
  }
}

async function main() {
  // B1 — restore a previously persisted factory selection before anything reads
  // the environment, so omatic_select_factory only has to be run once per
  // project rather than once per session. Applied to process.env directly.
  let context;
  try {
    const persisted = readSelectionState();
    if (persisted) {
      const restore = restoreSelection(process.env);
      if (restore.restored) {
        process.stderr.write(
          `[omatic-server-connection] restored persisted factory selection: ${restore.factory_file}\n`
        );
      } else {
        process.stderr.write(
          `[omatic-server-connection] persisted factory selection not restored: ${restore.reason}\n`
        );
      }
    }
    // 5.0.0: loadConnections() is gone. Resolving a factory no longer parses
    // DSNs or reads passwords, so an unresolvable factory is no longer a fatal
    // boot error — the server starts, publishes its four tools, and
    // omatic_select_factory is how the operator fixes it. Exiting here used to
    // leave the host with no tool surface at all and nothing to fix it with.
    context = new FactoryContext(loadProjectContext());
  } catch (err) {
    process.stderr.write(
      `[omatic-server-connection] factory not resolved at startup: ${err.message}\n` +
        "[omatic-server-connection] serving the factory-resolution tools anyway; " +
        'pin with omatic_select_factory(project_root="/absolute/path").\n'
    );
    context = new FactoryContext({ factory_id: "unresolved", factory_file: null, resolution: {} });
  }

  const server = new Server(
    { name: "omatic-server-connection", version: PLUGIN_VERSION },
    {
      // B12 — three primitives, not one. Tools are model-controlled actions;
      // Resources are app-controlled read-only data the host can browse and
      // attach; Prompts are user-invocable templates. Declaring only tools
      // forced every read-only surface to be an action the model had to choose.
      capabilities: {
        tools: { listChanged: true },
        resources: {},
        prompts: {},
      },
      instructions: buildServerInstructions(),
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: buildToolList(context),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return handleToolCall(context, name, args || {});
  });

  // B13 — the tool-surface cut, decided by BEHAVIOR rather than by declaration.
  //
  // The obvious implementation — read the client's capabilities and drop the
  // read-only tools if it declared resource support — cannot work: `resources`
  // is a SERVER capability. Clients declare roots, sampling and elicitation;
  // there is no client-side "I can read resources" flag to read. Asking for one
  // returns {} on every client, which would have silently meant "cut nothing,
  // ever" while looking like a working feature.
  //
  // A client that has actually CALLED resources/list has proven the capability
  // rather than asserted it. From that point the resource-backed read-only tools
  // are redundant for this client, so they leave tools/list and a
  // tools/list_changed notification tells the host to refresh. A client that
  // never reads resources keeps the full tool surface forever, which is the
  // correct outcome for a host that cannot use the alternative — and is why this
  // did not have to wait on B9's unanswered Cowork question.
  //
  // The tools stay CALLABLE either way. This changes what is advertised, not
  // what is dispatched.
  let resourceSurfaceProven = false;
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    if (!resourceSurfaceProven) {
      resourceSurfaceProven = true;
      setClientSupportsResources(true);
      try {
        server.sendToolListChanged();
      } catch {
        // A host that cannot receive the notification simply keeps the list it
        // already has. Nothing about the cut is worth failing a read over.
      }
      process.stderr.write(
        "[omatic-server-connection] client read resources/list — read-only tools now served as Resources\n"
      );
    }
    return { resources: buildResourceList() };
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) =>
    readResource(context, request.params.uri, handleToolCall)
  );

  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: buildPromptList(),
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) =>
    getPrompt(request.params.name, request.params.arguments)
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // A2 — wire the tools/list_changed notifier. omatic_select_factory calls it:
  // the tool NAMES are fixed now, but every description carries the active
  // factory_id, so a factory switch still changes the published surface.
  setNotifyToolsChanged(() => server.sendToolListChanged());

  // 5.0.0: nothing to drain. There are no pools to end — the process holds no
  // sockets, no credentials and no database state of any kind.
  const shutdown = async () => {
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const project = context.project();
  process.stderr.write(
    `[omatic-server-connection] ready — factory ${project.factory_id} (${project.factory_file || "unresolved"}); ` +
      "skills + factory resolution only, database access via Conductor on https://localhost:8438\n"
  );
}

main().catch((err) => {
  process.stderr.write(`[omatic-server-connection] fatal: ${err && err.stack ? err.stack : err}\n`);
  process.exit(1);
});
