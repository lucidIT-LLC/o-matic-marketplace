const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const VALID_SSL_MODES = new Set(["disable", "require", "verify-ca", "verify-full"]);
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function parseList(raw) {
  if (raw === undefined || raw === null) return [];
  const value = String(raw).trim();
  if (!value) return [];

  if (value.startsWith("[")) {
    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) return parsed.map((v) => (v === null || v === undefined ? "" : String(v)));
    } catch (_) {
      // fall through to delimiter parsing
    }
  }

  const delimiter = value.includes("\n") ? "\n" : value.includes("\x1f") ? "\x1f" : ",";
  return value
    .split(delimiter)
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

function sslConfig(mode) {
  switch (mode) {
    case "disable":
      return false;
    case "require":
      return { rejectUnauthorized: false };
    case "verify-ca":
    case "verify-full":
      return { rejectUnauthorized: true };
    default:
      return { rejectUnauthorized: false };
  }
}

function sanitizeName(value, fallback = "omatic") {
  const raw = String(value || fallback).toLowerCase();
  const name = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").replace(/-+/g, "-");
  return NAME_PATTERN.test(name) ? name : fallback;
}

function findUp(startDir, relativePath) {
  let dir = path.resolve(startDir || process.cwd());
  for (;;) {
    const candidate = path.join(dir, relativePath);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
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

function candidateProjectRoots(env = process.env) {
  const values = [
    env.OMATIC_PROJECT_ROOT,
    env.CLAUDE_PROJECT_DIR,
    env.CODEX_PROJECT_ROOT,
    env.CODEX_WORKSPACE,
    env.CODEX_WORKSPACE_ROOT,
    env.WORKSPACE_ROOT,
    env.PROJECT_ROOT,
    env.INIT_CWD,
    env.PWD,
    process.cwd(),
  ];
  const seen = new Set();
  const roots = values
    .map(resolvedOrNull)
    .filter(Boolean)
    .map((value) => path.resolve(value))
    .filter((value) => {
      if (seen.has(value)) return false;
      seen.add(value);
      return true;
    });
  const projectRoots = roots.filter((value) => !isPluginInstallPath(value));
  return projectRoots.length > 0 ? projectRoots : roots;
}

// Some plugin runtimes (Cowork .mcpb, certain Codex installs) do NOT expand
// ${VAR} patterns in manifest env blocks — the literal string is passed
// through to the child process. Detect that and treat as unset so the
// process.cwd() / no-op fallbacks fire instead of resolving to a dead path.
function resolvedOrNull(value) {
  if (value === undefined || value === null) return null;
  const str = String(value);
  if (!str) return null;
  if (/\$\{[A-Za-z_][A-Za-z0-9_.]*\}/.test(str)) return null; // unresolved variable literal
  return str;
}

function loadProjectContext(env = process.env) {
  // Defensive: unresolved ${VAR} literals (e.g. ${CLAUDE_PROJECT_DIR} on
  // Cowork where the manifest var didn't expand) are treated as unset.
  const roots = candidateProjectRoots(env);
  const root = roots[0] || process.cwd();
  // Strict resolution (project-root only). Either an explicitly pinned path
  // (OMATIC_FACTORY_JSON_PATH — used by the Cowork .mcpb extension), or
  // <projectRoot>/.omatic/factory.json at one of the candidate roots. There is
  // NO walk-up: discovery never climbs past the project into a parent or global
  // .omatic/factory.json. This is the fix for the plugin latching onto the
  // first/highest factory.json it finds ("stuck on the first database").
  const explicitFactoryPath = resolvedOrNull(env.OMATIC_FACTORY_JSON_PATH);
  const factoryFile =
    explicitFactoryPath && fs.existsSync(explicitFactoryPath)
      ? path.resolve(explicitFactoryPath)
      : roots
          .map((candidate) => path.join(candidate, ".omatic", "factory.json"))
          .find((p) => fs.existsSync(p)) || null;
  const projectRootForFiles = factoryFile ? path.dirname(path.dirname(factoryFile)) : null;
  const projectFile =
    (projectRootForFiles && fs.existsSync(path.join(projectRootForFiles, "_omatic", "project.json"))
      ? path.join(projectRootForFiles, "_omatic", "project.json")
      : roots
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

  // Platform precedence: env wins over factory.json. The env var is set per-
  // surface by the plugin manifest (claude-code / codex / cowork). The
  // factory.json value is a default and may go stale when the same file is
  // shared across surfaces — env is the runtime truth.
  const platformProfile =
    resolvedOrNull(env.OMATIC_PLATFORM) ||
    factory.platform_profile ||
    factory.platformProfile ||
    "claude-code";

  return {
    factory_id: factoryId,
    server_name: factory.server_name || factory.serverName || identity.factory_name || factoryId,
    project_root: factoryFile ? path.dirname(path.dirname(factoryFile)) : projectFile ? path.dirname(path.dirname(projectFile)) : root,
    factory_file: factoryFile,
    project_file: projectFile,
    platform_profile: platformProfile,
    connection_profile: factory.connection_profile || factory.connectionProfile || "default",
    database_url: factory.database_url || factory.databaseUrl || null,
    connections: Array.isArray(factory.connections) ? factory.connections : null,
    resolution: {
      roots_considered: roots,
      using_plugin_install_root: isPluginInstallPath(root),
      explicit_factory_json_path: explicitFactoryPath || null,
    },
  };
}

function parseDatabaseUrl(raw, name) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return null;
  }
  if (!url.protocol.startsWith("postgres")) return null;
  const explicitSslMode = url.searchParams.get("sslmode");
  const inferredSslMode = url.hostname.startsWith("100.") ? "disable" : "require";
  return {
    name: sanitizeName(name),
    host: url.hostname,
    port: Number.parseInt(url.port || "5432", 10),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username || ""),
    password: decodeURIComponent(url.password || ""),
    sslMode: (explicitSslMode || inferredSslMode).toLowerCase(),
  };
}

// Parse one entry from a .omatic/factory.json "connections" array.
// Accepts either a DSN string or an object: { name, database_url } or
// { name, host, port, database, user, password, ssl_mode }.
function parseConnectionEntry(entry, fallbackName) {
  if (!entry) return null;

  if (typeof entry === "string") {
    return parseDatabaseUrl(entry, fallbackName);
  }

  const name = entry.name || entry.factory_id || entry.factoryId || fallbackName;
  const url = entry.database_url || entry.databaseUrl;
  if (url) return { ...parseDatabaseUrl(url, name), name: sanitizeName(name) };

  if (entry.host && entry.database && entry.user) {
    const sslMode = (entry.ssl_mode || entry.sslMode || (String(entry.host).startsWith("100.") ? "disable" : "require")).toLowerCase();
    if (!VALID_SSL_MODES.has(sslMode)) {
      throw new Error(`Connection "${name}": invalid ssl_mode "${sslMode}". Allowed: ${[...VALID_SSL_MODES].join(", ")}.`);
    }
    return {
      name: sanitizeName(name),
      host: String(entry.host),
      port: Number.parseInt(entry.port || 5432, 10),
      database: String(entry.database),
      user: String(entry.user),
      password: String(entry.password || ""),
      sslMode,
    };
  }

  return null;
}

function loadConnections(env = process.env) {
  const project = loadProjectContext(env);

  // 1. Explicit env override — single connection (CI / one-off).
  if (env.OMATIC_DATABASE_URL) {
    const c = parseDatabaseUrl(env.OMATIC_DATABASE_URL, project.factory_id);
    if (c) return [c];
  }

  // 2. Multi-connection list from .omatic/factory.json "connections": [ ... ].
  if (Array.isArray(project.connections) && project.connections.length > 0) {
    const conns = [];
    const seen = new Set();
    for (const entry of project.connections) {
      const parsed = parseConnectionEntry(entry, project.factory_id);
      if (!parsed || !parsed.name) continue;
      if (!NAME_PATTERN.test(parsed.name)) {
        throw new Error(`Invalid connection name "${parsed.name}" in .omatic/factory.json. Use lowercase letters, numbers, and hyphens only.`);
      }
      if (seen.has(parsed.name)) {
        throw new Error(`Duplicate connection name "${parsed.name}" in .omatic/factory.json connections.`);
      }
      seen.add(parsed.name);
      conns.push(parsed);
    }
    if (conns.length > 0) return conns;
  }

  // 3. Single database_url from .omatic/factory.json.
  const directConnection = parseDatabaseUrl(project.database_url, project.factory_id);
  if (directConnection) return [directConnection];

  // 4. Legacy multi-list env vars (Desktop-Extension-style installs).
  const names = parseList(env.OMATIC_CONNECTION_NAMES);
  const hosts = parseList(env.OMATIC_CONNECTION_HOSTS);
  const ports = parseList(env.OMATIC_CONNECTION_PORTS);
  const databases = parseList(env.OMATIC_CONNECTION_DATABASES);
  const usernames = parseList(env.OMATIC_CONNECTION_USERNAMES);
  const passwords = parseList(env.OMATIC_CONNECTION_PASSWORDS);
  const sslModes = parseList(env.OMATIC_CONNECTION_SSL_MODES);

  if (names.length === 0) return [];

  const count = names.length;
  const lengths = { hosts, ports, databases, usernames, passwords };
  for (const [key, arr] of Object.entries(lengths)) {
    if (arr.length !== count) {
      throw new Error(
        `Configuration mismatch: ${count} connection name(s) but ${arr.length} ${key}. Each connection field list must have the same length.`
      );
    }
  }

  const connections = [];
  const seen = new Set();

  for (let i = 0; i < count; i++) {
    const name = names[i];
    if (!NAME_PATTERN.test(name)) {
      throw new Error(
        `Invalid connection name "${name}". Use lowercase letters, numbers, and hyphens only; must start with a letter or number.`
      );
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate connection name "${name}". Connection names must be unique.`);
    }
    seen.add(name);

    const portNum = Number.parseInt(ports[i], 10);
    if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
      throw new Error(`Connection "${name}": invalid port "${ports[i]}". Must be an integer between 1 and 65535.`);
    }

    const sslMode = (sslModes[i] || "require").toLowerCase();
    if (!VALID_SSL_MODES.has(sslMode)) {
      throw new Error(
        `Connection "${name}": invalid ssl_mode "${sslMode}". Allowed: disable, require, verify-ca, verify-full.`
      );
    }

    connections.push({
      name,
      host: hosts[i],
      port: portNum,
      database: databases[i],
      user: usernames[i],
      password: passwords[i],
      sslMode,
    });
  }

  return connections;
}

// ── Factory config management (used by the omatic_*_connection setup tools) ──

// Where .omatic/factory.json lives — the existing file if found by walk-up,
// otherwise the path where it should be created (project root / .omatic).
// OMATIC_FACTORY_JSON_PATH (Cowork .mcpb user_config) wins when set, even if
// the file doesn't exist yet — it becomes the create target on first write.
function resolveFactoryFilePath(env = process.env) {
  const explicitPath = resolvedOrNull(env.OMATIC_FACTORY_JSON_PATH);
  if (explicitPath) return path.resolve(explicitPath);
  const roots = candidateProjectRoots(env);
  const root = roots[0] || process.cwd();
  // Strict: only a project-root .omatic/factory.json counts — no walk-up. A new
  // connection is always written at the project root, never into a parent.
  const existing = roots
    .map((candidate) => path.join(candidate, ".omatic", "factory.json"))
    .find((p) => fs.existsSync(p));
  if (existing) return existing;
  return path.join(root, ".omatic", "factory.json");
}

// Read factory.json (or a sane skeleton if it doesn't exist yet).
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

// Normalize whatever form factory.json holds (single database_url OR
// connections[] array) into a clean list of connection objects.
function normalizeFactoryConnections(config, fallbackName = "omatic") {
  const list = [];
  if (Array.isArray(config.connections)) {
    for (const entry of config.connections) {
      const parsed = parseConnectionEntry(entry, fallbackName);
      if (parsed && parsed.name && parsed.host) list.push(parsed);
    }
  } else if (config.database_url || config.databaseUrl) {
    const parsed = parseDatabaseUrl(config.database_url || config.databaseUrl, config.factory_id || fallbackName);
    if (parsed) list.push(parsed);
  }
  return list;
}

// Serialize a connection object for storage in factory.json connections[].
function serializeConnection(c) {
  return {
    name: c.name,
    host: c.host,
    port: c.port,
    database: c.database,
    user: c.user,
    password: c.password,
    ssl_mode: c.sslMode,
  };
}

// Write factory.json with the given connection list. Always uses the
// connections[] array form (uniform, no DSN-encoding fragility).
// Atomic: writes to a temp file, then renames into place. Prevents lost
// updates from concurrent writers (two worktrees, two surfaces).
function writeFactoryConfig(filePath, config, connList) {
  const out = { ...config };
  delete out.database_url;
  delete out.databaseUrl;
  out.connections = connList.map(serializeConnection);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, JSON.stringify(out, null, 2) + "\n", "utf8");
  fs.renameSync(tmpPath, filePath); // atomic on POSIX, near-atomic on Windows
  return filePath;
}

// Upgrade migration: if the resolved project root has no .omatic/factory.json
// AND env.OMATIC_DATABASE_URL is set (the legacy hardcoded fallback), write a
// factory.json there from the env DSN so subsequent runs use file-based config.
// Refuses to write if the resolved root looks like a plugin install dir — that
// would just recreate the original bug under a different filename.
function ensureFactoryJsonFromEnv(env = process.env) {
  const dsn = env.OMATIC_DATABASE_URL;
  if (!dsn) return { migrated: false, reason: "no OMATIC_DATABASE_URL set" };

  // Cowork extension may pin the factory.json location explicitly — write
  // there if set. Otherwise walk-up from OMATIC_PROJECT_ROOT or CWD.
  // Defensive: unresolved ${...} literals are treated as unset.
  const explicitPathRaw = resolvedOrNull(env.OMATIC_FACTORY_JSON_PATH);
  const explicitPath = explicitPathRaw ? path.resolve(explicitPathRaw) : null;
  if (explicitPath && fs.existsSync(explicitPath)) {
    return { migrated: false, reason: `factory.json already present at ${explicitPath}` };
  }

  const projectRoot = resolvedOrNull(env.OMATIC_PROJECT_ROOT);
  const root = path.resolve(projectRoot || process.cwd());
  if (!explicitPath) {
    const rootStr = root.replace(/\\/g, "/");
    if (
      rootStr.includes("/plugins/omatic-server") ||
      rootStr.includes("/omatic-server-connection") ||
      rootStr.includes(".mcpb") ||
      rootStr.includes("/Claude Extensions/")
    ) {
      return { migrated: false, reason: `refusing to write factory.json into plugin install dir: ${root}` };
    }
    // Strict: only a project-root factory.json blocks the migration — no walk-up.
    const rootFactory = path.join(root, ".omatic", "factory.json");
    if (fs.existsSync(rootFactory)) return { migrated: false, reason: `factory.json already present at ${rootFactory}` };
  }

  const parsed = parseDatabaseUrl(dsn, "omatic");
  if (!parsed) return { migrated: false, reason: "OMATIC_DATABASE_URL did not parse as postgresql:// DSN" };

  const config = {
    factory_id: parsed.name,
    platform_profile: env.OMATIC_PLATFORM || "claude-code",
    connection_profile: "default",
    notes: "Auto-migrated from OMATIC_DATABASE_URL on plugin upgrade. Safe to edit.",
  };
  const targetPath = explicitPath || path.join(root, ".omatic", "factory.json");
  try {
    writeFactoryConfig(targetPath, config, [parsed]);
    process.stderr.write(
      `[omatic-server-connection] migrated hardcoded OMATIC_DATABASE_URL to ${targetPath}\n`
    );
    return { migrated: true, path: targetPath };
  } catch (err) {
    process.stderr.write(
      `[omatic-server-connection] migration failed: ${err && err.message ? err.message : String(err)}\n`
    );
    return { migrated: false, reason: err && err.message ? err.message : String(err) };
  }
}

// Is .omatic/factory.json gitignored anywhere up the tree? Used to warn the
// operator if credentials would be exposed to version control.
function isFactoryFileGitignored(filePath) {
  let dir = path.dirname(path.dirname(filePath)); // project root (parent of .omatic/)
  for (;;) {
    const gi = path.join(dir, ".gitignore");
    if (fs.existsSync(gi)) {
      const text = fs.readFileSync(gi, "utf8");
      if (/^\s*\.omatic\/factory\.json\s*$/m.test(text) || /^\s*\.omatic\/?\s*$/m.test(text)) return true;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

// Open a one-off connection and probe it. Returns { ok, info?, error? }.
async function testConnection(connEntry) {
  const pool = new Pool({
    host: connEntry.host,
    port: connEntry.port,
    database: connEntry.database,
    user: connEntry.user,
    password: connEntry.password,
    ssl: sslConfig(connEntry.sslMode),
    max: 1,
    connectionTimeoutMillis: 10_000,
  });
  try {
    const client = await pool.connect();
    try {
      const r = await client.query("SELECT current_database() AS database, current_user AS \"user\"");
      return { ok: true, info: r.rows[0] };
    } finally {
      client.release();
    }
  } catch (err) {
    return { ok: false, error: err && err.message ? err.message : String(err) };
  } finally {
    await pool.end().catch(() => {});
  }
}

class ConnectionManager {
  constructor(configs, projectContext = loadProjectContext(), runtimeEnv = process.env) {
    this.configs = new Map();
    this.pools = new Map();
    this.projectContext = projectContext;
    this.runtimeEnv = runtimeEnv;
    this.activeName = null; // operator-set override via omatic_set_active_connection
    for (const cfg of configs) this.configs.set(cfg.name, cfg);
  }

  project() {
    return this.projectContext;
  }

  names() {
    return [...this.configs.keys()];
  }

  // Operator-set active connection wins. Falls back to factory_id match,
  // then first configured connection. Throws if the name is unknown.
  setActive(name) {
    if (!this.configs.has(name)) {
      throw new Error(`Connection ${name} not configured. Available: ${this.names().join(", ") || "(none)"}.`);
    }
    this.activeName = name;
    return name;
  }

  clearActive() {
    this.activeName = null;
  }

  defaultName() {
    if (this.activeName && this.configs.has(this.activeName)) return this.activeName;
    if (this.configs.has(this.projectContext.factory_id)) return this.projectContext.factory_id;
    return this.names()[0] || null;
  }

  has(name) {
    return this.configs.has(name);
  }

  getConfig(name) {
    return this.configs.get(name);
  }

  env() {
    return this.runtimeEnv || process.env;
  }

  getPool(name) {
    if (this.pools.has(name)) return this.pools.get(name);
    const cfg = this.configs.get(name);
    if (!cfg) return null;

    const pool = new Pool({
      host: cfg.host,
      port: cfg.port,
      database: cfg.database,
      user: cfg.user,
      password: cfg.password,
      ssl: sslConfig(cfg.sslMode),
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });

    pool.on("error", (err) => {
      process.stderr.write(`[${cfg.name}] idle client error: ${err.message}\n`);
    });

    this.pools.set(name, pool);
    return pool;
  }

  async execute(name, sql) {
    return this.query(name, sql, []);
  }

  async query(name, sql, params = []) {
    const pool = this.getPool(name);
    if (!pool) throw new Error(`Connection ${name} not configured`);
    const client = await pool.connect();
    try {
      const result = await client.query(sql, params);
      const rows = Array.isArray(result) ? result[result.length - 1].rows : result.rows;
      return { rows: rows || [], count: rows ? rows.length : 0 };
    } finally {
      client.release();
    }
  }

  async test(name) {
    const pool = this.getPool(name);
    if (!pool) throw new Error(`Connection ${name} not configured`);
    const client = await pool.connect();
    try {
      await client.query("SELECT 1");
    } finally {
      client.release();
    }
  }

  async shutdown() {
    const endAll = [...this.pools.values()].map((p) => p.end().catch(() => {}));
    this.pools.clear();
    await Promise.all(endAll);
  }

  // Reload connections from .omatic/factory.json + env. Called by CRUD
  // handlers after writeFactoryConfig so the running session picks up the new
  // connection list without restart. Pools for removed connections are
  // shut down; pools for unchanged connections survive. New connections get
  // pools on first use.
  async reload(env = process.env) {
    let nextConfigs;
    try {
      nextConfigs = loadConnections(env);
    } catch (err) {
      return { ok: false, error: err && err.message ? err.message : String(err) };
    }

    const nextNames = new Set(nextConfigs.map((c) => c.name));
    const prevNames = new Set(this.configs.keys());

    // Shut down pools for removed or replaced connections.
    const removedOrChanged = [];
    for (const [name, oldPool] of this.pools.entries()) {
      const next = nextConfigs.find((c) => c.name === name);
      const old = this.configs.get(name);
      const replaced =
        !next ||
        !old ||
        next.host !== old.host ||
        next.port !== old.port ||
        next.database !== old.database ||
        next.user !== old.user ||
        next.password !== old.password ||
        next.sslMode !== old.sslMode;
      if (replaced) {
        removedOrChanged.push(oldPool.end().catch(() => {}));
        this.pools.delete(name);
      }
    }
    await Promise.all(removedOrChanged);

    // Rewrite configs map. Refresh projectContext so factory_id /
    // platform_profile reflect any factory.json edits.
    this.configs = new Map();
    for (const cfg of nextConfigs) this.configs.set(cfg.name, cfg);
    this.projectContext = loadProjectContext(env);
    this.runtimeEnv = env;

    // If the active connection was removed, clear it.
    if (this.activeName && !this.configs.has(this.activeName)) {
      this.activeName = null;
    }

    const added = [...nextNames].filter((n) => !prevNames.has(n));
    const removed = [...prevNames].filter((n) => !nextNames.has(n));
    return { ok: true, total: this.configs.size, added, removed };
  }

  async selectFactory({ factory_json_path: factoryJsonPath, project_root: projectRoot } = {}) {
    const nextEnv = { ...process.env };
    if (factoryJsonPath) {
      nextEnv.OMATIC_FACTORY_JSON_PATH = path.resolve(factoryJsonPath);
      delete nextEnv.OMATIC_PROJECT_ROOT;
    } else if (projectRoot) {
      nextEnv.OMATIC_PROJECT_ROOT = path.resolve(projectRoot);
      delete nextEnv.OMATIC_FACTORY_JSON_PATH;
    } else {
      throw new Error("Provide factory_json_path or project_root.");
    }
    this.activeName = null;
    return this.reload(nextEnv);
  }
}

module.exports = {
  ConnectionManager,
  loadConnections,
  loadProjectContext,
  parseList,
  parseDatabaseUrl,
  parseConnectionEntry,
  resolveFactoryFilePath,
  readFactoryConfig,
  normalizeFactoryConnections,
  writeFactoryConfig,
  ensureFactoryJsonFromEnv,
  isFactoryFileGitignored,
  testConnection,
  sanitizeName,
  NAME_PATTERN,
  VALID_SSL_MODES,
};
