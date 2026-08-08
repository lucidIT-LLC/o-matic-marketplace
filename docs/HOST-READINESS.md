# Host Readiness

O-Matic packages support two host families.

## Local Stdio Hosts

Claude Code, Codex, and compatible local MCP hosts launch the packaged servers over stdio.

- `omatic-server-connection` exposes O-Matic Server tools.
- `o-matic-wordpress-factory` exposes WordPress and Elementor connector tools.
- Host sandboxing controls local subnet access. A plugin manifest cannot force Claude, Codex, or another host to allow private LAN, tailnet, or database routes.

For local subnet work, run the host or MCP server in an environment that can reach the subnet and set the project-local factory/profile config there. Do not encode private network assumptions in marketplace metadata.

## Remote MCP Hosts

Copilot Studio and Gemini Remote MCP need a reachable remote MCP endpoint rather than a local stdio command.

- Copilot Studio connects through MCP connectors governed by Power Platform policy.
- Gemini Remote MCP requires a Streamable HTTP MCP endpoint and should use snake_case server names.
- This repository currently ships stdio plugin packages and adapter documentation. A hosted Streamable HTTP bridge is a separate distribution target.

## Release Rule

When a host grows from documentation-only to a shipped adapter, add:

1. A manifest or deployment example.
2. A validation or smoke check.
3. Version-source coverage if the new file carries a version.
4. A note in the relevant plugin `agent-pack.json`.
