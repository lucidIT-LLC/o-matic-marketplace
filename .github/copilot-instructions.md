# Copilot Instructions

This repository is the O-Matic plugin marketplace. It ships Claude/Codex plugin
metadata, O-Matic runtime MCP servers, canonical skill prompts, and adapter docs
for other hosts.

Before changing files, read `AGENTS.md`.

Required behavior:

- Keep `marketplace.json`, `.claude-plugin/marketplace.json`, and
  `.agents/plugins/marketplace.json` aligned.
- Add any new version-bearing file to `scripts/version-sources.json`.
- Bump the affected plugin version and changelog when changing runtime code.
- Keep shared skills synchronized with `scripts/sync-shared-skills.mjs --check`.
- Do not duplicate skill behavior in adapter docs; link back to canonical
  `SKILL.md` files or prompt export scripts.
- Do not claim Copilot Studio or Gemini Remote MCP tool support unless the repo
  ships a Streamable HTTP MCP endpoint and validation.
- Do not infer TLS or local subnet policy from hostnames or IP ranges. The
  default `ssl_mode` is `verify-full`.

Use these checks before opening a pull request:

```bash
node scripts/validate-json.mjs
node scripts/version-align.mjs
node scripts/sync-shared-skills.mjs --check
node scripts/verify-vendored-deps.mjs
npm run check --prefix omatic-server-connection
npm run check --prefix o-matic-wordpress-factory
```
