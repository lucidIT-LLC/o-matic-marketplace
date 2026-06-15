# Codex Adapter

Codex uses the `.codex-plugin` manifests added to each plugin:

- Smith: `smith/.codex-plugin/plugin.json`
- Jo: `jo/.codex-plugin/plugin.json`
- Tim: `tim/.codex-plugin/plugin.json`
- Rimmer: `rimmer/.codex-plugin/plugin.json`

The Codex marketplace file is:

- `.agents/plugins/marketplace.json`

Each Codex plugin manifest points to its local `skills/` directory. The root `.agents/skills/` directory is also present for project-local copy workflows.

Install target names:

- `smith@lucidIT-LLC`
- `jo@lucidIT-LLC`
- `tim@lucidIT-LLC`
- `rimmer@lucidIT-LLC`

After marketplace/plugin updates, reinstall in Codex and start a fresh thread so skills are reloaded.
