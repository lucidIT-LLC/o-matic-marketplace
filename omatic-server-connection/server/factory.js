// factory.js — factory resolution, and nothing else.
//
// This file was connections.js: a PostgreSQL connection manager that parsed
// DSNs, held passwords, negotiated TLS and handed out pg Pools. In 5.0.0 the
// plugin stopped being a database client (decision #283), so all of that is
// gone — the pg dependency with it. What remains is the one job the plugin is
// uniquely placed to do, because it is the only component that sees the host's
// project context: work out WHICH factory this session is in.
//
// Database access is Conductor's job now. Conductor holds the credentials in
// the macOS Keychain and grants them per paired app over MCP on
// https://localhost:8438 (factory_query, connections_list, embed_query). No
// credential is read, written, or held anywhere in this file.
//
// Rule #259 still governs: there is NO walk-up anywhere here. A factory.json in
// a parent directory is deliberately invisible.

const fs = require("fs");
const os = require("os");
const path = require("path");

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

function sanitizeName(value, fallback = "omatic") {
  const raw = String(value || fallback).toLowerCase();
  const name = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
  return NAME_PATTERN.test(name) ? name : fallback;
}

function readJsonIfExists(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (_) {
    return null;
  }
}

function isPluginInstallPath(dirPath) {
  const normalized = String(dirPath || "").replace(/\\/g, "/");
  return (
    normalized.includes("/plugins/cache/") ||
    normalized.includes("/plugins/omatic-server") ||
    normalized.includes("/omatic-server-connection") ||
    normalized.includes(".mcpb") ||
    normalized.includes("/Claude Extensions/")
  );
}

// ── Persisted factory selection (B1) ─────────────────────────────────────────
//
// omatic_select_factory used to mutate a throwaway object, so the selection
// died with the process and the operator had to re-select on every restart.
// The choice is now written to a small JSON file in a durable, host-provided
// state directory and restored on init.
//
// Only paths are stored. No host, port, user, password or DSN ever reaches
// this file — it is not a new credential-at-rest surface.

const SELECTION_STATE_FILE = "factory-selection.json";
const SELECTION_STATE_VERSION = 1;

// ${CLAUDE_PLUGIN_DATA} is Claude Code's documented per-plugin persistent data
// directory (~/.claude/plugins/data/<plugin-id>/), created on first reference
// and preserved across plugin updates. Codex publishes no equivalent, so the
// chain degrades to XDG, then the home directory, then tmp as a last resort.
function stateDir(env = process.env) {
  const explicit = resolvedOrNull(env.OMATIC_STATE_DIR);
  if (explicit) return { dir: path.resolve(explicit), source: "OMATIC_STATE_DIR", durable: true };

  const pluginData = resolvedOrNull(env.CLAUDE_PLUGIN_DATA);
  if (pluginData) return { dir: path.resolve(pluginData), source: "CLAUDE_PLUGIN_DATA", durable: true };

  const xdg = resolvedOrNull(env.XDG_STATE_HOME);
  if (xdg) {
    return { dir: path.join(path.resolve(xdg), "omatic-server-connection"), source: "XDG_STATE_HOME", durable: true };
  }

  const home = resolvedOrNull(env.HOME) || resolvedOrNull(env.USERPROFILE) || os.homedir();
  if (home) return { dir: path.join(path.resolve(home), ".omatic", "state"), source: "home", durable: true };

  // Non-durable. Better than losing the selection inside a single process.
  return { dir: path.join(os.tmpdir(), "omatic-server-connection"), source: "tmpdir", durable: false };
}

function selectionStatePath(env = process.env) {
  return path.join(stateDir(env).dir, SELECTION_STATE_FILE);
}

function readSelectionState(env = process.env) {
  const parsed = readJsonIfExists(selectionStatePath(env));
  const selection = parsed && typeof parsed === "object" ? parsed.selection : null;
  if (!selection || typeof selection !== "object") return null;

  const factoryJsonPath =
    typeof selection.factory_json_path === "string" && selection.factory_json_path
      ? path.resolve(selection.factory_json_path)
      : null;
  const projectRoot =
    typeof selection.project_root === "string" && selection.project_root
      ? path.resolve(selection.project_root)
      : null;
  if (!factoryJsonPath && !projectRoot) return null;

  return {
    factory_json_path: factoryJsonPath,
    project_root: projectRoot,
    selected_at: selection.selected_at || null,
    host_project_dir: selection.host_project_dir || null,
  };
}

// Never throws: a read-only state directory must degrade to session-scoped
// behaviour, not break factory selection.
function writeSelectionState(selection, env = process.env) {
  const { dir, source, durable } = stateDir(env);
  const file = path.join(dir, SELECTION_STATE_FILE);
  try {
    fs.mkdirSync(dir, { recursive: true });
    const payload = {
      version: SELECTION_STATE_VERSION,
      selection: { ...selection, selected_at: new Date().toISOString() },
    };
    const tmpPath = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
    fs.renameSync(tmpPath, file);
    return { persisted: true, path: file, state_dir_source: source, durable };
  } catch (err) {
    return { persisted: false, path: file, state_dir_source: source, durable, error: errMessage(err) };
  }
}

function clearSelectionState(env = process.env) {
  const file = selectionStatePath(env);
  try {
    if (fs.existsSync(file)) fs.unlinkSync(file);
    return { cleared: true, path: file };
  } catch (err) {
    return { cleared: false, path: file, error: errMessage(err) };
  }
}

// ── Project root resolution (B2 / B3) ────────────────────────────────────────
//
// B2. process.cwd() used to be a first-class candidate, and when every named
// candidate was filtered out the function handed back the unfiltered list —
// which on Codex means the plugin install directory, because that is what cwd
// is there. Plugin install paths are now excluded outright and cwd is the last
// candidate considered, never a fallback that resurrects a rejected root.
//
// B3. ${CODEX_WORKSPACE} is bound at spawn and has been observed pointing at a
// different project than the one in use. A workspace-derived root is therefore
// only accepted when it actually carries .omatic/factory.json, and it always
// ranks below the operator's own persisted selection.
//
// There is no walk-up anywhere in this file (rule #259). A factory.json in a
// parent directory is deliberately invisible.

const ROOT_SOURCES = [
  { key: "OMATIC_PROJECT_ROOT", trust: "manifest" },
  { key: "CLAUDE_PROJECT_DIR", trust: "host" },
  { key: "CODEX_PROJECT_ROOT", trust: "workspace" },
  { key: "CODEX_WORKSPACE", trust: "workspace" },
  { key: "CODEX_WORKSPACE_ROOT", trust: "workspace" },
  { key: "WORKSPACE_ROOT", trust: "workspace" },
  { key: "PROJECT_ROOT", trust: "workspace" },
  { key: "INIT_CWD", trust: "ambient" },
  { key: "PWD", trust: "ambient" },
];

function inspectRoot(source, trust, rawValue) {
  const raw = rawValue === undefined || rawValue === null ? null : String(rawValue);
  const resolved = resolvedOrNull(rawValue);
  if (!resolved) {
    return {
      source,
      trust,
      root: null,
      accepted: false,
      reason: raw ? "unresolved ${VAR} literal — the host did not expand it" : "unset",
    };
  }

  const root = path.resolve(resolved);
  if (isPluginInstallPath(root)) {
    return { source, trust, root, accepted: false, reason: "plugin install directory, not a project" };
  }
  if (!fs.existsSync(root)) {
    return { source, trust, root, accepted: false, reason: "path does not exist" };
  }

  const factoryFile = path.join(root, ".omatic", "factory.json");
  const hasFactory = fs.existsSync(factoryFile);
  return {
    source,
    trust,
    root,
    accepted: hasFactory,
    is_project_dir: true,
    factory_file: hasFactory ? factoryFile : null,
    reason: hasFactory ? "has .omatic/factory.json" : "no .omatic/factory.json at this root (no walk-up)",
  };
}

// Ranked, fully annotated candidate list. Every entry records why it was or
// was not accepted so the B4 error can explain itself.
function projectRootCandidates(env = process.env) {
  const candidates = [];

  const hostDir = inspectRoot("CLAUDE_PROJECT_DIR", "host", env.CLAUDE_PROJECT_DIR);

  const persisted = readSelectionState(env);
  const persistedRoot = persisted
    ? persisted.project_root ||
      (persisted.factory_json_path ? path.dirname(path.dirname(persisted.factory_json_path)) : null)
    : null;

  // The operator's persisted choice outranks everything, except an explicit
  // host-provided project directory for a *different* project that carries its
  // own factory. Opening a different project is a stronger signal than an old
  // selection; a stale ${CODEX_WORKSPACE} binding is not.
  const hostOverridesPersisted =
    hostDir.accepted && persistedRoot !== null && path.resolve(hostDir.root) !== path.resolve(persistedRoot);

  const persistedCandidate = persistedRoot
    ? inspectRoot("persisted selection", "operator", persistedRoot)
    : null;
  if (persistedCandidate) {
    persistedCandidate.persisted = true;
    if (hostOverridesPersisted) {
      persistedCandidate.superseded_by = "CLAUDE_PROJECT_DIR (different project, has its own factory.json)";
    }
  }

  if (persistedCandidate && !hostOverridesPersisted) candidates.push(persistedCandidate);
  for (const { key, trust } of ROOT_SOURCES) {
    candidates.push(key === "CLAUDE_PROJECT_DIR" ? hostDir : inspectRoot(key, trust, env[key]));
  }
  if (persistedCandidate && hostOverridesPersisted) candidates.push(persistedCandidate);

  // cwd last, and only on its own merits. It is the plugin install directory on
  // some hosts, which inspectRoot rejects.
  candidates.push(inspectRoot("process.cwd()", "ambient", process.cwd()));

  // Collapse duplicates, keeping the highest-ranked occurrence.
  const seen = new Set();
  for (const candidate of candidates) {
    if (!candidate.root) continue;
    if (seen.has(candidate.root)) {
      candidate.accepted = false;
      candidate.reason = "duplicate of a higher-precedence candidate";
      continue;
    }
    seen.add(candidate.root);
  }

  return candidates;
}

// Roots that resolve a factory, in precedence order.
function candidateProjectRoots(env = process.env) {
  return projectRootCandidates(env)
    .filter((candidate) => candidate.accepted)
    .map((candidate) => candidate.root);
}

// Roots usable as a *write* target for a factory.json that does not exist yet.
// Wider than the list above — a real directory is enough — but still never a
// plugin install directory.
function candidateWriteRoots(env = process.env) {
  return projectRootCandidates(env)
    .filter((candidate) => candidate.is_project_dir)
    .map((candidate) => candidate.root);
}

// An explicitly pinned factory.json: the manifest's OMATIC_FACTORY_JSON_PATH,
// or the operator's persisted pin. Must exist on disk to count — B3: a pointer
// derived from a stale workspace variable is rejected rather than followed.
function explicitFactoryPin(env = process.env) {
  const fromEnvRaw = resolvedOrNull(env.OMATIC_FACTORY_JSON_PATH);
  const fromEnv = fromEnvRaw ? path.resolve(fromEnvRaw) : null;
  const persisted = readSelectionState(env);
  const fromState = persisted && persisted.factory_json_path ? persisted.factory_json_path : null;

  const hostDir = inspectRoot("CLAUDE_PROJECT_DIR", "host", env.CLAUDE_PROJECT_DIR);
  const stateRoot = fromState ? path.dirname(path.dirname(fromState)) : null;
  const hostOverridesPersisted =
    hostDir.accepted && stateRoot !== null && path.resolve(hostDir.root) !== path.resolve(stateRoot);

  const ordered = hostOverridesPersisted
    ? [
        { source: "OMATIC_FACTORY_JSON_PATH", value: fromEnv },
        { source: "persisted selection", value: fromState },
      ]
    : [
        { source: "persisted selection", value: fromState },
        { source: "OMATIC_FACTORY_JSON_PATH", value: fromEnv },
      ];

  const rejected = [];
  for (const entry of ordered) {
    if (!entry.value) continue;
    if (!fs.existsSync(entry.value)) {
      rejected.push({ ...entry, reason: "pinned factory.json does not exist" });
      continue;
    }
    return { path: entry.value, source: entry.source, rejected };
  }
  return { path: null, source: null, rejected };
}

// Re-apply a persisted selection to `env` at startup, unless the host has named
// a different project that carries its own factory.json — deliberately opening
// another project must still win over a stale selection.
function restoreSelection(env = process.env) {
  const persisted = readSelectionState(env);
  if (!persisted) return { restored: false, reason: "no persisted selection" };

  const persistedRoot =
    persisted.project_root ||
    (persisted.factory_json_path ? path.dirname(path.dirname(persisted.factory_json_path)) : null);

  const hostDir = inspectRoot("CLAUDE_PROJECT_DIR", "host", env.CLAUDE_PROJECT_DIR);
  if (hostDir.accepted && persistedRoot && path.resolve(hostDir.root) !== path.resolve(persistedRoot)) {
    return {
      restored: false,
      reason: `host names a different project with its own factory.json (${hostDir.root})`,
      persisted_root: persistedRoot,
    };
  }

  const target =
    persisted.factory_json_path || (persistedRoot ? path.join(persistedRoot, ".omatic", "factory.json") : null);
  if (!target || !fs.existsSync(target)) {
    return { restored: false, reason: `persisted factory.json no longer exists (${target || "unknown"})` };
  }

  if (persisted.factory_json_path) {
    env.OMATIC_FACTORY_JSON_PATH = persisted.factory_json_path;
    delete env.OMATIC_PROJECT_ROOT;
  } else {
    env.OMATIC_PROJECT_ROOT = persistedRoot;
    delete env.OMATIC_FACTORY_JSON_PATH;
  }
  return { restored: true, factory_file: target, selected_at: persisted.selected_at };
}

// ── Resolution reporting (B4) ────────────────────────────────────────────────

function factoryResolutionReport(env = process.env) {
  const candidates = projectRootCandidates(env);
  const pin = explicitFactoryPin(env);
  const accepted = candidates.find((candidate) => candidate.accepted) || null;
  const state = stateDir(env);
  return {
    factory_file: pin.path || (accepted ? accepted.factory_file : null),
    resolved_via: pin.path ? pin.source : accepted ? accepted.source : null,
    explicit_pin: pin.path,
    rejected_pins: pin.rejected,
    candidates,
    state_file: path.join(state.dir, SELECTION_STATE_FILE),
    state_dir_source: state.source,
    state_durable: state.durable,
  };
}

// B4. The old failure said "No O-Matic Server connection is configured for this
// project", which names the wrong problem: the connections were fine, the
// factory was never resolved. This says which roots were tried, why each was
// rejected, and how to recover.
function unresolvedFactoryError(env = process.env) {
  const report = factoryResolutionReport(env);
  const lines = [
    "Could not resolve an O-Matic factory: no .omatic/factory.json was found at any candidate project root.",
    "",
    "Roots tried, in precedence order:",
  ];
  for (const candidate of report.candidates) {
    lines.push(`  - ${candidate.source}: ${candidate.root || "(unset)"} — ${candidate.reason}`);
  }
  for (const rejection of report.rejected_pins) {
    lines.push(`  - ${rejection.source}: ${rejection.value} — ${rejection.reason}`);
  }
  lines.push(
    "",
    "Factory discovery never walks up the directory tree, so a .omatic/factory.json in a parent",
    "folder is ignored on purpose. The project root itself must contain one.",
    "",
    "Recovery — pin the factory explicitly:",
    '  omatic_select_factory(project_root="/absolute/path/to/the/project")',
    "",
    `The selection is persisted to ${report.state_file} and restored automatically on the next start,`,
    "so this only needs doing once per project.",
    "",
    // 5.0.0: this used to name six connection-CRUD tools, because the plugin was
    // the thing that held the credentials. It no longer is. An operator reading
    // this error needs to be sent to the component that can actually help, and
    // that is Conductor — so the recovery path names it rather than tools that
    // no longer exist.
    "If there is no factory.json here yet, create one by hand. It carries identity only:",
    '  {"factory_id": "omatic", "connection_profile": "default"}',
    "It must NOT contain a host, user, password or database_url — this plugin no longer reads them,",
    "and a credential written there is a credential at rest for nothing.",
    "",
    "Database access does not come from this plugin. Conductor holds the credentials in the Mac",
    "Keychain and serves them to paired apps over MCP on https://localhost:8438:",
    "  connections_list()   — which connections this app was granted",
    "  factory_query(...)   — SQL against a granted connection; the caller never sees the credential",
    "  embed_query(...)     — a query vector on the weights the corpus was embedded under",
    "Conductor's connection names are the operator-facing ones: o-MATIC Home Office, Commons,",
    "About Jimmy, Benecard, lucidIT Corp, Practically Adventist, theNest."
  );
  if (!report.state_durable) {
    lines.push(
      "",
      `Warning: no durable state directory is available (using ${report.state_dir_source}); the selection may not survive a reboot.`
    );
  }
  const err = new Error(lines.join("\n"));
  err.code = "OMATIC_FACTORY_UNRESOLVED";
  err.report = report;
  return err;
}

// Some plugin runtimes (Cowork .mcpb, certain Codex installs) do NOT expand
// ${VAR} patterns in manifest env blocks — the literal string is passed
// through to the child process. Detect that and treat as unset so the
// process.cwd() / no-op fallbacks fire instead of resolving to a dead path.
// ── Host platform detection ──────────────────────────────────────────────────
//
// One manifest ships to every host, so the surface cannot be asserted at
// package time — it has to be observed at spawn. Signals, in order:
//
//   codex        any CODEX_* workspace variable is bound
//   claude-code  the CLI binds CLAUDE_PROJECT_DIR to the open project
//   cowork       a Claude plugin host that binds no project dir. Cowork runs
//                the server from a session-scoped scratch directory and leaves
//                CLAUDE_PROJECT_DIR unset, which is precisely why it needs the
//                persisted selection written by omatic_select_factory.
//
// "claude-desktop" is deliberately absent from this vocabulary. The .mcpb
// desktop-extension build sets OMATIC_PLATFORM=claude-desktop explicitly in its
// manifest, and an explicit value outranks detection — so that surface never
// reaches this function. Cowork and Claude Desktop are otherwise not separable
// from the environment, and inventing a distinction the env cannot support is
// how the previous label became untrustworthy in the first place.
//
// Returns null when nothing is recognisable, so callers fall through to
// factory.json rather than getting a confidently wrong label.
function detectPlatform(env = process.env) {
  if (
    resolvedOrNull(env.CODEX_WORKSPACE) ||
    resolvedOrNull(env.CODEX_PROJECT_ROOT) ||
    resolvedOrNull(env.CODEX_WORKSPACE_ROOT)
  ) {
    return "codex";
  }
  if (resolvedOrNull(env.CLAUDE_PROJECT_DIR)) return "claude-code";
  if (resolvedOrNull(env.CLAUDE_PLUGIN_ROOT) || resolvedOrNull(env.CLAUDE_PLUGIN_DATA)) return "cowork";
  return null;
}

function resolvedOrNull(value) {
  if (value === undefined || value === null) return null;
  const str = String(value);
  if (!str) return null;
  if (/\$\{[A-Za-z_][A-Za-z0-9_.]*\}/.test(str)) return null; // unresolved variable literal
  return str;
}

// Credential keys that a pre-5.0.0 factory.json may still hold. We report which
// of these are PRESENT and never what they contain — the value is not read, not
// returned, and not logged. This is a migration prompt, not a credential store.
const LEGACY_CONNECTION_FIELDS = ["password", "database_url", "databaseUrl", "user", "host"];

function describeLegacyConnectionFields(factory) {
  const found = new Set();
  const scan = (obj) => {
    if (!obj || typeof obj !== "object") return;
    for (const key of LEGACY_CONNECTION_FIELDS) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") found.add(key);
    }
  };
  scan(factory);
  if (Array.isArray(factory.connections)) for (const entry of factory.connections) scan(entry);

  const present = [...found];
  return {
    present: present.length > 0,
    keys: present,
    connection_entries: Array.isArray(factory.connections) ? factory.connections.length : 0,
    note: present.length
      ? "This factory.json still holds pre-5.0.0 connection fields. Nothing reads them — this plugin " +
        "is not a database client and Conductor holds the real credentials in the Keychain. Move any " +
        "live credential into Conductor and delete these keys; until then they are a credential at rest " +
        "serving no purpose. Key names are listed above; no value was read."
      : "No legacy connection fields in factory.json.",
  };
}

function loadProjectContext(env = process.env) {
  // Defensive: unresolved ${VAR} literals (e.g. ${CLAUDE_PROJECT_DIR} on
  // Cowork where the manifest var didn't expand) are treated as unset.
  // Strict resolution (project-root only). Either an explicitly pinned path
  // (OMATIC_FACTORY_JSON_PATH, or the operator's persisted selection), or
  // <projectRoot>/.omatic/factory.json at one of the ranked candidate roots.
  // There is NO walk-up: discovery never climbs past the project into a parent
  // or global .omatic/factory.json. This is the fix for the plugin latching
  // onto the first/highest factory.json it finds ("stuck on the first
  // database"). A pinned path that does not exist is rejected, not followed.
  const report = factoryResolutionReport(env);
  const roots = candidateProjectRoots(env);
  const writeRoots = candidateWriteRoots(env);
  const root = roots[0] || writeRoots[0] || null;
  const explicitFactoryPath = report.explicit_pin;
  const factoryFile = report.factory_file;
  const projectRootForFiles = factoryFile ? path.dirname(path.dirname(factoryFile)) : null;
  const projectFile =
    (projectRootForFiles && fs.existsSync(path.join(projectRootForFiles, "_omatic", "project.json"))
      ? path.join(projectRootForFiles, "_omatic", "project.json")
      : writeRoots
          .map((candidate) => path.join(candidate, "_omatic", "project.json"))
          .find((p) => fs.existsSync(p))) || null;
  const factory = readJsonIfExists(factoryFile) || {};
  const project = readJsonIfExists(projectFile) || {};
  const identity = project.identity || {};

  const factoryId = sanitizeName(
    factory.factory_id ||
      factory.factoryId ||
      project.factory_id ||
      project.factoryId ||
      (identity.factory_name ? identity.factory_name.replace(/\s+factory$/i, "") : null) ||
      "omatic"
  );

  // Platform precedence: an explicit env override wins, then live host
  // detection, then factory.json, then the historical default.
  //
  // The manifest used to hardcode OMATIC_PLATFORM=codex on every surface, so
  // Claude Code and Cowork sessions both reported themselves as Codex. A single
  // manifest cannot know which host launched it, so the value is now detected
  // from host signals at runtime instead of asserted at package time.
  // factory.json ranks below detection because one factory.json is shared
  // across surfaces and its platform_profile goes stale by design.
  // The VALUE alone is unfalsifiable: factory.json pins platform_profile to a
  // literal, so a reader cannot tell a detected surface from a string somebody
  // typed months ago. Report where it came from, the same way state_dir_source
  // qualifies state_file.
  const platformCandidates = [
    ["OMATIC_PLATFORM", resolvedOrNull(env.OMATIC_PLATFORM)],
    ["host detection", detectPlatform(env)],
    ["factory.json", factory.platform_profile || factory.platformProfile || null],
    ["default", "claude-code"],
  ];
  const [platformSource, platformProfile] = platformCandidates.find(([, v]) => v);

  return {
    factory_id: factoryId,
    server_name: factory.server_name || factory.serverName || identity.factory_name || factoryId,
    project_root: factoryFile
      ? path.dirname(path.dirname(factoryFile))
      : projectFile
        ? path.dirname(path.dirname(projectFile))
        : root,
    factory_file: factoryFile,
    project_file: projectFile,
    platform_profile: platformProfile,
    platform_profile_source: platformSource,
    connection_profile: factory.connection_profile || factory.connectionProfile || "default",
    // 5.0.0 (task #209): the plugin used to return `database_url` and the whole
    // `connections` array from factory.json, so every response that carried a
    // factory carried its credentials one redaction away. Neither is read now.
    // What IS reported is the PRESENCE of legacy credential keys — key names
    // only, never a value — because a factory.json still holding a password is
    // a credential at rest that nothing reads, and the operator should be told
    // to move it into Conductor and delete it.
    legacy_connection_fields: describeLegacyConnectionFields(factory),
    resolution: {
      roots_considered: roots,
      using_plugin_install_root: root ? isPluginInstallPath(root) : false,
      explicit_factory_json_path: explicitFactoryPath || null,
      resolved_via: report.resolved_via,
      candidates: report.candidates,
      rejected_pins: report.rejected_pins,
      persisted_selection: readSelectionState(env),
      state_file: report.state_file,
      state_dir_source: report.state_dir_source,
      state_durable: report.state_durable,
    },
  };
}

function resolveFactoryFilePath(env = process.env) {
  // An existing, resolvable factory always wins — including the operator's
  // persisted selection, which is why this goes through the shared report
  // rather than reading OMATIC_FACTORY_JSON_PATH directly.
  const report = factoryResolutionReport(env);
  if (report.factory_file) return report.factory_file;

  const pinned = resolvedOrNull(env.OMATIC_FACTORY_JSON_PATH);
  if (pinned) return path.resolve(pinned);

  // B2: never process.cwd() as a blind fallback, and never a plugin install
  // directory — resolving there just recreates the original bug under a new name.
  const writeRoot = candidateWriteRoots(env)[0];
  if (!writeRoot) throw unresolvedFactoryError(env);
  return path.join(writeRoot, ".omatic", "factory.json");
}

// Read factory.json (or a sane skeleton if it doesn't exist yet). READ ONLY —
// 5.0.0 removed writeFactoryConfig along with the connection CRUD that called
// it. This plugin never writes to factory.json.
function readFactoryConfig(env = process.env) {
  const filePath = resolveFactoryFilePath(env);
  const existing = readJsonIfExists(filePath);
  if (existing) return { filePath, config: existing, exists: true };
  return {
    filePath,
    exists: false,
    config: {
      factory_id: loadProjectContext(env).factory_id,
      platform_profile: env.OMATIC_PLATFORM || "claude-code",
      connection_profile: "default",
    },
  };
}

// Pin this session to a factory: validate the path, apply it to the real
// process environment so every later loadProjectContext() agrees, and persist
// it so the next process restores it via restoreSelection().
//
// Pre-5.0.0 this lived on ConnectionManager and ended by rebuilding a pool map
// and re-querying the database to confirm identity. There is no pool and no
// query now — selecting a factory is a filesystem and environment operation,
// which is all it ever needed to be.
function selectFactory({ factory_json_path: factoryJsonPath, project_root: projectRoot } = {}, env = process.env) {
  let selection;
  if (factoryJsonPath) {
    const resolved = path.resolve(factoryJsonPath);
    if (!fs.existsSync(resolved)) {
      throw new Error(`No factory.json at ${resolved}. Pass an existing file, or use project_root.`);
    }
    selection = { factory_json_path: resolved, project_root: null };
  } else if (projectRoot) {
    const resolved = path.resolve(projectRoot);
    const factoryFile = path.join(resolved, ".omatic", "factory.json");
    if (!fs.existsSync(factoryFile)) {
      throw new Error(
        `No .omatic/factory.json at ${resolved}. Factory discovery does not walk up the directory tree, ` +
          "so the project root itself must contain one."
      );
    }
    selection = { factory_json_path: null, project_root: resolved };
  } else {
    throw new Error("Provide factory_json_path or project_root.");
  }

  if (selection.factory_json_path) {
    env.OMATIC_FACTORY_JSON_PATH = selection.factory_json_path;
    delete env.OMATIC_PROJECT_ROOT;
  } else {
    env.OMATIC_PROJECT_ROOT = selection.project_root;
    delete env.OMATIC_FACTORY_JSON_PATH;
  }

  const persistence = writeSelectionState(
    { ...selection, host_project_dir: resolvedOrNull(env.CLAUDE_PROJECT_DIR) },
    env
  );

  return { ok: true, selection, persistence, project: loadProjectContext(env) };
}

module.exports = {
  loadProjectContext,
  resolveFactoryFilePath,
  readFactoryConfig,
  sanitizeName,
  // resolution / diagnostics
  candidateProjectRoots,
  candidateWriteRoots,
  projectRootCandidates,
  factoryResolutionReport,
  unresolvedFactoryError,
  detectPlatform,
  isPluginInstallPath,
  // persisted selection
  stateDir,
  selectionStatePath,
  readSelectionState,
  writeSelectionState,
  clearSelectionState,
  restoreSelection,
  selectFactory,
  NAME_PATTERN,
};
