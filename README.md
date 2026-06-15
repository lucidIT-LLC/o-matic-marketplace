# O-Matic Marketplace

The single catalog for every O-Matic plugin. **The o-matic.ai marketplace.**

Owned by lucidIT-LLC. Marketplace name: `o-matic-ai` (Claude Code marketplace names must be kebab-case — no dots).

## Add it

```
claude plugin marketplace add lucidIT-LLC/o-matic-marketplace
```

> A domain add (`https://o-matic.ai/marketplace.json`) lands once the o-matic.ai site migration completes (task #103). The web-root file is staged at `marketplace.json`.

## Install any plugin

```
claude plugin install omatic-server-connection@o-matic-ai
claude plugin install smith@o-matic-ai
claude plugin install jo@o-matic-ai
claude plugin install tim@o-matic-ai
claude plugin install rimmer@o-matic-ai
claude plugin install o-matic-wordpress-factory@o-matic-ai
```

## What's in the catalog

This catalog **hosts** the standalone O-Matic skills directly, and **references** the two bundled-product plugins from their own repos (each keeps its own release cadence):

| Plugin | Lives | Ships |
|---|---|---|
| `smith` | here (`./smith`) | Critical Analyst |
| `jo` | here (`./jo`) — canonical | Writing Coach |
| `tim` | here (`./tim`) | Tool Optimizer |
| `rimmer` | here (`./rimmer`) | Agent Evaluator |
| `omatic-server-connection` | ref → `lucidIT-LLC/o-matic-server-connection` | MCP server + Probot, Fred, Data |
| `o-matic-wordpress-factory` | ref → `lucidIT-LLC/o-matic-wordpress-factory` | Brandy, Carver, Monet, Jo + WP/Elementor connectors |

The former standalone `o-matic-consulting-pack` marketplace is retired — its plugins (smith, jo, tim, rimmer) now live here, under the one O-Matic marketplace.

## Shared skills

`jo` ships here (canonical) and is also bundled in the WordPress Factory. `scripts/sync-shared-skills.mjs` keeps the bundled copies byte-identical to canonical (run with `--check` in CI). Host-neutral adapters (Codex, Gemini, Ollama, generic) and the canonical `agent-pack.json` live alongside for non-Claude hosts.

Catalog manifests: `.claude-plugin/marketplace.json` (Claude Code) and `.agents/plugins/marketplace.json` (Codex parity).
