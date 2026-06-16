# Cowork / Desktop MCP Adapter

Cowork-style desktop hosts can run the same MCP server when they can launch a local stdio MCP process.

Use:

```text
node server/index.js
```

Provide one of:

- `OMATIC_FACTORY_JSON_PATH=/absolute/path/to/.omatic/factory.json`
- `OMATIC_PROJECT_ROOT=/absolute/project/root`
- Desktop extension connection env vars such as `OMATIC_CONNECTION_NAMES`, `OMATIC_CONNECTION_HOSTS`, and matching credential fields

Cowork does not consume Codex or Claude Code skill manifests directly. Install or paste the relevant `skills/*/SKILL.md` files separately if the host supports skill/prompt loading.
