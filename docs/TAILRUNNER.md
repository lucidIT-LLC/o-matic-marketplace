# TailRunner Design Note

TailRunner is the planned O-Matic runtime bridge for working both on and off the
tailnet. It is not just an MCP server. MCP is one interface TailRunner can
publish when a host needs tools.

## Problem

The marketplace plugins work well when the AI host can launch a local stdio
server and reach the same network as the factory database or embedding service.
That breaks down when:

- Claude Desktop, Codex, or another local host is sandboxed away from the LAN.
- A device is off the tailnet.
- Compliance requires HTTPS instead of a raw local HTTP service.
- Copilot, ChatGPT/OpenAI remote MCP, or Gemini needs a reachable HTTPS endpoint
  instead of a local process.

## Design Feature In This Release

This release separates host packaging from network reachability.

- Claude and Codex keep using local plugin packages where that is the right fit.
- Project configuration and startup probes make local and tailnet failures
  visible instead of pretending the plugin can override host sandbox policy.
- Remote-host docs now treat Copilot/Gemini/OpenAI-style usage as a separate
  HTTPS service target, not as a mutation of the local stdio plugin.
- TailRunner is named as the bridge that should own local LAN, tailnet, HTTPS,
  and optional public remote access.

## Target Shape

TailRunner should run as the network-facing service near the resources it owns:

- embedding app and embedding health
- local LAN access
- tailnet HTTPS access
- optional public or tunnelled HTTPS access for remote AI hosts
- Streamable HTTP MCP endpoint when tool hosts need MCP
- non-MCP HTTP endpoints for simple clients
- admin/status endpoint for human and automation checks

MCP is a surface, not the center. The center is controlled reachability.

## Access Modes

| Mode | Audience | Exposure | Intended hosts |
|---|---|---|---|
| `local_only` | same machine | loopback HTTP/stdio | Claude Desktop, Codex, local scripts |
| `lan_https` | local network | HTTPS on LAN | trusted household/office devices |
| `tailnet_https` | tailnet members/services | HTTPS through tailnet DNS/service identity | Claude/Codex on other devices, internal tools |
| `remote_https` | selected external AI services | public or tunnelled HTTPS with auth | Copilot, ChatGPT/OpenAI remote MCP, Gemini Remote MCP |

The default should be `local_only`. Every broader mode needs an explicit switch,
clear status, and a visible access URL.

## Tailnet Service Identity

TailRunner should be able to appear on the tailnet as one or more named
services, for example:

- `tailrunner`
- `tailrunner-embed`
- `tailrunner-mcp`

Those names are deployment choices, not marketplace plugin IDs. The marketplace
should document how clients discover and select them, but TailRunner owns the
network binding.

## Minimum Safety Gate

Do not enable `remote_https` without:

1. HTTPS.
2. Authentication.
3. Tool or endpoint allow-listing.
4. Audit logging.
5. Health/readiness endpoint.
6. Clear indication of whether traffic is local, LAN, tailnet, or public.

## What This Unblocks

- Claude Desktop can reach a local or tailnet TailRunner even when the plugin
  server itself should stay simple.
- Codex can use project-pinned local plugin config or point at TailRunner-backed
  services when network sandboxing gets in the way.
- Copilot becomes plausible through a managed HTTPS/MCP facade.
- Gemini and OpenAI remote MCP become plausible through the same Streamable HTTP
  surface, without forcing the marketplace plugins to become network daemons.
