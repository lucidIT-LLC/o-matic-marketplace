# Adapter Guide

`agent-pack.json` is the host-neutral manifest. Each skill's `SKILL.md` is the canonical behavior contract.

Adapters are thin host packaging layers:

- `claude/` explains Claude marketplace and skill loading.
- `codex/` explains Codex plugin and `.agents/skills` loading.
- `copilot/` explains Microsoft Copilot Studio MCP readiness and current packaging limits.
- `gemini/` explains Gemini Remote MCP readiness and current packaging limits.
- `google/` explains Gemini / Google AI Studio / Gems prompt-only usage.
- `ollama/` explains local Modelfile usage.
- `generic/` explains any chat runtime that accepts a system prompt.

Do not fork persona behavior in adapter files. If Smith, Jo, Tim, or Rimmer behavior changes, update the canonical `SKILL.md` first, then regenerate or validate adapters.
