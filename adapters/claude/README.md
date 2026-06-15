# Claude Adapter

Claude uses the existing `.claude-plugin` manifests:

- Marketplace: `.claude-plugin/marketplace.json`
- Smith: `smith/.claude-plugin/plugin.json`
- Jo: `jo/.claude-plugin/plugin.json`
- Tim: `tim/.claude-plugin/plugin.json`
- Rimmer: `rimmer/.claude-plugin/plugin.json`

Canonical prompts remain in:

- `smith/skills/smith/SKILL.md`
- `jo/skills/jo/SKILL.md`
- `tim/skills/tim/SKILL.md`
- `rimmer/skills/rimmer/SKILL.md`

Claude Code and Claude desktop marketplace installs should load from those plugin directories. Do not copy behavior into the manifest; the manifest is packaging metadata only.
