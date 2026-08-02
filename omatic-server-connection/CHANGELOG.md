# Changelog

## Unreleased — 3.0 (P2: connections.js)

### Added
- **B1 — the factory selection now persists.** `omatic_select_factory` used to
  build a throwaway env object, so the choice died with the process and the
  operator had to re-select the same factory over and over in a single session.
  It now mutates `process.env`, and writes the choice to
  `${CLAUDE_PLUGIN_DATA}/factory-selection.json` — Claude Code's documented
  per-plugin persistent state directory — falling back to `OMATIC_STATE_DIR`,
  `XDG_STATE_HOME`, `~/.omatic/state`, then tmp. The selection is restored at
  startup, so pinning a project is a once-per-project act. Only paths are
  stored; no credentials reach the state file.
- **D9** — negotiated TLS is reported separately from configured intent.
  `ConnectionManager.tlsStatus()` / `describeConnections()` and
  `testConnection()` expose protocol, cipher and `authorized` read off the real
  `TLSSocket`, alongside the configured `ssl_mode`.
- Optional `ssl_root_cert` on a connection entry, supplying the CA bundle for
  `verify-ca` / `verify-full`.

### Fixed
- **B2** — project-root discovery no longer leans on `process.cwd()`, which on
  Codex *is* the plugin install directory. Plugin install paths are excluded
  outright instead of being reinstated by a fallback that returned the
  unfiltered candidate list when everything else was filtered out. `cwd` is now
  the last candidate and never a rescue path. Still no walk-up (rule #259).
- **B3** — a `${CODEX_WORKSPACE}`-derived root is bound at spawn and has been
  observed pointing at an entirely different project. Workspace-derived roots
  and pinned `factory.json` paths are now rejected unless the file actually
  exists, and always rank below the operator's persisted selection.
- **B4** — the unresolved-factory error named the wrong problem. It now lists
  every root tried in precedence order, why each was rejected, the no-walk-up
  rule, and the recovery call
  (`omatic_select_factory(project_root="…")`).
- **D7/D8 — sslmode now has real libpq semantics.** `pg` 8.20.0 does not
  implement them: without `uselibpqcompat`, `prefer`/`require`/`verify-ca` all
  collapse to `verify-full`, `allow` is unhandled, and there is no plaintext
  fallback — the server's `'N'` byte throws. All six modes are now mapped to
  explicit TLS options, with a negotiation ladder so `prefer` and `allow`
  genuinely fall back. The default when `sslmode` is absent is `prefer`.
  Factories that set `disable` explicitly are unaffected.

### Security
- **D5** — removed the `hostname.startsWith("100.") ? "disable" : "require"`
  heuristic from both sites. It silently disabled TLS based on a guess, and the
  guess was wrong on its own terms. **D6** — no network topology appears in
  code, defaults, or error messages; transport security is configuration, never
  inference.

### Removed
- **J2** — `ensureFactoryJsonFromEnv()`, which ran on every boot from
  `index.js`. No shipped manifest sets `OMATIC_DATABASE_URL` and no observed
  factory uses `database_url`, and it carried its own `process.cwd()` walk plus
  its own write-into-a-plugin-directory hazard. `OMATIC_DATABASE_URL` remains a
  live single-connection override in `loadConnections()`.

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
