#!/usr/bin/env node
// embed-drain.mjs — drain unembedded and stale rows through the factory's
// configured embedding provider.
//
// Replaces server/embedder-worker.js, retired in 4.0.0. The worker spoke the
// OpenAI REST shape and read factory_config keys (openai_base_url,
// openai_embedding_model, openai_api_key) that no longer exist after the
// on-device migration — so on a factory configured for an onboard provider it
// silently fell back to api.openai.com and never drained anything. Measured
// 2026-08-08: five decision records sat unembedded for four hours with the
// worker present and nominally responsible.
//
// This drain reads what is actually in factory_config, speaks the provider named
// there, and covers BOTH tiers. A Tier-1-only drain leaves document_chunks
// permanently absent from deep retrieval and is a standing audit failure.
//
// It refuses to write when the provider's weights or dimension disagree with
// factory_config. Mixing weights in one column poisons a corpus silently: every
// search still returns rows, just wrong ones.
//
//   node scripts/embed-drain.mjs [--dry-run] [--watch] [--interval-ms=60000]
//                                [--connection=NAME] [--tenant=ID] [--batch-size=50]
//
// Token, in precedence order: --token=, OMATIC_EMBED_TOKEN, CONDUCTOR_TOKEN,
// factory_config.embedding_api_key. Endpoint: --endpoint=, OMATIC_EMBED_ENDPOINT,
// factory_config.embedding_endpoint.

import { createRequire } from "node:module";
import { resolve, dirname, join } from "node:path";
import { networkInterfaces } from "node:os";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { ConnectionManager, loadConnections, loadProjectContext } = require(join(pluginRoot, "server/connections.js"));

const arg = (name, fallback = null) => {
  const found = process.argv.find((a) => a.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : fallback;
};
const flag = (name) => process.argv.includes(name);

const DRY = flag("--dry-run");
const WATCH = flag("--watch");
const INTERVAL = Number.parseInt(arg("--interval-ms", "60000"), 10);
const BATCH = Number.parseInt(arg("--batch-size", "50"), 10);

// factory_config values are jsonb; a stored string arrives JSON-quoted.
const unquote = (v) => {
  if (v === null || v === undefined) return null;
  const s = typeof v === "string" ? v : JSON.stringify(v);
  try {
    const parsed = JSON.parse(s);
    return typeof parsed === "string" ? parsed : s;
  } catch {
    return s;
  }
};

const TIERS = [
  { table: "semantic_index", textColumn: "summary_text" },
  { table: "document_chunks", textColumn: "content" },
];

// factory_config.embedding_endpoint holds one absolute address, but the right
// address depends on where the caller runs. When the provider is on another
// machine the tailnet address is the only one that works; when the caller is ON
// that machine, connecting to its own tailnet IP is a hairpin that a sandboxed
// process cannot make — it hangs until timeout rather than failing fast.
//
// Measured 2026-08-08: identical config, tailnet address, timed out from the
// Studio and answered in 2 ms on loopback. Rather than pin a host-specific value
// in shared config — the same mistake as OMATIC_PROJECT_ROOT=${CODEX_WORKSPACE} —
// detect at runtime whether the endpoint host is one of our own addresses.
function localizeEndpoint(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return { endpoint, rewritten: false };
  }
  const mine = new Set();
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs || []) mine.add(a.address);
  }
  if (!mine.has(url.hostname)) return { endpoint, rewritten: false };
  const original = url.host;
  url.hostname = "127.0.0.1";
  return { endpoint: url.toString(), rewritten: true, original };
}

async function callProvider(endpoint, token, tool, text) {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: tool, arguments: { text } },
    }),
  });
  let raw = await res.text();
  if (res.status === 401) {
    throw new Error(
      "401 from the embedding provider. Conductor mints a new bearer token on every launch and " +
        "nothing propagates it — re-read the current token and pass --token=, or set OMATIC_EMBED_TOKEN."
    );
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 200)}`);
  if (raw.includes("data:")) raw = raw.split("\n").filter((l) => l.startsWith("data:")).pop().slice(5).trim();
  const body = JSON.parse(raw);
  if (body.error) throw new Error(`provider error: ${JSON.stringify(body.error).slice(0, 200)}`);
  const content = body.result?.content;
  return content?.[0]?.text ? JSON.parse(content[0].text) : body.result;
}

const vectorOf = (r) => r.embedding || r.vector || [];

function toVectorLiteral(v) {
  for (const x of v) {
    if (!Number.isFinite(x)) throw new Error("provider returned a non-finite value; refusing to write");
  }
  return `[${v.join(",")}]`;
}

async function runOnce(query, tenant, endpoint, token) {
  const cfgRows = await query(
    `SELECT key, value FROM factory.factory_config WHERE tenant_id = $1 AND category = 'embedding'`,
    [tenant]
  );
  const cfg = Object.fromEntries(cfgRows.rows.map((r) => [r.key, unquote(r.value)]));
  const wantIdentity = cfg.embedding_model_identity;
  const wantDim = Number(cfg.embedding_dimension) || 768;
  if (!wantIdentity) throw new Error("factory_config has no embedding_model_identity; refusing to guess the corpus weights");

  const probe = await callProvider(endpoint, token, "embed_document", "weights probe");
  const gotDim = vectorOf(probe).length;
  console.log(`contract  want ${wantIdentity} @${wantDim}d  got ${probe.weightsIdentifier} @${gotDim}d`);
  if (probe.weightsIdentifier !== wantIdentity) throw new Error("REFUSING: provider weights differ from the corpus");
  if (gotDim !== wantDim) throw new Error(`REFUSING: provider dimension ${gotDim} != corpus ${wantDim}`);

  let embedded = 0;
  let skipped = 0;
  for (const tier of TIERS) {
    const pending = await query(
      `SELECT id, ${tier.textColumn} AS text FROM ${tier.table}
        WHERE tenant_id = $1 AND (embedding IS NULL OR embedding_stale)
        ORDER BY id LIMIT $2`,
      [tenant, BATCH]
    );
    if (!pending.rows.length) {
      console.log(`${tier.table}: clean`);
      continue;
    }
    console.log(`${tier.table}: ${pending.rows.length} pending`);
    for (const row of pending.rows) {
      if (!row.text || !String(row.text).trim()) {
        console.log(`  ${row.id}: skipped, empty ${tier.textColumn}`);
        skipped++;
        continue;
      }
      const result = await callProvider(endpoint, token, "embed_document", String(row.text));
      const vec = vectorOf(result);
      // Re-checked per row, not just at probe time: a provider restarted
      // mid-drain can come back on different weights.
      if (vec.length !== wantDim) throw new Error(`${tier.table}.${row.id}: dimension ${vec.length}`);
      if (result.weightsIdentifier !== wantIdentity) throw new Error(`${tier.table}.${row.id}: weights drifted mid-drain`);
      if (DRY) {
        console.log(`  ${row.id}: dry-run ok${result.truncated ? " (TRUNCATED)" : ""}`);
        continue;
      }
      await query(
        `UPDATE ${tier.table}
            SET embedding = $1::vector, model_version = $2, embedded_at = now(), embedding_stale = false
          WHERE id = $3`,
        [toVectorLiteral(vec), wantIdentity, row.id]
      );
      embedded++;
      if (result.truncated) console.log(`  ${row.id}: embedded, TRUNCATED — source exceeds provider context`);
    }
  }
  return { embedded, skipped };
}

async function main() {
  const project = loadProjectContext();
  const connections = new ConnectionManager(loadConnections(), project);
  const name = arg("--connection", connections.defaultName());
  const tenant = arg("--tenant", project.factory_id || "omatic");
  const query = (sql, params = []) => connections.query(name, sql, params);

  const cfgRows = await query(
    `SELECT key, value FROM factory.factory_config WHERE tenant_id = $1 AND category = 'embedding'`,
    [tenant]
  );
  const cfg = Object.fromEntries(cfgRows.rows.map((r) => [r.key, unquote(r.value)]));

  const configured = arg("--endpoint", process.env.OMATIC_EMBED_ENDPOINT || cfg.embedding_endpoint);
  const token = arg("--token", process.env.OMATIC_EMBED_TOKEN || process.env.CONDUCTOR_TOKEN || cfg.embedding_api_key);
  if (!configured) throw new Error("no embedding endpoint: set factory_config.embedding_endpoint or pass --endpoint=");
  const { endpoint, rewritten, original } = localizeEndpoint(configured);
  if (rewritten) console.log(`endpoint ${original} is this machine — using loopback (own-address hairpin)`);
  if (!token) throw new Error("no embedding token: pass --token=, or set OMATIC_EMBED_TOKEN / CONDUCTOR_TOKEN");

  console.log(`drain    ${name} / ${tenant} -> ${endpoint}${DRY ? "  [dry-run]" : ""}`);

  for (;;) {
    const { embedded, skipped } = await runOnce(query, tenant, endpoint, token);
    console.log(`${DRY ? "would embed" : "embedded"} ${embedded}${skipped ? `, skipped ${skipped}` : ""}`);
    const health = await query(
      `SELECT tier, total_rows, embedded, unembedded, stale FROM v_embedding_health WHERE tenant_id = $1 ORDER BY tier`,
      [tenant]
    );
    for (const r of health.rows) {
      console.log(`  ${r.tier}: ${r.embedded}/${r.total_rows} embedded, ${r.unembedded} unembedded, ${r.stale} stale`);
    }
    if (!WATCH) break;
    await new Promise((r) => setTimeout(r, INTERVAL));
  }
  process.exit(0);
}

main().catch((error) => {
  process.stderr.write(`[omatic-embed-drain] ${error.message}\n`);
  process.exit(1);
});
