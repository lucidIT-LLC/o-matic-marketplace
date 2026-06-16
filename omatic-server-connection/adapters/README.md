# O-Matic Server Connection Adapters

`agent-pack.json` is the host-neutral manifest.

This package has two layers:

- MCP tool layer: `server/index.js`, launched by Codex, Claude Code, or another MCP-capable host.
- Skill prompt layer: `skills/*/SKILL.md`, usable as system/developer instructions in any model host.

Full factory operation requires the MCP tool layer. Prompt-only hosts can use the skills for planning, review, and context-aware behavior, but they cannot read or write the factory database unless the host provides an MCP bridge or equivalent tools.

Adapters:

- `codex/` explains Codex plugin and MCP loading.
- `claude/` explains Claude Code plugin loading.
- `cowork/` explains desktop MCP configuration.
- `google/` explains Gemini / Google AI Studio prompt-only use.
- `ollama/` explains Modelfile prompt-only use.
- `generic/` explains any system-prompt runtime.
