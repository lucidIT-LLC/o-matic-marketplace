#!/usr/bin/env node
// smoke-tool-surface.mjs — the regression guards for 5.0.0.
//
// This replaces smoke-startup-modes.mjs, which had 831 assertions about startup
// packet formatting, probe recency, connection CRUD, TLS negotiation and the
// per-connection permission chokepoint. Every one of those subjects was deleted
// in 5.0.0 when the plugin stopped being a database client (decision #283), so
// the tests went with them rather than being weakened until they passed. A test
// kept alive after its subject is gone tests nothing and reads as coverage.
//
// What is guarded here is the new contract, and above all its NEGATIVE half:
// the DB surface must stay gone. A stub, a re-export, or a stray `require("pg")`
// would each quietly undo this release, and none of them would look like a bug
// in isolation — which is exactly why they are asserted.
//
// Pure logic. No database, no network, no host.

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fsMod from "node:fs";
import osMod from "node:os";

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(here, "../server");

const tools = require(resolve(serverDir, "tools.js"));
const factory = require(resolve(serverDir, "factory.js"));
const resources = require(resolve(serverDir, "resources.js"));

const {
  __test__,
  buildToolList,
  handleToolCall,
  buildServerInstructions,
  FactoryContext,
  REMOVED_TOOLS,
  CONDUCTOR,
} = tools;
const {
  OutcomeCollector,
  runWithOutcome,
  currentOutcome,
  successResponse,
  errorResponse,
  assertToolNamesSafe,
  hostVisibleToolName,
  MAX_BARE_TOOL_NAME_BYTES,
  HOST_TOOL_NAME_LIMIT,
  HOST_TOOL_NAMESPACE,
  assertNoCredentials,
  describeRuntime,
} = __test__;

let pass = 0;
const failures = [];
const ok = (cond, msg) => (cond ? pass++ : failures.push(msg));
const parse = (res) => JSON.parse(res.content[0].text);

// A context that resolves nothing, so the surface can be exercised on a machine
// with no factory at all — which is the state a fresh install is in.
const stubContext = (project = {}) =>
  new FactoryContext({ factory_id: "test-factory", factory_file: null, resolution: {}, ...project });

// ─────────────────────────────────────────────────────────────────────────────
// 1. The surface is four tools, and none of them is a database tool
// ─────────────────────────────────────────────────────────────────────────────

const SURVIVING = [
  "omatic_usage_guide",
  "omatic_resolve_factory",
  "omatic_runtime_status",
  "omatic_select_factory",
];

const list = buildToolList(stubContext());
const names = list.map((t) => t.name);

ok(list.length === 4, `the tool surface is exactly 4 tools (got ${list.length}: ${names.join(", ")})`);
for (const name of SURVIVING) {
  ok(names.includes(name), `${name} survives`);
}

// The negative half. Any of these reappearing means the DB client came back.
const MUST_NOT_EXIST = [
  "omatic_execute_sql",
  "omatic_search_memory",
  "omatic_factory_startup",
  "omatic_factory_startup_run",
  "omatic_factory_health_check",
  "omatic_embedding_status",
  "omatic_list_tasks",
  "omatic_record_decision",
  "omatic_record_session_event",
  "omatic_record_probe_result",
  "omatic_claim_work",
  "omatic_release_work",
  "omatic_add_connection",
  "omatic_edit_connection",
  "omatic_remove_connection",
  "omatic_test_connection",
  "omatic_list_connections",
  "omatic_set_active_connection",
];
for (const gone of MUST_NOT_EXIST) {
  ok(!names.includes(gone), `${gone} is NOT published`);
}

// No pinned per-connection variants — there are no connections to pin to.
ok(!names.some((n) => n.includes(":")), "no pinned :connection variants are published");

// Every tool declares a schema and a description that mentions the factory.
for (const entry of list) {
  ok(Boolean(entry.inputSchema && entry.inputSchema.type === "object"), `${entry.name} declares an object input schema`);
  ok(/Active factory:/.test(entry.description), `${entry.name} discloses the active factory in its description`);
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Removed tools fail CLOSED — deleted, not stubbed
// ─────────────────────────────────────────────────────────────────────────────
//
// The whole point of the release. A removed tool must produce an error, not a
// polite "unsupported" success. A stub is a call site with no implementation,
// and a caller that cannot tell "refused" from "returned nothing" is the defect
// this factory spent a day removing from seven other places.

for (const gone of MUST_NOT_EXIST) {
  const res = await handleToolCall(stubContext(), gone, {});
  const body = parse(res);
  ok(res.isError === true, `${gone} returns isError:true`);
  ok(body.success === false, `${gone} returns success:false`);
  ok(body.outcome === "failed", `${gone} returns outcome:"failed"`);
  ok(body.results_trustworthy === false, `${gone} is not trustworthy`);
  ok(/Unknown tool/.test(body.error), `${gone} reports "Unknown tool"`);
  ok(/Conductor/.test(body.error), `${gone} points the caller at Conductor`);
  ok(/localhost:8438/.test(body.error), `${gone} names Conductor's loopback endpoint`);
}

// A pinned variant of a removed tool must fail the same way, not be parsed as a
// live base tool with a suffix.
{
  const res = await handleToolCall(stubContext(), "omatic_execute_sql:kb", {});
  ok(res.isError === true, "a pinned variant of a removed tool fails closed");
  ok(/Conductor/.test(parse(res).error), "a pinned variant is redirected to Conductor");
}

// An unrelated unknown tool still errors, but names the real surface rather
// than claiming it was removed.
{
  const body = parse(await handleToolCall(stubContext(), "omatic_make_coffee", {}));
  ok(/Unknown tool/.test(body.error), "an unrelated unknown tool errors");
  ok(!/REMOVED in/.test(body.error), "an unrelated unknown tool is not falsely reported as removed");
  ok(/omatic_resolve_factory/.test(body.error), "an unrelated unknown tool names the real surface");
}

ok(REMOVED_TOOLS.length >= MUST_NOT_EXIST.length, "REMOVED_TOOLS documents every removed tool");

// ─────────────────────────────────────────────────────────────────────────────
// 3. No database client remains in the shipped code
// ─────────────────────────────────────────────────────────────────────────────
//
// Source-level, because the tool list above only proves nothing is ADVERTISED.
// A dispatcher that still opened a pool would pass every assertion so far.

const serverSources = fsMod
  .readdirSync(serverDir)
  .filter((f) => f.endsWith(".js"))
  .map((f) => ({ file: f, text: fsMod.readFileSync(resolve(serverDir, f), "utf8") }));

ok(serverSources.length === 4, `the server is 4 source files (got ${serverSources.map((s) => s.file).join(", ")})`);
ok(!fsMod.existsSync(resolve(serverDir, "connections.js")), "connections.js is deleted");

for (const { file, text } of serverSources) {
  ok(!/require\(\s*["']pg["']\s*\)/.test(text), `${file} does not require pg`);
  ok(!/\bnew Pool\b/.test(text), `${file} does not construct a connection pool`);
}

const serverPkg = JSON.parse(fsMod.readFileSync(resolve(serverDir, "package.json"), "utf8"));
ok(!("pg" in (serverPkg.dependencies || {})), "pg is not a declared dependency");
ok(!fsMod.existsSync(resolve(serverDir, "node_modules/pg")), "pg is not in the vendored runtime");

const lock = JSON.parse(fsMod.readFileSync(resolve(serverDir, "package-lock.json"), "utf8"));
ok(
  !Object.keys(lock.packages || {}).some((k) => k === "node_modules/pg" || k.startsWith("node_modules/pg/")),
  "pg is not in the lockfile"
);

// ─────────────────────────────────────────────────────────────────────────────
// 4. Everything that used to point at the removed tools now points at Conductor
// ─────────────────────────────────────────────────────────────────────────────

const instructions = buildServerInstructions();
ok(/Conductor/.test(instructions), "the MCP instructions name Conductor");
ok(/localhost:8438/.test(instructions), "the MCP instructions name the loopback endpoint");
ok(/factory_query/.test(instructions), "the MCP instructions name factory_query");
ok(/connections_list/.test(instructions), "the MCP instructions name connections_list");
ok(/embed_query/.test(instructions), "the MCP instructions name embed_query");
ok(/omatic_select_factory/.test(instructions), "the MCP instructions still name the pin step");
ok(/o-MATIC Home Office/.test(instructions), "the MCP instructions give Conductor's operator-facing names");
for (const gone of ["omatic_execute_sql", "omatic_search_memory", "omatic_list_connections"]) {
  // Named only inside the "these were removed" sentence, never as an instruction.
  const asInstruction = new RegExp(`(Use|prefer|call)\\s+${gone}`, "i");
  ok(!asInstruction.test(instructions), `the MCP instructions do not instruct callers to use ${gone}`);
}

// Conductor's operator-facing connection names differ from the plugin's old
// ones. Naming the old ones to an operator sends them to a connection that does
// not exist under that name.
for (const name of ["o-MATIC Home Office", "Commons", "About Jimmy", "Benecard", "lucidIT Corp", "Practically Adventist", "theNest"]) {
  ok(CONDUCTOR.connection_names.some((n) => n.includes(name)), `Conductor's "${name}" is documented`);
}
ok(/was the plugin's `omatic`/.test(CONDUCTOR.connection_names[0]), "the old plugin name is mapped to the new one");
ok(/task #222/.test(CONDUCTOR.tools.embed_query), "the weights-mismatch constraint is documented on embed_query");
ok(/refusal, never an empty result/.test(CONDUCTOR.refusals), "a grant refusal is documented as a refusal");

// The usage guide is the tool an operator calls to find out what they have. It
// must state the removal rather than describing a surface that is gone.
{
  const guide = parse(await handleToolCall(stubContext(), "omatic_usage_guide", {}));
  ok(guide.success === true, "the usage guide answers");
  ok(guide.version === serverPkg.version, "the usage guide reports the running version, not a literal");
  ok(guide.database_access && /Conductor/.test(guide.database_access.what), "the usage guide routes DB work to Conductor");
  ok(Array.isArray(guide.what_this_plugin_no_longer_does.removed_tools), "the usage guide lists the removed tools");
  ok(
    guide.what_this_plugin_no_longer_does.removed_tools.includes("omatic_execute_sql"),
    "the usage guide names omatic_execute_sql as removed"
  );
  ok(/deleted, not deprecated/i.test(guide.what_this_plugin_no_longer_does.removed_note), "the usage guide says deleted, not deprecated");
  ok(!("connections" in guide), "the usage guide no longer returns a connection list");
  ok(!("pgvector_guidance" in guide), "the usage guide no longer claims to drive pgvector retrieval");
  ok(!("connection_management" in guide), "the usage guide no longer documents connection CRUD");
}

// Resources and prompts must not name a handler that no longer exists — a dead
// URI errors on read, and a prompt that names a removed tool sends the model
// into a failure it cannot recover from.
const resourceTools = resources.RESOURCES.map((r) => r.tool);
for (const t of resourceTools) ok(SURVIVING.includes(t), `resource handler ${t} still exists`);
ok(resources.RESOURCES.length === 2, "two resources are published");
const promptText = resources.PROMPTS.map((p) => p.build({})).join("\n");
for (const gone of MUST_NOT_EXIST) {
  ok(!promptText.includes(gone), `no prompt instructs the model to call ${gone}`);
}
ok(/Conductor/.test(promptText), "the prompts route DB work to Conductor");
ok(/omatic_select_factory/.test(promptText), "the start-the-factory prompt still pins the factory first");

// ─────────────────────────────────────────────────────────────────────────────
// 5. Factory resolution — the capability that had to survive
// ─────────────────────────────────────────────────────────────────────────────
//
// CLAUDE.md step 0 pins with omatic_select_factory on every session, on every
// host, and rule #259 forbids walking up the directory tree. Breaking either
// breaks every session everywhere, so both are asserted directly.

const tmp = fsMod.mkdtempSync(resolve(osMod.tmpdir(), "omatic-smoke-"));
const projectRoot = resolve(tmp, "project");
const nested = resolve(projectRoot, "sub", "deeper");
fsMod.mkdirSync(resolve(projectRoot, ".omatic"), { recursive: true });
fsMod.mkdirSync(nested, { recursive: true });
fsMod.writeFileSync(
  resolve(projectRoot, ".omatic/factory.json"),
  JSON.stringify({ factory_id: "smoke-factory", connection_profile: "default" }, null, 2)
);
const stateDir = resolve(tmp, "state");

const envFor = (extra = {}) => ({ OMATIC_STATE_DIR: stateDir, ...extra });

{
  const ctx = factory.loadProjectContext(envFor({ OMATIC_PROJECT_ROOT: projectRoot }));
  ok(ctx.factory_id === "smoke-factory", "a factory at the project root resolves");
  ok(ctx.factory_file === resolve(projectRoot, ".omatic/factory.json"), "the resolved factory_file is the one on disk");
}

// Rule #259 — no walk-up. A child directory of a project must NOT inherit the
// parent's factory. This is the assertion that stops the "stuck on the first
// database" bug from coming back.
{
  const ctx = factory.loadProjectContext(envFor({ OMATIC_PROJECT_ROOT: nested }));
  ok(ctx.factory_file === null, "rule #259: discovery does not walk up into a parent factory");
}

// A plugin install directory is never a project, however it is named.
for (const bad of ["/x/.claude/plugins/cache/o-matic-marketplace", "/x/omatic-server-connection", "/x/Claude Extensions/y"]) {
  ok(factory.isPluginInstallPath(bad), `a plugin install path is rejected as a project root: ${bad}`);
}

// select → persist → restore, which is what makes step 0 a once-per-project act
// rather than a once-per-session one.
{
  const env = envFor();
  const result = factory.selectFactory({ project_root: projectRoot }, env);
  ok(result.ok === true, "selectFactory pins an existing factory");
  ok(result.persistence.persisted === true, "the selection is persisted");
  ok(env.OMATIC_PROJECT_ROOT === projectRoot, "the selection is applied to the environment");

  const fresh = { OMATIC_STATE_DIR: stateDir };
  const restored = factory.restoreSelection(fresh);
  ok(restored.restored === true, "a persisted selection is restored into a fresh environment");
  ok(factory.loadProjectContext(fresh).factory_id === "smoke-factory", "the restored selection resolves the same factory");
}

// Selecting something that is not there fails loudly rather than resolving to a
// neighbour.
{
  let threw = null;
  try {
    factory.selectFactory({ project_root: resolve(tmp, "nope") }, envFor());
  } catch (err) {
    threw = err.message;
  }
  ok(threw !== null, "selecting a non-existent project root throws");
  ok(/does not walk up/.test(threw), "the failure explains that discovery does not walk up");
}

// The unresolved-factory error is the message an operator sees most often when
// something is wrong. It must not advertise tools that no longer exist.
{
  const err = factory.unresolvedFactoryError({ OMATIC_STATE_DIR: stateDir, HOME: tmp });
  ok(err.code === "OMATIC_FACTORY_UNRESOLVED", "the unresolved error carries its code");
  ok(/omatic_select_factory/.test(err.message), "the unresolved error names the recovery call");
  ok(/Conductor/.test(err.message), "the unresolved error routes DB access to Conductor");
  for (const gone of ["omatic_add_connection", "omatic_test_connection", "omatic_list_connections", "omatic_edit_connection"]) {
    ok(!err.message.includes(gone), `the unresolved error does not advertise ${gone}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. Credentials: none are read, and a legacy one is reported without exposing it
// ─────────────────────────────────────────────────────────────────────────────

{
  const legacyRoot = resolve(tmp, "legacy");
  fsMod.mkdirSync(resolve(legacyRoot, ".omatic"), { recursive: true });
  fsMod.writeFileSync(
    resolve(legacyRoot, ".omatic/factory.json"),
    JSON.stringify({
      factory_id: "legacy",
      connections: [
        { name: "omatic", host: "db.example", database: "omatic", user: "svc", password: "hunter2-super-secret" },
      ],
    })
  );
  // A state dir of its own: the persisted selection written by the previous
  // case outranks OMATIC_PROJECT_ROOT by design, so sharing one would resolve
  // the wrong factory and test nothing.
  const ctx = factory.loadProjectContext({
    OMATIC_STATE_DIR: resolve(tmp, "state-legacy"),
    OMATIC_PROJECT_ROOT: legacyRoot,
  });

  ok(!("connections" in ctx), "the project context no longer carries the connections array");
  ok(!("database_url" in ctx), "the project context no longer carries a database_url");
  ok(ctx.legacy_connection_fields.present === true, "a legacy credential in factory.json is reported");
  ok(ctx.legacy_connection_fields.keys.includes("password"), "the legacy report names the key");
  ok(ctx.legacy_connection_fields.connection_entries === 1, "the legacy report counts the entries");

  // Presence, never value. The secret must not appear anywhere in the context.
  ok(!JSON.stringify(ctx).includes("hunter2-super-secret"), "the legacy credential VALUE never leaves factory.json");

  // ...nor in any response built from it.
  const res = parse(await handleToolCall(new FactoryContext(ctx), "omatic_resolve_factory", {}));
  ok(!JSON.stringify(res).includes("hunter2-super-secret"), "no response carries the legacy credential value");
  ok(res.factory.legacy_connection_fields.present === true, "resolve_factory surfaces the migration prompt");
}

// The response-layer guard itself.
ok(assertNoCredentials({ ok: true, password_configured: true }) !== null, "a presence boolean is allowed");
{
  let threw = false;
  try {
    assertNoCredentials({ conn: { password: "s3cret-value" } });
  } catch {
    threw = true;
  }
  ok(threw, "a credential-shaped key holding a value is refused");
}
{
  let threw = false;
  try {
    assertNoCredentials({ error: "connect failed for hunter2-super-secret" }, ["hunter2-super-secret"]);
  } catch {
    threw = true;
  }
  ok(threw, "a secret leaked into an error string is refused");
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. The response envelope — a clean result must stay structurally unreachable
//    once anything has failed
// ─────────────────────────────────────────────────────────────────────────────

{
  const clean = runWithOutcome(() => parse(successResponse({ a: 1 })));
  ok(clean.outcome === "complete", "a clean call reports complete");
  ok(clean.results_trustworthy === true, "a clean call is trustworthy");
  ok(clean.trust_level === "trusted", "a clean call is trusted");
}
{
  const failed = runWithOutcome(() => {
    currentOutcome().markFatal("boom");
    return parse(successResponse({ a: 1 }));
  });
  ok(failed.outcome === "failed", "a fatal call reports failed even through successResponse");
  ok(failed.success === false, "a fatal call is not a success");
  ok(failed.results_trustworthy === false, "a fatal call is not trustworthy");
  ok(failed.degraded_reasons.some((r) => r.includes("boom")), "the fatal reason is carried");
}
{
  const degraded = runWithOutcome(() => {
    currentOutcome().recordUnavailable("thing", "not installed");
    return parse(successResponse({}));
  });
  ok(degraded.outcome === "degraded", "an unavailable capability degrades the response");
  ok(degraded.results_trustworthy === false, "a degraded response is never clean");
  ok(degraded.trust_level === "untrusted", "a degraded response with no rows is untrusted");
}
{
  // The invariant that makes the envelope worth having: complete + reasons must
  // be impossible, not merely discouraged.
  const c = new OutcomeCollector();
  c.recordUnavailable("x", "y");
  ok(c.outcome() === "degraded", "the collector cannot report complete alongside a reason");
}
{
  const err = runWithOutcome(() => parse(errorResponse("nope", { detail: 1 })));
  ok(err.success === false && err.outcome === "failed", "errorResponse is always a failure");
  ok(err.detail === 1, "errorResponse carries caller detail");
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. The model-visible tool-name budget (B8)
// ─────────────────────────────────────────────────────────────────────────────
//
// Codex silently truncates and hashes any namespaced tool name over 64 bytes,
// so an over-budget name is a name the model calls wrong with nothing logged.
// The surface is short now, but the guard is what keeps it that way.

ok(MAX_BARE_TOOL_NAME_BYTES === HOST_TOOL_NAME_LIMIT - HOST_TOOL_NAMESPACE.length, "the name budget is derived, not asserted");
for (const entry of list) {
  ok(
    Buffer.byteLength(hostVisibleToolName(entry.name)) <= HOST_TOOL_NAME_LIMIT,
    `${entry.name} fits the host tool-name budget once namespaced`
  );
}
{
  let threw = false;
  try {
    assertToolNamesSafe([{ name: "omatic_" + "x".repeat(MAX_BARE_TOOL_NAME_BYTES) }]);
  } catch {
    threw = true;
  }
  ok(threw, "an over-budget tool name is refused rather than shipped to be mangled");
}
{
  let threw = false;
  try {
    // Both fold to the same host-visible name once `:` and `-` become `_`.
    assertToolNamesSafe([{ name: "omatic_a:b" }, { name: "omatic_a_b" }]);
  } catch {
    threw = true;
  }
  ok(threw, "two names that collide after host folding are refused");
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. Runtime reporting still works in both modes
// ─────────────────────────────────────────────────────────────────────────────

{
  const rt = describeRuntime();
  ok(rt.node_version === process.versions.node, "the runtime version is measured from the process");
  ok(rt.satisfies_minimum === true, "the running Node satisfies the declared minimum");
  const res = parse(await handleToolCall(stubContext(), "omatic_runtime_status", {}));
  ok(res.mode === "full", "omatic_runtime_status reports full mode when the runtime resolved");
  ok(res.runtime.node_version === process.versions.node, "omatic_runtime_status reports the measured runtime");
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. The shipped documentation matches the shipped code
// ─────────────────────────────────────────────────────────────────────────────

const readme = fsMod.readFileSync(resolve(here, "../README.md"), "utf8");
ok(/Conductor/.test(readme), "the README names Conductor");
ok(/localhost:8438/.test(readme), "the README gives the Conductor endpoint");
ok(/not a database client/i.test(readme), "the README states the plugin is not a database client");
for (const gone of ["omatic_execute_sql", "omatic_add_connection"]) {
  const asLiveTool = new RegExp(`^\\s*[-*|]?\\s*\`?${gone}\`?\\s*[|—-]`, "m");
  ok(!asLiveTool.test(readme), `the README does not document ${gone} as a live tool`);
}

const changelog = fsMod.readFileSync(resolve(here, "../CHANGELOG.md"), "utf8");
ok(/^## 5\.0\.0/m.test(changelog), "the CHANGELOG has a 5.0.0 entry");
ok(/Removed/.test(changelog), "the CHANGELOG has a Removed section");
ok(/Conductor/.test(changelog), "the CHANGELOG says where users go instead");
ok(changelog.includes("omatic_execute_sql"), "the CHANGELOG names what was removed");

// Version identity, in every place that carries it.
const pluginPkg = JSON.parse(fsMod.readFileSync(resolve(here, "../package.json"), "utf8"));
const indexSrc = fsMod.readFileSync(resolve(serverDir, "index.js"), "utf8");
ok(pluginPkg.version === serverPkg.version, "plugin and server package versions agree");
ok(indexSrc.includes(`PLUGIN_VERSION = "${serverPkg.version}"`), "the runtime version literal agrees with package.json");
ok(serverPkg.version.startsWith("5."), "this is a major release — the tool surface changed incompatibly");

fsMod.rmSync(tmp, { recursive: true, force: true });

if (failures.length) {
  console.error(`tool-surface smoke: ${pass} passed, ${failures.length} FAILED`);
  for (const f of failures) console.error("  FAIL:", f);
  process.exit(1);
}
console.log(`tool-surface smoke: ${pass} passed, 0 failed`);
