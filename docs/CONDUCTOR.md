# Conductor Design Goals

**Conductor** is the planned O-Matic service app for working locally, on the
LAN, on the tailnet, and through controlled remote HTTPS surfaces.

The app name is **Conductor**. The attribution is **from O-Matic**. Avoid
`O-Matic Conductor`, `o-MATIC Conductor`, and `TailRunner`.

Conductor is not just an MCP server. MCP is one service interface Conductor can
publish when a host needs tools.

## Blueprint 3 Goal

Blueprint 3 needs a service-delivery layer between AI hosts and private O-Matic
resources.

Conductor owns that layer:

- deliver O-Matic services to the local machine
- deliver services to the local subnet when allowed
- join the tailnet and publish private services there
- expose HTTPS where compliance requires it
- run embedding services
- connect to PGVector through controlled service paths
- expose health/status for humans and agents
- add MCP services as the host landscape stabilizes
- leave room for Siri/App Intents and Shortcuts integration

The center is controlled service routing. MCP is a surface, not the center.

## Product Model

| Name | Meaning |
|---|---|
| Conductor | the macOS app/service product |
| from O-Matic | attribution and brand line |
| Bridge | the service exposure layer |
| Sentry Mode | the access/security posture |
| Embedder | the embedding service |
| PGVector Service | controlled vector/search/database service |
| MCP Service | optional Streamable HTTP MCP tool surface |

## Problem

The marketplace plugins work well when the AI host can launch a local stdio
server and reach the same network as the factory database or embedding service.
That breaks down when:

- Claude Desktop, Codex, or another local host is sandboxed away from the LAN.
- A device is off the tailnet.
- Compliance requires HTTPS instead of raw local HTTP.
- Copilot, ChatGPT/OpenAI remote MCP, Gemini, or future hosts need a reachable
  HTTPS endpoint instead of a local process.
- Siri or Shortcuts needs app-owned actions rather than direct database/tool
  access.

## Design Feature In This Release

This release separates host packaging from network reachability.

- Claude and Codex keep using local plugin packages where that is the right fit.
- Project configuration and startup probes make local/tailnet failures visible
  instead of pretending the plugin can override host sandbox policy.
- Remote-host docs treat Copilot/Gemini/OpenAI-style usage as a separate HTTPS
  service target, not as a mutation of the local stdio plugin.
- Conductor is named as the app that should own local LAN, tailnet, HTTPS, and
  optional public remote access.

## Target Shape

Conductor should run as the network-facing service near the resources it owns:

- embedding app and embedding health
- local LAN access
- tailnet HTTPS access
- optional public or tunnelled HTTPS access for remote AI hosts
- Streamable HTTP MCP endpoint when tool hosts need MCP
- non-MCP HTTP endpoints for simple clients
- App Intents for Siri, Shortcuts, Spotlight, and Apple Intelligence surfaces
- admin/status endpoint for human and automation checks

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

Conductor should be able to appear on the tailnet as one or more named services,
for example:

- `conductor`
- `conductor-embed`
- `conductor-mcp`

Those names are deployment choices, not marketplace plugin IDs. The marketplace
should document how clients discover and select them, but Conductor owns the
network binding.

## PGVector Boundary

Conductor may become the thing that connects to PGVector, but not as a raw
database gateway.

Correct shape:

- uses controlled service accounts
- embeds text
- writes/searches vectors through approved APIs, stored functions, or narrow
  service endpoints
- returns health/status and search results
- hides database credentials from AI hosts and clients

Wrong shape:

- arbitrary SQL bridge for every caller
- broad database admin surface
- direct exposure of private databases to public remote AI services

## Siri And App Intents

Siri support is a Blueprint 3 opportunity, not a release claim.

Good first actions:

- start or stop Conductor
- show service status
- switch Sentry Mode
- turn tailnet publishing on or off
- check embedding health
- run a read-only memory search

Avoid first:

- unrestricted write actions
- direct SQL actions
- factory operations without confirmation

## Minimum Safety Gate

Do not enable `remote_https` without:

1. HTTPS.
2. Authentication.
3. Tool or endpoint allow-listing.
4. Audit logging.
5. Health/readiness endpoint.
6. Clear indication of whether traffic is local, LAN, tailnet, or public.

## What This Unblocks

- Claude Desktop can reach a local or tailnet Conductor even when the plugin
  server itself should stay simple.
- Codex can use project-pinned local plugin config or point at
  Conductor-backed services when network sandboxing gets in the way.
- Copilot becomes plausible through a managed HTTPS/MCP facade.
- Gemini and OpenAI remote MCP become plausible through the same Streamable HTTP
  surface, without forcing the marketplace plugins to become network daemons.
- Siri can eventually operate app-owned status/control actions through App
  Intents instead of touching private infrastructure directly.
