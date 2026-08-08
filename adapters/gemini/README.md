# Gemini Adapter

Gemini can use O-Matic in two different ways:

- Prompt-only: load selected `SKILL.md` files as system instructions.
- Remote MCP: connect Gemini API to a remote MCP server endpoint.

## Prompt-Only Use

Use `scripts/print-system-prompt.mjs` or the relevant plugin skill file. Prompt-only mode gives Gemini the behavior contract, but it does not provide O-Matic Server, WordPress, or Elementor tools.

## Remote MCP Use

Gemini Remote MCP expects a remote Streamable HTTP MCP endpoint. The Claude and Codex plugin manifests in this repo launch local stdio MCP servers, so they need a remote MCP bridge or hosted deployment before Gemini can call the tools.

Compatibility notes:

- Use snake_case MCP server names for Gemini remote MCP configurations.
- Keep the active tool set small. Prefer allow-listing the tools needed for the agent.
- Do not expose private factory databases or local subnet services directly to Gemini. Put the bridge inside the trusted network boundary and expose only the intended MCP endpoint.
- Start from `remote-mcp.example.json` after the hosted bridge exists. The example is not a deployment.

## Current Status

Gemini support is prompt export plus Remote MCP configuration shape. No hosted Streamable HTTP bridge is shipped in this repository yet.
