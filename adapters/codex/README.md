# Codex Adapter

Codex uses the `.codex-plugin` manifests added to each plugin:

- Smith: `smith/.codex-plugin/plugin.json`
- Jo: `jo/.codex-plugin/plugin.json`
- Tim: `tim/.codex-plugin/plugin.json`
- Rimmer: `rimmer/.codex-plugin/plugin.json`
- O-Matic Server Connection: `omatic-server-connection/.codex-plugin/plugin.json`
- O-Matic WordPress Factory: `o-matic-wordpress-factory/.codex-plugin/plugin.json`

The Codex marketplace file is:

- `.agents/plugins/marketplace.json`

Each Codex plugin manifest points to its local `skills/` directory. The root `.agents/skills/` directory is also present for project-local copy workflows.

Install target names:

- `omatic-server-connection@o-matic-marketplace`
- `o-matic-wordpress-factory@o-matic-marketplace`
- `smith@o-matic-marketplace`
- `jo@o-matic-marketplace`
- `tim@o-matic-marketplace`
- `rimmer@o-matic-marketplace`

After marketplace/plugin updates, reinstall in Codex and start a fresh thread so skills are reloaded.

Local subnet access is a host policy, not a plugin manifest capability. Codex project configuration can point servers at local services and databases, but the host must permit that network path. Verify with the O-Matic startup packet and live connector probes after each reinstall.
