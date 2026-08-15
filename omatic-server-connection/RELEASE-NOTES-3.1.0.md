> ## ⛔ RETIRED — HISTORICAL RECORD, NOT CURRENT BEHAVIOUR
>
> **Banner added 2026-08-15.** These are the release notes for **3.1.0**. The plugin
> ships **5.x**. Nothing in this file links from anywhere: no README, no CHANGELOG,
> no workflow. It was a second record of a truth `CHANGELOG.md` already holds.
>
> **It names tools that no longer exist.** `omatic_execute_sql`,
> `omatic_test_connection`, `omatic_list_connections` and others below were
> **DELETED, not deprecated**, in 5.0.0 (decision #283) when the plugin stopped being
> a database client. Calling one returns `Unknown tool`. Database access goes through
> Conductor, which holds credentials in the macOS Keychain and grants them per paired
> app.
>
> **Retained, not deleted**, per the Stuff You Should Forget procedure: a document
> naming a removed mechanism is marked retired with its replacement, never silently
> dropped. Read for history. Do not follow it, and do not cite it as current tool
> surface — `server/tools.js` is.

---

# O-Matic Server Connection 3.1.0 — Release Notes

Additive release. Nothing is removed, no call signature changes, and no
configuration needs touching. If you are on 2.2.1 or earlier, read the
[3.0.0 notes](RELEASE-NOTES-3.0.0.md) first — that version reports success on
failed reads.

---

## The server now declares all three MCP primitives

Through 3.0.1 this server declared exactly one: `tools`. MCP defines three, and
they are not interchangeable:

| Primitive | What it is | Controlled by |
|---|---|---|
| Tools | actions the model chooses to take | the model |
| Resources | read-only data the host can browse and attach | the application |
| Prompts | invocable templates | the user |

Shipping only tools meant every read-only surface here — the usage guide, the
connection list, the task list, embedding health — had to be an *action* the
model decided to call, competing for tool-selection attention with the calls that
actually change something. Data was wearing a verb's clothes.

### Resources

Five, browsable and attachable by the host without the model choosing to act:

| URI | What it returns |
|---|---|
| `omatic://usage-guide` | how to drive this connector |
| `omatic://factory` | the resolved factory, every candidate root, and why each was accepted or rejected |
| `omatic://connections` | every connection with measured reachability, negotiated TLS, and its permission |
| `omatic://tasks` | open tasks with owner, priority, category |
| `omatic://embedding-status` | per-tier embedding and retrieval health |

Resources delegate to the same handlers the tools use. There is no second
implementation to drift, and the honesty envelope — `outcome`,
`degraded_reasons`, `results_trustworthy` — is inherited rather than
reimplemented. A resource that quietly dropped `degraded_reasons` would
reintroduce the exact defect 3.0 exists to remove.

### Prompts

Four, invocable by name: `start-the-factory`, `factory-health-check`,
`diagnose-a-connection`, `explain-embedding-status`. Each carries the operating
knowledge that otherwise lives in an operator's head — `start-the-factory` pins
the factory with an explicit `project_root` *before* resolving, because the
plugin's working directory is host-dependent and is not the project folder.

---

## What did NOT change, deliberately

**The tools are all still there.** Converting read-only tools to Resources is the
cheapest way to cut the tool count, and it is not done here. `CLAUDE.md`, the
Probot skill, and six other factories name those tools directly, and 3.0.0
already broke the tool surface once. A second break inside one minor line would
be careless. The count cut is staged for the next major, not forgotten.

Tool count is unchanged at **30** for a five-connection factory.

---

## Measured, not asserted

The 3.0.0 notes claimed a leaner runtime without publishing a number, which makes
"lean" a feeling. Baselines, measured on this release:

| Metric | 3.0.0 baseline | 3.1.0 |
|---|---|---|
| Server source | 4 files | **5 files** (`resources.js` added) |
| Lines of code | 2,852 (pre-3.0 audit) | **5,834** |
| Tools exposed (5 connections) | 99 → 34 in 3.0.0 | **30** |
| Resources | 0 | **5** |
| Prompts | 0 | **4** |
| `successResponse` call sites | 22 | **27** |
| `optionalQuery` call sites | 19 | **23** |
| `errorResponse` call sites | 30 | **44** |
| Cold start (`node server/index.js`, best of 3) | not measured | **0.11 s** |

The line count went **up**, not down, and that is the honest reading: the 3.0
response layer, the resolution reporting, the connection surface and now two new
primitives all cost lines. A target that is not measured is not a target, and a
number that only gets published when it flatters is not a measurement.

---

## Verifying

```text
omatic_usage_guide
```

Expect `version: 3.1.0`. Then confirm the new primitives are actually declared —
a host that supports them will list five resources under `omatic://` and four
prompts. If your host shows neither, it either does not implement them or has not
reloaded. On Codex, that means restart the MCP server: nothing there will tell
you an update exists.
