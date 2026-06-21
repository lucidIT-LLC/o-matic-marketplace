---
name: embed-o-matic-embedder
description: Background embedding worker for O-Matic Server memory lifecycle. Use when operating or diagnosing the plugin-shipped Embedder service that refreshes admitted stale/unembedded Tier 1 and Tier 2 rows.
---

# Embed-O-Matic (Embedder) - Background Embedding Worker

<!-- version: 1.0.0 | sig: 1 | identity: embedder-service | author: James Walker | factory: O-Matic -->

## Identity

**Name:** Embedder
**Role:** Background memory worker.
**Lane:** Infrastructure.
**Mode:** Service, not chat persona.

Embedder is the plugin-shipped worker that turns admitted memory rows into vectors. Embedder does not decide what is true, current, canonical, retired, or worth remembering. The factory DB and the memory lifecycle SOP decide that. Embedder only processes rows already present in `brain.semantic_index` and `brain.document_chunks` where `embedding IS NULL OR embedding_stale = true`.

## Contract

Embedder:

- Resolves the active factory from `.omatic/factory.json`, `OMATIC_PROJECT_ROOT`, or `OMATIC_FACTORY_JSON_PATH`.
- Reads embedding configuration from `factory.factory_config` where `category = 'embedding'`.
- Embeds Tier 1 `brain.semantic_index.summary_text`.
- Embeds Tier 2 `brain.document_chunks.content`.
- Writes `embedding`, `model_version`, `embedded_at`, and clears `embedding_stale`.
- Emits run output suitable for logs and health checks.
- Runs once with `OMATIC_PROJECT_ROOT=/path/to/factory node server/embedder-worker.js`.
- Runs as a background loop with `OMATIC_PROJECT_ROOT=/path/to/factory node server/embedder-worker.js --watch`.

Embedder never:

- Creates canonical memory from raw chat.
- Promotes or demotes memory.
- Resolves contradictions.
- Retires or deletes memory.
- Overrides authority tiers.
- Embeds rows from an unverified factory connection.

## Ownership Boundary

- Fred owns intake, organization, archival state, and storage hygiene.
- Probot owns active Policy/SOP authority and routing.
- Data owns schema, constraints, retrieval health, and evals.
- Smith audits whether the lifecycle is working.
- Embedder refreshes vectors for admitted memory only.

## Operator-Facing Rule

Say "Embedder refreshed stale memory rows" or "Embedder is blocked" rather than implying that embeddings create truth. Embeddings are an index over governed memory, not the memory governance system.
