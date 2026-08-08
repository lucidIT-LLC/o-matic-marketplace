# O-Matic Marketplace Agent Guide

This repository is the source catalog for O-Matic plugins across Claude Code,
Codex, prompt-only hosts, and future remote MCP hosts.

## Source Rules

- `marketplace.json` is the canonical plugin version source.
- `.claude-plugin/marketplace.json` and `.agents/plugins/marketplace.json` must
  match the root catalog.
- Every version-bearing plugin file must be declared in
  `scripts/version-sources.json`.
- Runtime plugin changes require a version bump and changelog entry for that
  plugin.
- Do not edit vendored `node_modules` by hand. Run the dependency check and
  commit the generated tree only when the lockfile intentionally changes.

## Validation

Run these before submitting changes:

```bash
node scripts/validate-json.mjs
node scripts/version-align.mjs
node scripts/sync-shared-skills.mjs --check
node scripts/verify-vendored-deps.mjs
npm run check --prefix omatic-server-connection
npm run check --prefix o-matic-wordpress-factory
```

## Host Targets

- Claude Code and Codex consume local stdio plugin packages.
- Copilot Studio and Gemini Remote MCP require a reachable Streamable HTTP MCP
  endpoint. The stdio manifests are not remote-host support.
- Gemini prompt-only usage consumes `SKILL.md` bodies or
  `scripts/print-system-prompt.mjs` output.
- Local subnet access is controlled by the host and runtime environment, not by
  plugin metadata.

## Safety

- Never commit factory credentials, `.omatic/factory.json`, application
  passwords, API keys, or local machine paths.
- Do not infer TLS policy from hostnames, IP ranges, tailnets, or local subnet
  assumptions. Use explicit `ssl_mode`; the default is `verify-full`.
- Preserve the tool/resource boundary: tools are actions, resources are
  read-only state.
