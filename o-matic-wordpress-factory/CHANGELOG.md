# Changelog

All notable changes to the O-Matic WordPress Factory plugin are documented here.

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
