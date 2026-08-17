# O-Matic Factory Operations

The O-Matic factory **operating layer**, packaged as skills only.

| Skill | Role |
|---|---|
| `orch-o-matic-probot` | Probot — orchestrator. Plans, routes, runs factory startup, audits, session close. |
| `find-o-matic-fred` | Fred — storage, file custody, the session log, connection stewardship. |
| `data-o-matic-data` | Data — analyst and factory DBA. Schema integrity, retrieval health, embedding health. |
| `omatic-server-operating-guide` | How to operate an O-Matic Server project end to end. |

## Why this pack exists

These four are **constitutive**: remove them and what remains is a Postgres
database behind a credential broker — no startup lifecycle, no session that
survives, no assurance that memory works. Not a degraded factory; not a factory.

They previously shipped inside `omatic-server-connection`, which declares an
`mcpServers` block. **Hosted-marketplace hosts install only plugins that declare
no MCP server**, so on those hosts the operating layer was unreachable — the
skills were trapped beside a server they no longer needed.

Measured 2026-08-15 (Cowork) and again 2026-08-17 (Claude Code desktop): the
host installs every skill-only pack in the catalog and omits precisely the two
that declare `mcpServers`. The partition is exact and survives reinstallation;
repairing marketplace configuration changes nothing, because the fault is
packaging.

**This pack therefore declares no MCP server, and never will.** That is its
entire reason for existing.

## What it needs

**Conductor**, this device's credential broker, registered in *this host's own*
MCP config. Conductor holds every database password in the macOS Keychain and
runs SQL on your behalf: `connections_list`, `factory_query`, `embed_query`.
The credential never enters the conversation.

Registering Conductor for one surface of an app does **not** carry it to another.
Claude Code reads `~/.claude.json`; the Claude desktop app — and therefore Cowork
— reads `claude_desktop_config.json`. A working registration in one left the
other blind for a day (2026-08-16).

## What it does not need

No plugin. No `.omatic/factory.json`. No local file resolution of any kind.
**Factory identity is declared by the database packet** — `v_startup_card.factory_id`,
corroborated by `current_database()` and `tenant_id` — never resolved from disk.
A host with no pin is fully compliant.

Authority: decision **#334**, active halt-rule **#288**, **SOP-021 Step 1**, and
the Blueprint non-negotiable that no host-specific config or manifest is
governance authority.

## Honest limits

- **The roster is unpackaged on restricted hosts.** Brandy, Carver and Monet ship
  in `o-matic-wordpress-factory`, which also declares an MCP server and also does
  not install there. Report the roster state honestly rather than reading the
  card's `roster_ready` — that column counts Agreements in the database, not what
  is installed in front of you.
- **This pack does not replace `omatic-server-connection`.** On hosts that *can*
  run a local MCP server, that plugin still provides factory resolution as
  routing convenience. Both may be installed; nothing here depends on it.
- **If Conductor is absent, the correct answer is BLOCKED**, named as a host
  pairing gap — not a factory failure, and never a startup card assembled from
  remembered text.

---

Part of the [O-Matic marketplace](https://github.com/lucidIT-LLC/o-matic-marketplace) ·
[o-matic.ai](https://o-matic.ai)
