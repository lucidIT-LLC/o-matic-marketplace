const fs = require("fs");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");

// libpq's six sslmode values. node-postgres does NOT implement libpq semantics
// on its own (see sslAttemptsFor below), so this module maps each mode to an
// explicit TLS option object plus a negotiation plan.
const VALID_SSL_MODES = new Set(["disable", "allow", "prefer", "require", "verify-ca", "verify-full"]);

// The default when sslmode is absent. This is DELIBERATELY NOT libpq's default.
//
// libpq defaults to `prefer`, which tries TLS and silently falls back to
// plaintext. A connection that cannot say which one it used cannot be attested
// to in an audit, and a silent downgrade is the same class of defect as the
// unfalsifiable success this connector was rebuilt to remove (decision #226):
// it reports a working connection while quietly delivering less than asked.
//
// `verify-full` is the O-Matic Blueprint requirement (KB-0051 v1.9.0 §9). It is
// also now free: factory databases sit behind a Tailscale service carrying a
// publicly-trusted certificate, so the chain validates against the roots every
// client already has — no private CA, no root distribution, no pinning.
//
// This fails CLOSED. A connection entry with no ssl_mode against a server with
// no TLS will now fail instead of silently running plaintext. That is the
// intended behavior: state the mode explicitly if you mean something weaker.
const DEFAULT_SSL_MODE = "verify-full";

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// ── Per-connection permission (section C, C6) ────────────────────────────────
//
// Some connections reach client data; some connect with elevated rights. Before
// this, any tool could write to either and the only thing preventing it was the
// model choosing not to — a rule loaded, not a rule obeyed (#321). The mode is
// stored in .omatic/factory.json beside host/user/ssl_mode and is enforced, not
// advertised.
//
//   read_write   everything works. The default, so nothing existing changes.
//   read_only    reads work; every write, DDL and DML is refused before it
//                reaches the database, and the pool additionally runs with
//                default_transaction_read_only=on so the server refuses too.
//   disabled     the connection resolves and is listed, but no tool will use
//                it. Visible, deliberately parked.
const VALID_PERMISSIONS = new Set(["read_write", "read_only", "disabled"]);
const DEFAULT_PERMISSION = "read_write";

function normalizePermission(mode, fallback = DEFAULT_PERMISSION) {
  const value = String(mode === undefined || mode === null ? "" : mode).trim().toLowerCase().replace(/-/g, "_");
  if (!value) return fallback;
  return value;
}

function assertValidPermission(mode, label) {
  if (!VALID_PERMISSIONS.has(mode)) {
    throw new Error(
      `${label}: invalid permission "${mode}". Allowed: ${[...VALID_PERMISSIONS].join(", ")}.`
    );
  }
  return mode;
}

function errMessage(err) {
  return err && err.message ? err.message : String(err);
}

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

// ── TLS / sslmode ────────────────────────────────────────────────────────────
//
// D7/D8. node-postgres 8.20.0 does not implement libpq sslmode semantics. When
// a DSN is parsed without `uselibpqcompat`, `prefer`, `require` and `verify-ca`
// all collapse into `verify-full`, `allow` is unhandled, and there is no
// plaintext fallback at all: when the server answers the SSLRequest with the
// byte 'N', pg throws "The server does not support SSL connections"
// (pg/lib/connection.js). This plugin never hands pg a connection string — it
// builds the client config itself — so the correct fix is to map each mode to
// a real TLS option object here and to drive the fallback ourselves.
//
//   disable      plaintext only
//   allow        plaintext first, TLS only if the server refuses plaintext
//   prefer       TLS first, plaintext if the server does not offer TLS; no verification
//   require      TLS mandatory, no certificate verification
//   verify-ca    TLS mandatory, verify the chain, do not check the hostname
//   verify-full  TLS mandatory, verify the chain and the hostname
//
// Modes are transport policy only. This module never infers a mode from a host,
// an address, or any other network-topology signal.

function normalizeSslMode(mode, fallback = DEFAULT_SSL_MODE) {
  const value = String(mode || "").trim().toLowerCase();
  if (!value) return fallback;
  return value;
}

function assertValidSslMode(mode, label) {
  if (!VALID_SSL_MODES.has(mode)) {
    throw new Error(
      `${label}: invalid ssl_mode "${mode}". Allowed: ${[...VALID_SSL_MODES].join(", ")}.`
    );
  }
  return mode;
}

// Optional CA bundle for verify-ca / verify-full. Read from an `ssl_root_cert`
// path on the connection entry; absent means "use Node's trust store".
function readCaBundle(sslRootCert) {
  if (!sslRootCert) return null;
  const resolved = path.resolve(String(sslRootCert));
  try {
    return fs.readFileSync(resolved, "utf8");
  } catch (err) {
    throw new Error(`Cannot read ssl_root_cert "${resolved}": ${errMessage(err)}`);
  }
}

// TLS options for one *encrypted* attempt. Never returns false — callers decide
// whether an encrypted attempt happens at all.
function sslOptionsForMode(mode, ca = null) {
  const base = ca ? { ca } : {};
  switch (mode) {
    case "verify-full":
      // Node verifies the chain and the hostname by default.
      return { ...base, rejectUnauthorized: true };
    case "verify-ca":
      // Chain yes, hostname no — libpq's verify-ca.
      return { ...base, rejectUnauthorized: true, checkServerIdentity: () => undefined };
    default:
      // allow / prefer / require: encrypt, do not verify.
      return { ...base, rejectUnauthorized: false };
  }
}

// Turn a raw connect failure into an actionable message. 3.4.0 flipped the
// default ssl_mode to verify-full (fails closed), so the most common new failure
// is a connection with no ssl_mode set, hitting a server whose certificate does
// not verify — and the raw Node error ("unable to verify the first certificate",
// "Hostname/IP does not match certificate's altnames") never mentions ssl_mode
// or how to fix it. This names the configured mode, whether it was defaulted,
// and the concrete fixes. Non-TLS failures (bad host, refused, auth) pass
// through untouched.
function annotateConnectError(cfg, mode, err) {
  const raw = errMessage(err);
  const verifying = mode === "verify-full" || mode === "verify-ca";
  const looksTls = /ssl|tls|certificate|self.signed|altname|handshake|verify|ERR_TLS/i.test(raw);
  if (!verifying && !looksTls) return raw;

  let msg = `Connection "${cfg.name}" failed with ssl_mode="${mode}"`;
  if (cfg.sslModeDefaulted) msg += ` (defaulted — no ssl_mode set on this connection)`;
  msg += `: ${raw}.`;
  if (verifying) {
    msg +=
      ` ssl_mode="${mode}" requires TLS and verification of the server's certificate` +
      `${mode === "verify-full" ? " chain and hostname" : " chain"}. Fix one of:` +
      ` (a) set an explicit ssl_mode in .omatic/factory.json — "require" encrypts` +
      ` without verifying, "disable" is plaintext; (b) set ssl_root_cert to the` +
      ` server's CA bundle; or (c) present a certificate that matches the host.`;
  }
  return msg;
}

// The ordered negotiation plan for a mode. Each attempt is { kind, ssl }.
function sslAttemptsFor(mode, ca = null) {
  const plaintext = { kind: "plaintext", ssl: false };
  const encrypted = { kind: "encrypted", ssl: sslOptionsForMode(mode, ca) };
  switch (mode) {
    case "disable":
      return [plaintext];
    case "allow":
      return [plaintext, encrypted];
    case "prefer":
      return [encrypted, plaintext];
    default:
      return [encrypted];
  }
}

// Back-compat shim: the TLS options for the first attempt of a mode.
function sslConfig(mode) {
  const normalized = normalizeSslMode(mode);
  return sslAttemptsFor(normalized)[0].ssl;
}

// pg's two SSLRequest rejection paths (pg/lib/connection.js): the server
// answered 'N', or answered something unusable. Either means "no TLS here".
const SSL_UNAVAILABLE = /server does not support SSL connections|error establishing an SSL connection/i;
// Server refused the plaintext attempt because it mandates TLS.
const SSL_MANDATORY = /no pg_hba\.conf entry|SSL (?:connection )?(?:is )?required|server requires SSL/i;

// Only fall back when the *negotiation* was refused. Authentication failures,
// unknown databases and timeouts must surface as themselves.
function canFallBack(mode, attemptKind, err) {
  const message = errMessage(err);
  const code = err && err.code ? String(err.code) : "";
  if (mode === "prefer" && attemptKind === "encrypted") {
    if (SSL_UNAVAILABLE.test(message)) return true;
    // A server that hangs up on the SSLRequest instead of answering.
    return code === "ECONNRESET" || code === "EPROTO";
  }
  if (mode === "allow" && attemptKind === "plaintext") {
    return SSL_MANDATORY.test(message) || code === "28000";
  }
  return false;
}

// D9. Report what was actually negotiated, not what was configured. On an
// encrypted connection pg's socket is a real TLSSocket; on a plaintext one it
// is a bare net.Socket with none of these methods.
function describeTls(client) {
  const stream = client && client.connection ? client.connection.stream : null;
  const protocol =
    stream && typeof stream.getProtocol === "function" ? stream.getProtocol() : null;
  if (!protocol) {
    return { encrypted: false, protocol: null, cipher: null, authorized: null, authorization_error: null };
  }
  const cipher = typeof stream.getCipher === "function" ? stream.getCipher() : null;
  return {
    encrypted: true,
    protocol,
    cipher: cipher ? { name: cipher.name, standard_name: cipher.standardName || null, version: cipher.version } : null,
    authorized: typeof stream.authorized === "boolean" ? stream.authorized : null,
    authorization_error: stream.authorizationError ? String(stream.authorizationError) : null,
  };
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
    // C4. Pinning a factory is only the first half of the recovery. An operator
    // who has no factory yet, or whose factory.json holds a connection that has
    // never actually connected, needs the connection surface named here — the
    // error is the one place they are guaranteed to be looking.
    "Once a factory is pinned, the connection surface is:",
    "  omatic_list_connections()                       — every configured connection with live reachability and negotiated TLS",
    "  omatic_test_connection(host=..., database=..., user=..., password=..., ssl_mode=...)",
    "                                                  — try a host and password without saving anything",
    "  omatic_add_connection(name=..., host=..., ...)  — test-connects first; a failed probe writes nothing",
    "  omatic_edit_connection(name=..., password=...)  — fix one field on an existing connection, re-tested before it is saved",
    "  omatic_remove_connection(name=...)              — drop a connection",
    "",
    "If there is no factory.json at all yet, omatic_add_connection creates one — it writes the first",
    "connection into a new .omatic/factory.json at the highest-ranked candidate root above."
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
    database_url: factory.database_url || factory.databaseUrl || null,
    connections: Array.isArray(factory.connections) ? factory.connections : null,
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

function parseDatabaseUrl(raw, name) {
  if (!raw) return null;
  let url;
  try {
    url = new URL(raw);
  } catch (_) {
    return null;
  }
  if (!url.protocol.startsWith("postgres")) return null;
  // D5/D6. The sslmode is whatever the DSN says, or the libpq default. It is
  // never guessed from the host: the previous heuristic silently downgraded to
  // plaintext for any host beginning "100.", which is not even a correct test
  // for the range it was reaching for, and which encoded network topology in
  // security defaults.
  const sslMode = assertValidSslMode(
    normalizeSslMode(url.searchParams.get("sslmode")),
    `Connection "${sanitizeName(name)}"`
  );
  const sslRootCert = url.searchParams.get("sslrootcert") || null;
  return {
    name: sanitizeName(name),
    host: url.hostname,
    port: Number.parseInt(url.port || "5432", 10),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    user: decodeURIComponent(url.username || ""),
    password: decodeURIComponent(url.password || ""),
    sslMode,
    ...(sslRootCert ? { sslRootCert } : {}),
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
    // D5/D6. No host-derived inference. An absent ssl_mode falls back to
    // DEFAULT_SSL_MODE (verify-full) and FAILS CLOSED: a server without a
    // verifiable certificate is refused, not silently downgraded to plaintext.
    // Track whether the mode was defaulted so a connect failure can tell the
    // operator the refusal came from an unset ssl_mode, not a choice they made.
    const sslModeRaw = entry.ssl_mode || entry.sslMode;
    const sslModeDefaulted = !sslModeRaw;
    const sslMode = assertValidSslMode(
      normalizeSslMode(sslModeRaw),
      `Connection "${name}"`
    );
    const sslRootCert = entry.ssl_root_cert || entry.sslRootCert || null;
    // C6. Absent means read_write — every factory.json written before this
    // release keeps working exactly as it did.
    const permission = assertValidPermission(
      normalizePermission(entry.permission || entry.permissions),
      `Connection "${name}"`
    );
    return {
      name: sanitizeName(name),
      host: String(entry.host),
      port: Number.parseInt(entry.port || 5432, 10),
      database: String(entry.database),
      user: String(entry.user),
      password: String(entry.password || ""),
      sslMode,
      sslModeDefaulted,
      permission,
      ...(sslRootCert ? { sslRootCert: String(sslRootCert) } : {}),
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

    const sslMode = assertValidSslMode(normalizeSslMode(sslModes[i]), `Connection "${name}"`);

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
  // An existing, resolvable factory always wins — including the operator's
  // persisted selection, which is why this goes through the shared report
  // rather than reading OMATIC_FACTORY_JSON_PATH directly.
  const report = factoryResolutionReport(env);
  if (report.factory_file) return report.factory_file;

  // Nothing exists yet. Fall back to a pinned create target if one was given.
  const pinned = resolvedOrNull(env.OMATIC_FACTORY_JSON_PATH);
  if (pinned) return path.resolve(pinned);

  // Otherwise create at the highest-ranked real project directory. B2: never
  // process.cwd() as a blind fallback, and never a plugin install directory —
  // writing there just recreates the original bug under a new filename.
  const writeRoot = candidateWriteRoots(env)[0];
  if (!writeRoot) throw unresolvedFactoryError(env);
  return path.join(writeRoot, ".omatic", "factory.json");
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
    // C6. Always written, including the default, so the file states the access
    // policy explicitly rather than leaving it implied by absence.
    permission: c.permission || DEFAULT_PERMISSION,
    ...(c.sslRootCert ? { ssl_root_cert: c.sslRootCert } : {}),
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

// J2. ensureFactoryJsonFromEnv() lived here and ran on every boot from
// index.js, migrating installs off the legacy hardcoded OMATIC_DATABASE_URL by
// writing a factory.json. It has been removed:
//
//   - No shipped manifest sets OMATIC_DATABASE_URL (.mcp.json,
//     .claude-plugin/plugin.json, .codex-plugin/plugin.json all bind only
//     OMATIC_PROJECT_ROOT / OMATIC_FACTORY_JSON_PATH / OMATIC_PLATFORM).
//   - Every observed .omatic/factory.json uses the connections[] array form;
//     none carries a database_url.
//   - It carried its own process.cwd() dependency and its own write-into-a-
//     plugin-directory hazard, i.e. exactly the class of bug this file is
//     being repaired for.
//
// Anyone still setting OMATIC_DATABASE_URL keeps working: loadConnections()
// honours it directly as a single-connection override. It simply no longer
// causes an unsolicited file write at boot.

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

function poolOptionsFor(cfg, ssl, extra = {}) {
  const permission = normalizePermission(cfg.permission);
  return {
    host: cfg.host,
    port: cfg.port,
    database: cfg.database,
    user: cfg.user,
    password: cfg.password,
    ssl,
    connectionTimeoutMillis: 10_000,
    // C6, second layer. The tool-layer chokepoint is the enforcement point and
    // refuses writes with a clear message; this makes the server refuse them
    // too. Statement classification is string work and string work has edge
    // cases, so the guarantee should not rest on it alone — if a write ever
    // slips past the classifier, PostgreSQL rejects it with
    // "cannot execute INSERT in a read-only transaction". Belt and braces on a
    // client database is the right amount of paranoia.
    ...(permission === "read_only" ? { options: "-c default_transaction_read_only=on" } : {}),
    ...extra,
  };
}

// Walk a mode's negotiation plan until one attempt connects. `onConnected` runs
// with the live client of the winning attempt; its return value is passed back.
// Returns { ok, ssl, value?, error?, attempts }.
async function negotiate(cfg, poolExtra, onConnected) {
  const mode = assertValidSslMode(normalizeSslMode(cfg.sslMode), `Connection "${cfg.name}"`);
  const ca = readCaBundle(cfg.sslRootCert);
  const plan = sslAttemptsFor(mode, ca);
  const attempts = [];
  let lastError = null;

  for (let i = 0; i < plan.length; i++) {
    const attempt = plan[i];
    const pool = new Pool(poolOptionsFor(cfg, attempt.ssl, poolExtra));
    pool.on("error", (err) => {
      process.stderr.write(`[${cfg.name}] idle client error: ${errMessage(err)}\n`);
    });

    let client;
    try {
      client = await pool.connect();
    } catch (err) {
      await pool.end().catch(() => {});
      lastError = err;
      const retryable = i < plan.length - 1 && canFallBack(mode, attempt.kind, err);
      attempts.push({ kind: attempt.kind, ok: false, error: errMessage(err), fell_back: retryable });
      if (retryable) continue;
      return {
        ok: false,
        error: annotateConnectError(cfg, mode, err),
        attempts,
        ssl: { configured: mode, negotiated: null, encrypted: null },
      };
    }

    const tls = describeTls(client);
    attempts.push({ kind: attempt.kind, ok: true });
    const ssl = {
      configured: mode,
      negotiated: tls.encrypted ? "encrypted" : "plaintext",
      fell_back: attempts.length > 1,
      ...tls,
    };

    try {
      const value = onConnected ? await onConnected(client, pool, ssl) : undefined;
      return { ok: true, value, pool, ssl, attempts };
    } catch (err) {
      client.release();
      await pool.end().catch(() => {});
      return { ok: false, error: errMessage(err), attempts, ssl };
    }
  }

  return {
    ok: false,
    error: lastError
      ? annotateConnectError(cfg, mode, lastError)
      : "no connection attempt was made",
    attempts,
    ssl: { configured: mode, negotiated: null, encrypted: null },
  };
}

// Open a one-off connection and probe it. Returns { ok, info?, ssl?, error? }.
// D9: `ssl` reports what was actually negotiated alongside what was configured.
async function testConnection(connEntry) {
  let result;
  try {
    result = await negotiate(connEntry, { max: 1 }, async (client) => {
      const r = await client.query('SELECT current_database() AS database, current_user AS "user"');
      client.release();
      return r.rows[0];
    });
  } catch (err) {
    return { ok: false, error: errMessage(err) };
  }
  if (result.pool) await result.pool.end().catch(() => {});
  if (!result.ok) return { ok: false, error: result.error, ssl: result.ssl, attempts: result.attempts };
  return { ok: true, info: result.value, ssl: result.ssl, attempts: result.attempts };
}

class ConnectionManager {
  constructor(configs, projectContext = loadProjectContext(), runtimeEnv = process.env) {
    this.configs = new Map();
    this.pools = new Map();
    this.pending = new Map(); // name -> in-flight pool creation
    this.tls = new Map(); // name -> negotiated TLS description (D9)
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

  // B4. With zero configured connections the caller used to receive
  // "No O-Matic Server connection is configured for this project", which names
  // the wrong problem — the factory was never resolved, so there was nothing to
  // configure. This is the single chokepoint every caller passes through, so
  // the real diagnosis is raised here instead.
  defaultName() {
    if (this.configs.size === 0) throw unresolvedFactoryError(this.env());
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

  // Already-negotiated pool, or null. Synchronous; does not create one.
  peekPool(name) {
    return this.pools.get(name) || null;
  }

  // D7/D8. Pool creation runs the sslmode negotiation plan, so `prefer` and
  // `allow` genuinely fall back instead of throwing on the server's 'N' byte.
  // The winning transport is cached with the pool, so the ladder is walked once
  // per connection, not once per query.
  async getPool(name) {
    if (this.pools.has(name)) return this.pools.get(name);
    if (this.pending.has(name)) return this.pending.get(name);

    const cfg = this.configs.get(name);
    if (!cfg) {
      if (this.configs.size === 0) throw unresolvedFactoryError(this.env());
      return null;
    }

    // C6, third layer. The tool-layer chokepoint already refuses a disabled
    // connection, but a disabled connection must not be openable by any route
    // at all — including a future caller that reaches getPool directly.
    if (normalizePermission(cfg.permission) === "disabled") {
      const err = new Error(
        `Connection "${name}" is disabled (permission: disabled) and will not be opened. ` +
          `Re-enable it with omatic_edit_connection(name="${name}", permission="read_only") or "read_write".`
      );
      err.code = "OMATIC_CONNECTION_DISABLED";
      throw err;
    }

    const creation = (async () => {
      const result = await negotiate(cfg, { max: 4, idleTimeoutMillis: 30_000 }, async (client, _pool, ssl) => {
        client.release();
        return ssl;
      });
      if (!result.ok) {
        const err = new Error(`Connection "${name}" failed: ${result.error}`);
        err.code = "OMATIC_CONNECT_FAILED";
        err.ssl = result.ssl;
        err.attempts = result.attempts;
        throw err;
      }
      this.tls.set(name, { ...result.ssl, negotiated_at: new Date().toISOString(), attempts: result.attempts });
      this.pools.set(name, result.pool);
      return result.pool;
    })();

    this.pending.set(name, creation);
    try {
      return await creation;
    } finally {
      this.pending.delete(name);
    }
  }

  // C6. The access mode for a connection. Unknown connections report the
  // default rather than throwing — callers use this to decide whether to
  // refuse, and "unknown" must never read as "permitted by omission".
  permissionOf(name) {
    const cfg = this.configs.get(name);
    return cfg && cfg.permission ? cfg.permission : DEFAULT_PERMISSION;
  }

  // D9. Configured intent and negotiated reality as separate fields.
  tlsStatus(name) {
    const cfg = this.configs.get(name);
    if (!cfg) return null;
    const negotiated = this.tls.get(name) || null;
    return {
      name,
      ssl_mode_configured: cfg.sslMode,
      ssl_negotiated: negotiated ? negotiated.negotiated : null,
      encrypted: negotiated ? negotiated.encrypted : null,
      tls_protocol: negotiated ? negotiated.protocol : null,
      tls_cipher: negotiated && negotiated.cipher ? negotiated.cipher.name : null,
      tls_authorized: negotiated ? negotiated.authorized : null,
      tls_authorization_error: negotiated ? negotiated.authorization_error : null,
      fell_back: negotiated ? Boolean(negotiated.fell_back) : null,
      negotiated_at: negotiated ? negotiated.negotiated_at : null,
      note: negotiated ? null : "not yet connected — negotiated values appear after first use",
    };
  }

  // Connection listing with configured vs actual TLS kept distinct. Credentials
  // are never included.
  describeConnections() {
    return this.names().map((name) => {
      const cfg = this.configs.get(name);
      return {
        name,
        host: cfg.host,
        port: cfg.port,
        database: cfg.database,
        user: cfg.user,
        permission: this.permissionOf(name),
        ...this.tlsStatus(name),
      };
    });
  }

  async execute(name, sql) {
    return this.query(name, sql, []);
  }

  async query(name, sql, params = []) {
    const pool = await this.getPool(name);
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
    const pool = await this.getPool(name);
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
    this.tls.clear();
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
        next.sslMode !== old.sslMode ||
        // C6. A permission change alters the pool's connection options
        // (default_transaction_read_only), so the old pool must not survive it.
        // Without this line, switching a connection to read_only would leave a
        // live read-write pool serving every subsequent query.
        next.permission !== old.permission;
      if (replaced) {
        removedOrChanged.push(oldPool.end().catch(() => {}));
        this.pools.delete(name);
        this.tls.delete(name);
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

  // B1. The selection used to be built into a local object that was handed to
  // reload() and then dropped, so it survived neither a later call that read
  // process.env directly nor the process itself — which is why the operator had
  // to re-select the same factory again and again in one Cowork session.
  //
  // It now does three things: mutates process.env so every later
  // loadProjectContext()/loadConnections() call agrees, keeps this.runtimeEnv
  // in step, and writes the choice to the durable state file so the next
  // process restores it via restoreSelection().
  async selectFactory({ factory_json_path: factoryJsonPath, project_root: projectRoot } = {}) {
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

    // Apply to the real process environment, not a copy.
    if (selection.factory_json_path) {
      process.env.OMATIC_FACTORY_JSON_PATH = selection.factory_json_path;
      delete process.env.OMATIC_PROJECT_ROOT;
    } else {
      process.env.OMATIC_PROJECT_ROOT = selection.project_root;
      delete process.env.OMATIC_FACTORY_JSON_PATH;
    }

    const persistence = writeSelectionState(
      { ...selection, host_project_dir: resolvedOrNull(process.env.CLAUDE_PROJECT_DIR) },
      process.env
    );

    this.activeName = null;
    const result = await this.reload(process.env);
    return { ...result, selection, persistence };
  }

  // Re-apply a previously persisted selection, then refresh this instance.
  restoreSelection(env = process.env) {
    const result = restoreSelection(env);
    if (result.restored) {
      this.runtimeEnv = env;
      this.projectContext = loadProjectContext(env);
    }
    return result;
  }

  forgetSelection(env = process.env) {
    return clearSelectionState(env);
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
  isFactoryFileGitignored,
  testConnection,
  sanitizeName,
  // resolution / diagnostics
  candidateProjectRoots,
  candidateWriteRoots,
  projectRootCandidates,
  factoryResolutionReport,
  unresolvedFactoryError,
  // persisted selection
  stateDir,
  selectionStatePath,
  readSelectionState,
  writeSelectionState,
  clearSelectionState,
  restoreSelection,
  // tls
  sslConfig,
  sslOptionsForMode,
  sslAttemptsFor,
  normalizeSslMode,
  describeTls,
  NAME_PATTERN,
  VALID_SSL_MODES,
  DEFAULT_SSL_MODE,
  // permissions (C6)
  VALID_PERMISSIONS,
  DEFAULT_PERMISSION,
  normalizePermission,
  assertValidPermission,
  poolOptionsFor,
};
