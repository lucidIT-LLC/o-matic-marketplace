# Changelog

All notable changes to the O-Matic WordPress Factory plugin are documented here.

## 1.1.1 — 2026-08-02

### Fixed
- **Codex operators were shown version 1.0.2 while the catalog said 1.1.0.**
  `.codex-plugin/plugin.json` and `agent-pack.json` were never bumped with the
  1.1.0 release, and the rule #287 alignment gate reported `aligned ✅` because
  neither file was declared in `scripts/version-sources.json` — a gate only
  checks what someone remembered to list. The Codex plugin page read 1.0.2
  accurately; the metadata was wrong, not the display. Both files now carry the
  real version, and all six version sources agree.

### Changed
- **The alignment gate now fails on undeclared version sources (check `g`).** Any
  file matching a well-known manifest name that carries a `version` key but is
  absent from `version-sources.json` is a hard failure. This is what closes the
  hole rather than the value: four other plugins carried an undeclared
  `.codex-plugin/plugin.json` that happened to be correct, which is luck, not a
  control. All are now declared.

## 1.0.1 — 2026-06-15

### Fixed
- **MCP protocol version handshake.** The WordPress and Elementor connectors
  announced MCP protocol version `2025-03-26`, which current WordPress/Elementor
  MCP adapters reject with `HTTP 400 Unsupported protocol version` (supported:
  `2025-11-25`, `2025-06-18`, `2024-11-05`). Forwarded `wp__` / `elementor__`
  tools could not enumerate as a result; REST authentication was unaffected.
  The default is now `2025-06-18`, a server-supported revision. Changed in:
  - `server/lib/mcp-connector.mjs` — `DEFAULT_PROTOCOL_VERSION`
  - `.claude-plugin/plugin.json` — `MCP_PROTOCOL_VERSION` env for both connectors
  - `MCP_PROTOCOL_VERSION` env still overrides the default for site-specific needs.

## 1.0.0

- Initial release: bundled brand, build, writing, and visual skills plus
  configurable WordPress and Elementor MCP connectors.
