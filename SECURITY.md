# Security Policy

## Reporting a vulnerability

Report suspected vulnerabilities privately to **security@o-matic.ai**, or through
[GitHub private vulnerability reporting](https://github.com/lucidIT-LLC/o-matic-marketplace/security/advisories/new).

Do not open a public issue for a security defect. Public issues are appropriate
after a fix has shipped, not before.

Include what you need to make the report actionable: the affected plugin and
version, what an attacker gains, and the steps to reproduce. A proof of concept
is welcome and never required.

**Acknowledgement:** within 3 business days.
**Assessment and remediation plan:** within 10 business days.
**Fix or documented mitigation:** severity-dependent, communicated in the plan.

## Supported versions

Only the current release of each plugin, as listed in
[`.claude-plugin/marketplace.json`](.claude-plugin/marketplace.json), receives
security fixes. Older versions are not patched; upgrade instead.

## What this repository ships

`omatic-server-connection` connects an MCP host to PostgreSQL databases and
executes SQL against them. Treat it as a privileged component. Two properties
matter most to anyone assessing it:

- **Connection credentials never live in this repository.** They are read at
  runtime from a workspace-local `.omatic/factory.json`, which is not tracked
  here and must not be committed to any repository.
- **Per-connection permissions are enforced at the tool layer**, before any
  handler runs and before any pool opens. `read_only` refuses every write, DDL
  and DML; `disabled` refuses everything. There is no argument, flag or alias
  that bypasses it, and an unclassified tool is treated as a write — the guard
  fails closed.

## Vendored dependencies

The runtime is vendored: no host runs an install step at plugin install, so the
committed `node_modules` tree is what ships. Two consequences follow, and both
are deliberate:

- The dependency set is fixed at vendor time. A transitive advisory published
  afterwards applies to this repository until the tree is refreshed.
- Every vendored package is redistributed here, and is inventoried in
  [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).

`scripts/verify-vendored-deps.mjs` fails CI if the committed tree drifts from the
lockfile. Dependency advisories are triaged against the pinned version rather
than the advisory's headline severity: an alert whose patched range the pin
already satisfies is closed as inaccurate, with the comparison recorded on the
alert.

## Scope

In scope: the plugin runtime under `omatic-server-connection/server/`, the
launcher in `omatic-server-connection/bin/`, the marketplace catalog, and the
plugin manifests.

Out of scope: vulnerabilities in a host application (Claude Code, Claude
Desktop, Codex), in PostgreSQL, or in an operator's own factory database
configuration. Report those to their respective maintainers.
