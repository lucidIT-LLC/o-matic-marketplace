# Microsoft Copilot Adapter

Microsoft Copilot Studio consumes O-Matic tools through MCP connectors, not through the Claude or Codex plugin manifests.

## Support Model

- Full tool use requires a reachable MCP server exposed over a transport Copilot Studio can connect to through Power Platform connector policy.
- The packaged Claude/Codex stdio commands are not themselves enough for Copilot Studio. Publish or proxy the O-Matic MCP server as a managed MCP endpoint before adding it to an agent.
- Copilot Studio can selectively enable or disable tools from an MCP server after connection.
- Local subnet access is controlled by the hosting environment, Power Platform connector policy, and network routing. The marketplace package must not assume that private LAN or tailnet hosts are reachable.

## Recommended Shape

1. Run the O-Matic MCP server close to the target network when it needs private subnet, tailnet, or database access.
2. Expose only the intended MCP endpoint to Copilot Studio.
3. Keep per-factory credentials in the deployment environment or factory config, not in this repo.
4. Add the MCP connector to the Copilot Studio agent and disable tools the agent should not use.

## Current Status

Copilot support is adapter-ready documentation only. No hosted Copilot connector package is shipped in this repository yet.
