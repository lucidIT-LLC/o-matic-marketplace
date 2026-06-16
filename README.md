# O-Matic Marketplace

The single catalog for every O-Matic plugin. **The o-matic.ai marketplace.**

Owned by lucidIT-LLC. Marketplace name: `o-matic.ai` (verified accepted by Claude Code v2.1.114; the docs recommend kebab-case, but dotted names install and resolve).

## Add it

```
claude plugin marketplace add lucidIT-LLC/o-matic-marketplace
```

> A domain add (`https://o-matic.ai/marketplace.json`) lands once the o-matic.ai site migration completes (task #103). The web-root file is staged at `marketplace.json`.

## Install any plugin

```
claude plugin install omatic-server-connection@o-matic.ai
claude plugin install smith@o-matic.ai
claude plugin install jo@o-matic.ai
claude plugin install tim@o-matic.ai
claude plugin install rimmer@o-matic.ai
claude plugin install o-matic-wordpress-factory@o-matic.ai
```

## What's in the catalog

This catalog **hosts** the standalone O-Matic skills directly, and **references** the two bundled-product plugins from their own repos (each keeps its own release cadence):

| Plugin | Lives | Ships |
|---|---|---|
| `smith` | here (`./smith`) | Critical Analyst |
| `jo` | here (`./jo`) — canonical | Writing Coach |
| `tim` | here (`./tim`) | Tool Optimizer |
| `rimmer` | here (`./rimmer`) | Agent Evaluator |
| `omatic-server-connection` | here (`./omatic-server-connection`) | MCP server + Probot, Fred, Data |
| `o-matic-wordpress-factory` | here (`./o-matic-wordpress-factory`) | Brandy, Carver, Monet, Jo + WP/Elementor connectors |

**Self-contained:** every plugin lives in this one repo (no external git-subdir references). The former standalone `o-matic-consulting-pack`, `o-matic-server-connection`, and `o-matic-wordpress-factory` repos are retired — all of it now lives here, under the one O-Matic marketplace. (The Docker server image is distributed separately at `lucidIT-LLC/o-matic-server-container` — it's infra, not a plugin.)

## Shared skills

`jo` ships here (canonical) and is also bundled in the WordPress Factory. `scripts/sync-shared-skills.mjs` keeps the bundled copies byte-identical to canonical (run with `--check` in CI). Host-neutral adapters (Codex, Gemini, Ollama, generic) and the canonical `agent-pack.json` live alongside for non-Claude hosts.

Catalog manifests: `.claude-plugin/marketplace.json` (Claude Code) and `.agents/plugins/marketplace.json` (Codex parity).
