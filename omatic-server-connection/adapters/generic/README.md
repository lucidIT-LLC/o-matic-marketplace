# Generic Runtime Adapter

For any runtime with a system or developer prompt:

1. Read `agent-pack.json`.
2. Choose a skill from `skills[]`.
3. Load that skill's `canonical_skill`.
4. Use the full `SKILL.md` body as the system/developer instruction.
5. Treat DB actions as unavailable unless the runtime exposes equivalent O-Matic tools.

Helper:

```bash
node scripts/print-system-prompt.mjs data
```

Full factory operation requires an MCP-capable runtime or an external bridge to `server/index.js`.
