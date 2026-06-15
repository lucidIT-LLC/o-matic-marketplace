# Google / Gemini Adapter

Google AI Studio, Gemini API, and Gems can use the pack without a platform-specific package format.

Use the selected skill's `SKILL.md` as the system instruction:

- Smith: `smith/skills/smith/SKILL.md`
- Jo: `jo/skills/jo/SKILL.md`
- Tim: `tim/skills/tim/SKILL.md`
- Rimmer: `rimmer/skills/rimmer/SKILL.md`

To emit the canonical prompt:

```bash
node scripts/print-system-prompt.mjs smith
```

Recommended loading rule:

1. Strip only transport-specific YAML frontmatter if the host rejects it.
2. Preserve the Markdown body exactly.
3. Put the body in the system instruction / Gem instruction field.
4. Put the operator task in the user message.

Do not summarize the skill into a shorter prompt unless the target model has a strict context limit. If summarization is required, preserve identity, voice enforcement, lane discipline, knowledge boundary, tool rules, and task contract sections.
