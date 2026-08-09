# Compliance posture

> **Status:** baseline established 2026-08-08. This document is the control
> register for `o-matic-marketplace`. It records what is implemented, what is
> not, and who owns the gap. It is written to be handed to an assessor as-is.
>
> **It is deliberately honest about open findings.** A control register that
> lists only satisfied controls is not evidence, it is marketing.

## Scope

This register covers the `o-matic-marketplace` repository and the plugins it
distributes — in particular `omatic-server-connection`, which opens PostgreSQL
connections and executes SQL on an operator's behalf.

It does **not** cover the O-Matic Server database deployment, the host
applications (Claude Code, Claude Desktop, Codex), or any operator's own factory
configuration. Those are separate systems with separate registers.

### Why this repository is in scope for healthcare frameworks

`omatic-server-connection` is the access path to factory databases, at least one
of which belongs to a healthcare client. The repository does not store, process
or transmit PHI itself, and no PHI is committed here. It is in scope because it
ships the software that reaches systems that do — a supply-chain dependency of a
Business Associate obligation, not a covered system.

## Framework mapping

Control identifiers are given for SOC 2 (2017 TSC), HIPAA Security Rule
(45 CFR §164), and HITRUST CSF v11 where a clean mapping exists.

| # | Control | SOC 2 | HIPAA | HITRUST | Status | Owner |
|---|---|---|---|---|---|---|
| 1 | Change management: reviewed, approved changes to the default branch | CC8.1 | §164.308(a)(1)(ii)(D) | 06.g | **OPEN** — no branch protection on `stable`; force-push permitted; no required review | Operator |
| 2 | Secret detection in source control | CC6.1 | §164.312(a)(1) | 01.c | **OPEN** — secret scanning and push protection disabled | Operator |
| 3 | Confidentiality of client identity in public artefacts | CC6.7, C1.1 | §164.502(a) | 13.j | **PARTIAL** — client name removed from published documentation; test fixtures still reference it | Carver |
| 4 | Audit-log content control: no PHI in telemetry | CC7.2 | §164.312(b), §164.502(b) | 09.aa | **OPEN — owner moved** — the plugin no longer writes retrieval telemetry: `omatic_search_memory`, which called `fn_record_retrieval_event` on every invocation, was deleted in omatic-server-connection 5.0.0. The retained rows and the absence of redaction or retention limits are unchanged, and any caller now reaching `fn_search_*` directly may still record. Re-scope against Conductor before claiming improvement. | Data / Carver |
| 5 | Credential protection at rest | CC6.1 | §164.312(a)(2)(iv) | 01.b | **OPEN — reduced, not closed** — omatic-server-connection 5.0.0 removed all credential handling from the plugin: it no longer reads, writes or holds a password, `writeFactoryConfig` is deleted, and the `pg` driver is gone. But 13 plaintext passwords across 5 factories' `.omatic/factory.json` remain **on disk** (measured 2026-08-09; O-Matic is at zero). Nothing reads them now, which makes them liability without function. Closes only when those factories move to Conductor (task #245) and the files are cleared. | Carver |
| 6 | Documented security policy and defined ownership | CC1.2, CC2.2 | §164.316(a) | 04.a | **MET** — `SECURITY.md`, `CODEOWNERS`, this register | Operator |
| 7 | Software licensing and third-party attribution | CC1.4 | — | 09.s | **MET** — `LICENSE`, `license` in all 12 plugin manifests, generated `THIRD-PARTY-NOTICES.md` | Operator |
| 8 | Encryption in transit | CC6.7 | §164.312(e)(1) | 09.y | **MET — evidence moved to Conductor** — the plugin's TLS negotiation ladder was deleted with its database client in 5.0.0, so `ssl_mode` is no longer enforced or reported there. Transport policy is now Conductor's, on credentials it holds in the Keychain. Two factories (Career) still declare `ssl_mode=disable` in their own `factory.json`; that is now inert config, not an active plaintext connection. Re-evidence against Conductor. | Carver |
| 9 | Least privilege / access enforcement | CC6.3 | §164.312(a)(1) | 01.c | **MET — evidence moved to Conductor** — the plugin's per-connection `read_write` / `read_only` / `disabled` chokepoint was deleted with the tools it guarded in 5.0.0. Enforcement is now Conductor's per-app grant plus the six confined LLM database roles from task #179, both of which sit below the caller rather than inside it. A grant refusal is a refusal, never an empty result. | Carver |
| 10 | Supply-chain integrity: shipped runtime matches its lockfile | CC7.1 | — | 09.j | **MET** — `scripts/verify-vendored-deps.mjs` runs `npm ci` and fails CI on drift | Carver |
| 11 | Vulnerability identification and triage | CC7.1 | §164.308(a)(1)(ii)(A) | 10.m | **PARTIAL** — Dependabot alerts enabled and triaged against pinned versions with the comparison recorded; no scheduled dependency refresh | Carver |
| 12 | Release integrity: version metadata agrees across all sources | CC8.1 | — | 09.j | **MET** — `scripts/version-align.mjs` gates CI | Carver |

## Open findings

Recorded 2026-08-08 from an adversarial review. Each maps to a row above.

### Critical

**No branch protection on `stable`** (control 1). The default branch that every
operator installs from accepts direct pushes and force-pushes, requires no
review and no passing checks. There is no change-control evidence to produce.
*Remediation:* require review and the `smoke`, `vendored-deps` and
`version-align` checks; disable force-push. Decide deliberately whether
`enforce_admins` is on — for a single-maintainer repository it changes the
maintainer's own workflow.

**Secret scanning disabled** (control 2). Public repository with secret scanning,
push protection, validity checks and non-provider patterns all off. A scan on
2026-08-08 found no committed credential; that is discipline, not control.

**Client identity published** (control 3). Resolved in documentation. The test
fixtures that carried the client name lived in
`omatic-server-connection/scripts/smoke-startup-modes.mjs`, which was **deleted**
in 5.0.0 along with the database surface it exercised; its replacement,
`scripts/smoke-tool-surface.mjs`, does not reference the client name. Re-verify
on the next audit rather than assuming this closed cleanly.

### High

**Query text persisted without limit** (control 4). Until 5.0.0,
`omatic_search_memory` wrote the operator's raw query into
`factory.retrieval_events` on every call. That tool is now deleted, so the plugin
is no longer a writer — but the retained rows persist and the underlying
functions are still reachable through Conductor. As of
2026-08-08: 86 events retained from 2026-06-03, no TTL, no redaction. A search
containing PHI is written to a permanent table. Complicated by
`factory.retrieval_eval_cases`, which also stores query text and depends on it
for eval replay — blanket redaction would break evals, so redaction strategy and
retention window need designing together.

**Credentials in plaintext at rest** (control 5). Five credentials, including a
superuser, in `.omatic/factory.json`. Mode 0600 and gitignored; never committed.
Migrating to OS keychain or a secret manager touches connection resolution on
every startup across three hosts and must preserve the degraded-mode fallback.

**No scheduled dependency refresh** (control 11). `verify-vendored-deps.mjs`
prevents drift from the lockfile but nothing advances the lockfile, so a
transitive advisory published after the last vendor persists until someone acts.

## Evidence an assessor can pull directly

| Claim | Where to verify |
|---|---|
| Changes gated by automated checks | `.github/workflows/` — `smoke`, `vendored-deps`, `version-align`; run history on every PR |
| Shipped runtime matches its lockfile | `node scripts/verify-vendored-deps.mjs` |
| Version metadata consistent across all sources | `node scripts/version-align.mjs` |
| Third-party inventory current | `node scripts/gen-third-party-notices.mjs --check` |
| Transport encryption enforced | Conductor's connection profiles; the plugin no longer opens connections and reports no TLS |
| Access enforcement is real, not advisory | Conductor's per-app grants and the confined LLM roles (task #179). The plugin's own chokepoint was removed in 5.0.0 along with its database client. |
| No credentials in source | `git log --all -- .omatic/` is empty and no `factory.json` appears in any commit; `.gitignore` denies `.omatic/` and `*.env` |

## Review cadence

This register is reviewed when a control changes state, when a finding is opened
or closed, and at minimum quarterly. Changes to it require review under
`CODEOWNERS`.
