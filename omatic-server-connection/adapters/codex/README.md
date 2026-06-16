# Codex Adapter

Codex uses:

- Plugin manifest: `.codex-plugin/plugin.json`
- MCP manifest: `.mcp.json`
- Server entrypoint: `server/index.js`
- Bundled skills: `skills/*/SKILL.md`

The bundled `.mcp.json` uses the `mcpServers` key:

```json
{
  "mcpServers": {
    "omatic-server-connection": {
      "command": "node",
      "args": ["${PLUGIN_ROOT}/server/index.js"]
    }
  }
}
```

Do not add `cwd: "${PLUGIN_ROOT}"` to this manifest. Some hosts expand
`${PLUGIN_ROOT}` in `args` but do not expand workspace variables in `env`.
Leaving cwd unset lets those hosts fall back to the connected project directory
when env-based project-root discovery is unavailable.

Do not confuse this bundle schema with Codex `config.toml`, where installed
plugin MCP servers are controlled under `plugins.<plugin-id>.mcp_servers`.

Install selector:

```text
omatic-server-connection@lucidIT-LLC
```

Full support requires a project `.omatic/factory.json` or a connection created with the plugin connection tools.

After updating the source plugin, reinstall from `@lucidIT-LLC` and start a fresh Codex thread so the MCP server and skill list reload.

Before reinstalling, run:

```bash
node scripts/smoke-codex-plugin.mjs
```
