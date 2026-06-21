# Changelog

## 2.1.7 - 2026-06-21

### Fixed
- Claude Code marketplace distribution metadata now explicitly includes
  Embedder in marketplace/plugin descriptions.
- Release is tagged as `omatic-server-connection-v2.1.7` so marketplace
  updaters that rely on Git tags can detect the new plugin release.

## 2.1.6 - 2026-06-21

### Added
- `server/embedder-worker.js`, a plugin-shipped background worker for admitted
  stale/unembedded Tier 1 `brain.semantic_index` and Tier 2
  `brain.document_chunks` rows.
- Embedder skill contract, making embeddings an operational service over
  governed memory rather than a truth/admission layer.

## 2.1.5 — 2026-06-15

### Fixed
- `omatic_record_decision` failed with a NOT NULL violation on `category` and
  `title` (both required by the `decisions` table, no DB default). The tool now
  accepts optional `category` (default `general`) and `title` (default: a
  truncation of `decision`), sets `decision_date = CURRENT_DATE`, and maps the
  `owner` arg to `made_by`. Clarified that the `decisions` table has no `status`
  column — the `status` param is accepted for compatibility and ignored.

## 2.1.4

- Prior release.
