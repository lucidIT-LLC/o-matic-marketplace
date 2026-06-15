# Generic Runtime Adapter

For any chat runtime with a system prompt:

1. Read `agent-pack.json`.
2. Choose a skill from `agents[]`.
3. Load that skill's `canonical_skill`.
4. Use the full `SKILL.md` body as the system/developer instruction.
5. Send the user's task as the first user message.

To emit the canonical prompt for any runtime:

```bash
node scripts/print-system-prompt.mjs smith
```

If the runtime supports tools, expose only tools that match the skill's lane discipline. If it does not support tools, the skills still work as prompt-only roles.

If the runtime supports background workers or subagents, use the task contract in the selected `SKILL.md`.
