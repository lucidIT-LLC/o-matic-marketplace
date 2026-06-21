# Factory 3.0 — Beta Framework

> **Branch:** `beta` (integration line). Features land here; `stable` fast-forwards from
> `beta` only after a green pass. Do not merge to `stable` until a workstream's acceptance
> checks pass.
>
> **Status:** Pre-release. Baseline cut from `stable`/`main` @ release 2.1.7.
> **Owner of this framework:** Probot (orchestration). Component builds route to the owners below.
>
> **Source of truth:** the factory brain. This file is the *organizing spine* — it points at
> the canonical records, it does not replace them.
> - Commons doc #55 `factory-3-0-functional-updates` (adopted pre-3.0 behaviors)
> - project_knowledge #71 + decision #156 (startup modes)
> - Tasks #110–#114 (3.0 spec workstreams)
> - decisions #77/#78/#89 (plugin-gateway + Path B lineage)

---

## Claims boundary (carried from Factory 2.0 stable — decision #181)

3.0 is **beta**. Until the memory-architecture bakeoff (task #118) runs and produces evidence,
the forbidden claims still apply: no "proven better than Mem0/Azure/Cloudflare," no
"leading-edge adaptive conversational memory," no benchmarked-superiority language — in code
comments, READMEs, onboarding copy, or marketing. Allowed: governed operating memory,
pgvector-backed retrieval with lifecycle governance, auditable operating context.

---

## Workstreams

| # | Workstream | Owner | Source | Type | State |
|---|-----------|-------|--------|------|-------|
| A | Probot — SOP/Policy Guardian | Probot | commons #55 | behavior/governance | **adopted (live pre-3.0)** — fold into baseline |
| B | Fred — New-Customer Files-Folder Check | Fred | commons #55 | behavior/governance | **adopted (live pre-3.0)** — fold into baseline |
| C | Startup modes — fast wake / normal / audit | Probot | pk #71, dec #156, task #113 | runner build | spec ready → build |
| D | O-Matic WordPress Factory plugin scaffold | Carver | task #114 | plugin build | spec ready → build |
| E | O-Matic Elementor cross-platform plugin | Carver | task #112, dec #77/#78 | plugin build | spec ready → build |
| F | Fred file intake without Docling | Fred | task #111 | infra | spec → design |
| G | Fred L2 Session-Rhythm continuity | Fred | task #110 | infra | spec → design |

---

## A — Probot: Guardian of SOPs & Policies  *(adopted; live pre-3.0)*

Probot owns the integrity of the rulebook. Three duties:

1. **Keep every SOP and Policy understandable.**
2. **Prevent duplication** — consolidate or cross-reference; never let copies drift.
3. **Detect conflicts** — when an incoming change would contradict an existing SOP/Policy,
   Probot does **not** auto-resolve. He stops, names the conflict, and asks the operator how
   to correct it.
4. **Deliver on the manifest** — Probot is accountable for the factory actually delivering on
   its manifest, not merely directing other agents.

**Trigger:** any SOP/Policy create or update, and any orchestration pass. On conflict → halt + escalate.

**Fold-in for 3.0:** promote this from "adopted behavior" to a Policy/Agreement rule in the
omatic-server-connection Probot skill + brain, so it loads at startup like any governed rule.
**Acceptance:** a deliberately conflicting SOP edit triggers a raise-hand/escalate, not a silent overwrite.

## B — Fred: New-Customer Files-Folder Check  *(adopted; live pre-3.0)*

This workspace runs on **files, not quotes** — the trigger is a new customer's first files
arriving, not a quote object.

**Trigger:** any time the first files for a new customer land in the workspace.
**Behavior:** Fred confirms the customer already has a folder. If none exists or the setup
looks incomplete, Fred asks the operator whether to create one before filing anything, and
sets it up on a yes. Standing rule — every new customer's files get this check.

**Fold-in for 3.0:** encode as a standing Fred Agreement rule.
**Acceptance:** filing the first file for an unknown customer prompts the folder check.

## C — Startup modes: fast wake / normal / audit

Split startup by intent; preserve non-negotiable safety checks in all modes; move heavy
detail behind normal/audit or a short-TTL green-check cache.

- **Fast wake (default work entry):** workspace-pinned factory identity → current_database/
  current_user → anchor platform session → critical connector + Agreement readiness → report
  **only** red/yellow items + the resume point.
- **Normal:** adds connector readiness summary, skill-agreement coverage, embedding health
  counts, governance totals, active SOP index presence.
- **Audit (diagnose/health/audit requests):** full SOP index, full P1 queue, detailed
  connector probes, commons KB doctrine checks, retrieval-warm detail, governance/rule drift.

Cache recently-green non-critical checks with a short TTL; invalidate on warning, version
drift, or explicit audit request.

**Owner:** Probot. **Builds against:** the O-Matic startup runner contract (`omatic_factory_startup_run`).
**Acceptance:** fast wake skips heavy detail yet still catches a red safety check; audit runs the full battery.

## D — O-Matic WordPress Factory plugin scaffold

Build in private `lucidIT-LLC/o-matic-wordpress-factory`. Bundle **Brandy, Jo, Carver, Monet**
skills; **one configurable host MCP gateway** for WordPress + Elementor endpoints; easy
per-project setup; onboarding/messaging aimed at small independent website builders.
(Connector portability hardening already landed — pk #82, commit 60938ef.)

**Owner:** Carver. **Acceptance:** per-project configure → activate → WP+Elementor tools resolve through one gateway.

## E — O-Matic Elementor cross-platform plugin

Replace per-host desktop MCP config edits with a portable O-Matic-branded distribution across
**Codex, Claude Desktop/Cowork, and Claude Code**. Core: one WordPress-side capability bundle,
one common Node MCP proxy/host adapter, host-specific packaging at the edge (Codex plugin,
Claude Desktop `.mcpb`, Claude Code `.mcp.json`/`claude mcp add`). **First milestone:**
credential migration + rotation (today's `.mcp.json` embeds application-password secrets).

**Owner:** Carver. Builds on decisions #77/#78. **Acceptance:** same WP/Elementor capability set installs on all three hosts from one source; no plaintext app-password in host config.

## F — Fred file intake without Docling dependency

Remove the hard Docling dependency from Fred's intake path; degrade gracefully to native
read/convert. **Owner:** Fred. **Acceptance:** intake succeeds with Docling absent.

## G — Fred L2 Session-Rhythm continuity protocol

Cross-session continuity for the workspace manager (resume point, custody handoff).
**Owner:** Fred. **Acceptance:** a cold start recovers the last resume point without operator re-priming.

---

## Dependencies

- **A, B** are governance fold-ins (encode adopted behavior as rules) — lowest risk, do first.
- **C** depends on the startup-runner contract; independent of the plugin builds.
- **D** and **E** share the host MCP gateway / proxy adapter — **build E's adapter once, D consumes it.** Sequence E-adapter → D.
- **F, G** are Fred-internal; independent of the plugin builds.

## Routing (no hero-ball)

| Workstream | Routed to | Probot's role |
|-----------|-----------|---------------|
| A, B (governance fold-in) | Probot + brain | author rules, operator escalation on conflict |
| C (startup modes) | Probot (runner) → Smith review | own |
| D, E (plugins) | **Carver** | spec handoff, Smith gate before release |
| F, G (Fred infra) | **Fred** | spec handoff |

Each workstream: spec → build (owner) → **Smith adversarial gate** → merge to `beta` →
green pass → fast-forward `stable`. Versioned tags only (`vX.Y.Z`, `<plugin>-vX.Y.Z`) —
**never a moving `stable` git tag** (that defect is closed; decision #180).

## Definition of done for the 3.0 framework (this file)

- [x] All known 3.0 changes captured with owner, source, trigger, acceptance.
- [x] Claims boundary carried forward.
- [x] Dependency + routing map.
- [ ] Each workstream promoted to its own beta task/branch as it starts (owner cuts a feature branch off `beta`).
