// resources.js — the two MCP primitives this server never declared.
//
// Punchlist B12: MCP defines three primitives. Tools are model-controlled
// ACTIONS. Resources are app-controlled READ-ONLY DATA the host can browse and
// attach. Prompts are user-invocable TEMPLATES. Through 3.0.1 this server
// shipped 34 of the first and none of the other two, which is why every
// read-only surface here — the usage guide, the connection list, the task list —
// had to be a "tool" the model chose to call, competing for tool-selection
// attention with the ones that actually do something.
//
// Resources wrap the SAME handlers the tools use. There is no second
// implementation to drift: a resource read is a tool call with a URI in front
// of it, so the honesty envelope (outcome / degraded_reasons /
// results_trustworthy) is inherited rather than reimplemented.
//
// Note on B13: this release does NOT remove the corresponding tools. Doing both
// at once would be a second breaking change to the tool surface inside one minor
// line, and CLAUDE.md, the Probot skill, and six other factories all name those
// tools directly. The count cut is staged, not forgotten.

const RESOURCES = [
  {
    uri: "omatic://usage-guide",
    name: "O-Matic usage guide",
    description:
      "How to drive this connector: startup, factory resolution, per-platform behavior, pgvector retrieval, and safe SQL patterns. Read before choosing tools in a new project.",
    mimeType: "application/json",
    tool: "omatic_usage_guide",
    args: {},
  },
  {
    uri: "omatic://factory",
    name: "Active factory",
    description:
      "The factory this session resolved, how it was resolved, every candidate root considered, and why each was accepted or rejected.",
    mimeType: "application/json",
    tool: "omatic_resolve_factory",
    args: {},
  },
  {
    uri: "omatic://connections",
    name: "Connections and live reachability",
    description:
      "Every configured connection with measured reachability, the negotiated TLS (not merely the configured sslmode), and its read_write / read_only / disabled permission. Passwords are never included.",
    mimeType: "application/json",
    tool: "omatic_list_connections",
    args: { probe: true },
  },
  {
    uri: "omatic://tasks",
    name: "Open tasks",
    description:
      "Open factory tasks with owner, priority and category. State is queried, not recalled — this is the authoritative list.",
    mimeType: "application/json",
    tool: "omatic_list_tasks",
    args: {},
  },
  {
    uri: "omatic://embedding-status",
    name: "Embedding and retrieval health",
    description:
      "Per-tier embedding health: embedded, unembedded and stale counts, model versions, and index presence. Read before diagnosing retrieval.",
    mimeType: "application/json",
    tool: "omatic_embedding_status",
    args: {},
  },
];

const PROMPTS = [
  {
    name: "start-the-factory",
    description:
      "Open a factory session: anchor the session, seed connector readiness, record probes, warm retrieval, and report the scoped startup packet.",
    arguments: [
      {
        name: "mode",
        description: "fast (routine entry — red/yellow and resume point only), normal (full readiness detail), or audit (force a fresh full check).",
        required: false,
      },
    ],
    build: (args) =>
      `Start the O-Matic factory. Pin the factory with omatic_select_factory and an explicit project_root FIRST — the plugin's working directory is host-dependent and is not the project folder, so an unpinned resolve fails with "no connection configured". Then run omatic_factory_startup_run with mode="${
        args?.mode || "normal"
      }". Report connector readiness honestly: a connector with no measurement THIS session is untested, not OK.`,
  },
  {
    name: "factory-health-check",
    description: "Mid-session health check without re-running startup.",
    arguments: [],
    build: () =>
      "Run omatic_factory_health_check against the active factory. Read the outcome field, not the prose: if outcome is degraded or failed, say so plainly and name every degraded_reason. A rendered summary that says clean while its source queries errored is the exact failure this connector was rebuilt to remove — do not repeat it in your own words.",
  },
  {
    name: "diagnose-a-connection",
    description: "Work out why a database connection is failing, without guessing.",
    arguments: [
      { name: "connection", description: "Name of the configured connection to diagnose.", required: false },
    ],
    build: (args) =>
      `Diagnose ${
        args?.connection ? `the "${args.connection}" connection` : "the failing connection"
      }. Start with omatic_list_connections — it measures reachability and reports the NEGOTIATED TLS alongside the configured ssl_mode, and a disagreement between those two is usually the bug. To try a host, user or password that is not saved, use omatic_test_connection: it changes nothing. Fix with omatic_edit_connection, which re-tests before it writes and writes nothing when the test fails.`,
  },
  {
    name: "explain-embedding-status",
    description: "Explain factory retrieval health and what to do about it.",
    arguments: [],
    build: () =>
      "Call omatic_embedding_status and explain the result in plain language: what is embedded, what is stale, what is unembedded, and what that means for retrieval quality right now. Note the known limit — the index probe is schema-scoped, so a factory whose content lives outside the searched schemas can report zero indexes while having several. If the tool declares it did not search a schema, say that rather than reporting zero as a finding.",
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
