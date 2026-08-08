# Gemini Project Context

This repository publishes the O-Matic marketplace: runtime MCP plugins,
canonical skill prompts, and adapter documentation for multiple AI hosts.

## How To Work Here

- Treat `AGENTS.md` as the operating guide for repository edits.
- Preserve version alignment. `marketplace.json` is canonical, and
  `scripts/version-sources.json` lists every file that must match.
- For runtime plugin changes, bump the affected plugin version and update its
  changelog.
- For prompt-only hosts, do not rewrite skill behavior in adapter files. The
  canonical prompt contract is each plugin's `skills/*/SKILL.md`.
- For Gemini Remote MCP, do not claim tool support unless there is a reachable
  Streamable HTTP MCP endpoint with snake_case server names and an allow-listed
  tool surface.

## Validation

Run:

```bash
node scripts/validate-json.mjs
node scripts/version-align.mjs
node scripts/sync-shared-skills.mjs --check
node scripts/verify-vendored-deps.mjs
npm run check --prefix omatic-server-connection
npm run check --prefix o-matic-wordpress-factory
```

Do not expose local factory databases, tailnet hosts, or credentials in examples.
