// resources.js — the MCP Resources and Prompts this server publishes.
//
// MCP defines three primitives. Tools are model-controlled ACTIONS. Resources
// are app-controlled READ-ONLY DATA the host can browse and attach. Prompts are
// user-invocable TEMPLATES.
//
// 5.0.0: three of the five resources and three of the four prompts are gone,
// because their subjects are gone. omatic://connections, omatic://tasks and
// omatic://embedding-status each wrapped a database tool that no longer exists;
// a resource whose handler has been deleted is a dead URI, and a host that
// listed it would get an error on read. The factory-health-check,
// diagnose-a-connection and explain-embedding-status prompts told the model to
// call tools that are not there.
//
// What is left describes what this plugin can actually answer without touching
// a database: what it is, and which factory this session resolved. Database
// work is Conductor's — factory_query, connections_list and embed_query over
// MCP on https://localhost:8438.
//
// Resources wrap the SAME handlers the tools use. There is no second
// implementation to drift: a resource read is a tool call with a URI in front
// of it, so the honesty envelope (outcome / degraded_reasons /
// results_trustworthy) is inherited rather than reimplemented.

const RESOURCES = [
  {
    uri: "omatic://usage-guide",
    name: "O-Matic usage guide",
    description:
      "What this plugin does (resolve and pin the factory), what it no longer does (database access, removed in 5.0.0), and how to reach the factory databases through Conductor. Read before choosing tools in a new project.",
    mimeType: "application/json",
    tool: "omatic_usage_guide",
    args: {},
  },
  {
    uri: "omatic://factory",
    name: "Active factory",
    description:
      "The factory this session resolved, how it was resolved, every candidate root considered, and why each was accepted or rejected. Also reports whether factory.json still holds pre-5.0.0 credential fields that should be moved into Conductor.",
    mimeType: "application/json",
    tool: "omatic_resolve_factory",
    args: {},
  },
];

const PROMPTS = [
  {
    name: "start-the-factory",
    description: "Open a factory session: pin the factory, confirm it resolved, then reach the brain through Conductor.",
    arguments: [],
    build: () =>
      'Start the O-Matic factory. FIRST pin the factory with omatic_select_factory and an explicit project_root — ' +
      "the plugin's working directory is host-dependent and is not the project folder, and discovery never walks up " +
      "the directory tree, so an unpinned resolve finds nothing. Then call omatic_resolve_factory and check " +
      "factory_file is non-null; if it is null, STOP and report rather than working against an unresolved factory.\n\n" +
      "This plugin does not query the database — that surface was removed in 5.0.0. For the startup packet, open " +
      "tasks, memory search and session records, use Conductor over MCP on https://localhost:8438: connections_list " +
      "for what this app was granted, embed_query for a query vector, factory_query for the SQL. Conductor's " +
      "connection names are the operator-facing ones — o-MATIC Home Office, Commons, About Jimmy, Benecard, " +
      "lucidIT Corp, Practically Adventist, theNest.\n\n" +
      "Report connector readiness honestly: a connector with no measurement THIS session is untested, not OK. " +
      'A Conductor refusal ("this app was not granted access to X") is a refusal, never an empty result.',
  },
  {
    name: "diagnose-factory-resolution",
    description: "Work out why the factory did not resolve, without guessing.",
    arguments: [
      { name: "project_root", description: "Absolute path to the project that should be the factory.", required: false },
    ],
    build: (args) =>
      "Diagnose O-Matic factory resolution. Call omatic_resolve_factory and read the resolution trace: it lists " +
      "every candidate root in precedence order with the reason each was accepted or rejected. The two usual " +
      'causes are (1) the host never bound a project directory, so the plugin resolved against its own install ' +
      "directory, and (2) the factory.json lives in a parent folder — discovery does not walk up, by design " +
      "(rule #259).\n\nFix both the same way: " +
      `omatic_select_factory(project_root="${args?.project_root || "/absolute/path/to/project"}"). ` +
      "The pin is persisted and restored on the next start.\n\n" +
      "Note what this CANNOT be: a database problem. This plugin opens no database connections. If the factory " +
      "resolves but queries fail, that is Conductor on https://localhost:8438, not this server.",
  },
];

function buildResourceList() {
  return RESOURCES.map(({ uri, name, description, mimeType }) => ({
    uri,
    name,
    description,
    mimeType,
  }));
}

function buildPromptList() {
  return PROMPTS.map(({ name, description, arguments: a }) => ({
    name,
    description,
    arguments: a,
  }));
}

// Read a resource by delegating to the tool handler that already owns it.
// The tool's response text is returned verbatim, envelope and all — a resource
// that quietly dropped degraded_reasons would reintroduce the very defect the
// 3.0 response layer exists to prevent.
async function readResource(connections, uri, handleToolCall) {
  const entry = RESOURCES.find((r) => r.uri === uri);
  if (!entry) {
    const known = RESOURCES.map((r) => r.uri).join(", ");
    throw new Error(`Unknown resource: ${uri}. Known resources: ${known}`);
  }
  const result = await handleToolCall(connections, entry.tool, { ...entry.args });
  const text = (result?.content || [])
    .filter((c) => c && c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return {
    contents: [{ uri, mimeType: entry.mimeType, text }],
  };
}

function getPrompt(name, args) {
  const entry = PROMPTS.find((p) => p.name === name);
  if (!entry) {
    const known = PROMPTS.map((p) => p.name).join(", ");
    throw new Error(`Unknown prompt: ${name}. Known prompts: ${known}`);
  }
  return {
    description: entry.description,
    messages: [
      { role: "user", content: { type: "text", text: entry.build(args || {}) } },
    ],
  };
}

module.exports = { buildResourceList, buildPromptList, readResource, getPrompt, RESOURCES, PROMPTS };
