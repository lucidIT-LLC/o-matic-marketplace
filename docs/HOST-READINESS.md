# Host Readiness

O-Matic packages support local hosts, tailnet/LAN runtime services, and remote
AI hosts. The packaging layer and the network reachability layer are separate.

## Local Stdio Hosts

Claude Code, Codex, and compatible local MCP hosts launch the packaged servers over stdio.

- `omatic-server-connection` exposes O-Matic Server tools.
- `o-matic-wordpress-factory` exposes WordPress and Elementor connector tools.
- Host sandboxing controls local subnet access. A plugin manifest cannot force Claude, Codex, or another host to allow private LAN, tailnet, or database routes.

For local subnet work, run the host or MCP server in an environment that can reach the subnet and set the project-local factory/profile config there. Do not encode private network assumptions in marketplace metadata.

## LAN And Tailnet Runtime Services

Conductor is the planned app and service bridge for working both on and off the
tailnet. It is not just an MCP server. It should host the embedding service,
health checks, simple HTTPS endpoints, and a Streamable HTTP MCP surface when a
tool host needs MCP.

This release documents Conductor as a design target so local and tailnet use
stop being treated as a plugin-install problem. Claude Desktop, Codex, and
possibly Copilot can all benefit from a stable HTTPS service on the LAN/tailnet:

- Claude Desktop and Codex can continue using local plugins while Conductor
  provides reachable network services.
- Copilot/Gemini/OpenAI-style hosts need an HTTPS endpoint and should use the
  same Conductor boundary when remote tool access is required.
- Tailnet service identity and public exposure are deployment switches, not
  plugin manifest fields.

See `docs/CONDUCTOR.md`.

## Remote MCP Hosts

Copilot Studio, Gemini Remote MCP, and OpenAI/ChatGPT remote MCP need a
reachable HTTPS endpoint rather than a local stdio command.

- Copilot Studio connects through MCP connectors governed by Power Platform policy.
- Gemini Remote MCP requires a Streamable HTTP MCP endpoint and should use snake_case server names.
- OpenAI/ChatGPT remote MCP can use a remote MCP endpoint, but a private
  tailnet-only hostname is not reachable unless a supported tunnel or public
  HTTPS exposure is configured.
- This repository currently ships stdio plugin packages, prompt exports, and remote-host configuration examples. A hosted Streamable HTTP bridge is a separate distribution target.
- Example remote host configs live at `adapters/copilot/openapi.mcp-streamable.example.yaml` and `adapters/gemini/remote-mcp.example.json`. They are templates only; `example.internal` must be replaced by a real hosted MCP endpoint inside the intended trust boundary.

Do not claim remote tool support until Conductor or another hosted bridge has:

1. Authentication.
2. A small allow-listed tool surface.
3. Network placement inside the trusted boundary.
4. A smoke test proving `tools/list` and one safe read-only call.
5. A dependency audit appropriate for an HTTP-exposed service.

## Release Rule

When a host grows from documentation-only to a shipped adapter, add:

1. A manifest or deployment example.
2. A validation or smoke check.
3. Version-source coverage if the new file carries a version.
4. A note in the relevant plugin `agent-pack.json`.
