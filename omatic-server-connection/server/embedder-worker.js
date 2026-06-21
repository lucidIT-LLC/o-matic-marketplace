#!/usr/bin/env node
const {
  ConnectionManager,
  loadConnections,
  loadProjectContext,
} = require("./connections.js");

const DEFAULT_MODEL = "text-embedding-3-small";
const DEFAULT_TENANT = "omatic";
const DEFAULT_BATCH_SIZE = 50;
const EXPECTED_DIM = 1536;

function argValue(name, fallback = null) {
  const prefix = `${name}=`;
  const found = process.argv.find((arg) => arg.startsWith(prefix));
  return found ? found.slice(prefix.length) : fallback;
}

function hasFlag(name) {
  return process.argv.includes(name);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function vectorLiteral(vector) {
  return `[${vector.map((v) => Number(v).toFixed(8)).join(",")}]`;
}

async function getEmbeddingConfig(connections, name, tenant) {
  const result = await connections.query(
    name,
    `
      SELECT coalesce(json_object_agg(key, value), '{}'::json) AS config
      FROM factory.factory_config
      WHERE tenant_id = $1 AND category = 'embedding'
    `,
    [tenant]
  );
  const raw = result.rows[0]?.config || {};
  return Object.fromEntries(
    Object.entries(raw).map(([key, value]) => {
      if (typeof value !== "string") return [key, value];
      try {
        return [key, JSON.parse(value)];
      } catch (_) {
        return [key, value];
      }
    })
  );
}

async function fetchRows(connections, name, tenant, tier, limit) {
  if (tier === "semantic_index") {
    return connections.query(
      name,
      `
        SELECT id, summary_text AS text
        FROM brain.semantic_index
        WHERE tenant_id = $1
          AND (embedding IS NULL OR embedding_stale = true)
        ORDER BY id
        LIMIT $2
      `,
      [tenant, limit]
    );
  }

  return connections.query(
    name,
    `
      SELECT id, content AS text
      FROM brain.document_chunks
      WHERE tenant_id = $1
        AND (embedding IS NULL OR embedding_stale = true)
      ORDER BY id
      LIMIT $2
    `,
    [tenant, limit]
  );
}

async function embedTexts(apiKey, model, texts) {
  const response = await fetch("https://api.openai.com/v1/embeddings", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ model, input: texts }),
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`embedding API failed: HTTP ${response.status} ${body.slice(0, 500)}`);
  }
  const data = await response.json();
  return data.data.sort((a, b) => a.index - b.index).map((item) => item.embedding);
}

async function writeEmbeddings(connections, name, tenant, tier, rows, vectors, model) {
  const table = tier === "semantic_index" ? "brain.semantic_index" : "brain.document_chunks";
  for (let i = 0; i < rows.length; i += 1) {
    const vector = vectors[i];
    if (!Array.isArray(vector) || vector.length !== EXPECTED_DIM) {
      throw new Error(`${tier} row ${rows[i].id}: expected ${EXPECTED_DIM} dimensions, got ${vector?.length || 0}`);
    }
    await connections.query(
      name,
      `
        UPDATE ${table}
        SET embedding = $1::vector,
            embedding_stale = false,
            model_version = $2,
            embedded_at = now()
        WHERE tenant_id = $3 AND id = $4
      `,
      [vectorLiteral(vector), model, tenant, rows[i].id]
    );
  }
}

async function embedTier(connections, name, tenant, tier, apiKey, model, limit) {
  const result = await fetchRows(connections, name, tenant, tier, limit);
  const rows = result.rows || [];
  if (rows.length === 0) return { tier, embedded: 0, remaining: 0 };

  const texts = rows.map((row) => String(row.text || "").slice(0, 8000));
  const vectors = await embedTexts(apiKey, model, texts);
  await writeEmbeddings(connections, name, tenant, tier, rows, vectors, model);

  const remainingResult = await fetchRows(connections, name, tenant, tier, 1);
  return { tier, embedded: rows.length, remaining: remainingResult.rows.length };
}

async function runOnce(connections, name, options) {
  const config = await getEmbeddingConfig(connections, name, options.tenant);
  const apiKey = config.openai_api_key || process.env.OPENAI_API_KEY;
  const model = config.openai_embedding_model || DEFAULT_MODEL;
  if (!apiKey) {
    throw new Error("No embedding API key found in factory.factory_config category='embedding' or OPENAI_API_KEY.");
  }

  const semantic = await embedTier(connections, name, options.tenant, "semantic_index", apiKey, model, options.batchSize);
  const chunks = await embedTier(connections, name, options.tenant, "document_chunks", apiKey, model, options.batchSize);
  return { model, semantic, chunks };
}

async function main() {
  const project = loadProjectContext();
  const connections = new ConnectionManager(loadConnections(), project);
  const name = argValue("--connection", connections.defaultName());
  const options = {
    tenant: argValue("--tenant", project.factory_id || DEFAULT_TENANT),
    batchSize: Number.parseInt(argValue("--batch-size", String(DEFAULT_BATCH_SIZE)), 10),
    intervalMs: Number.parseInt(argValue("--interval-ms", "60000"), 10),
    watch: hasFlag("--watch"),
  };

  if (!name) throw new Error("No O-Matic database connection configured.");
  if (!Number.isInteger(options.batchSize) || options.batchSize < 1 || options.batchSize > 500) {
    throw new Error("--batch-size must be an integer from 1 to 500.");
  }

  try {
    do {
      const result = await runOnce(connections, name, options);
      process.stdout.write(JSON.stringify({ ok: true, connection: name, tenant: options.tenant, ...result }) + "\n");
      if (options.watch) await sleep(options.intervalMs);
    } while (options.watch);
  } finally {
    await connections.shutdown();
  }
}

main().catch((error) => {
  process.stderr.write(`[omatic-embedder-worker] ${error.stack || error.message}\n`);
  process.exit(1);
});
