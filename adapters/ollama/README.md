# Ollama Adapter

Ollama has no marketplace format. Use a Modelfile per skill and put the selected `SKILL.md` body in the `SYSTEM` block.

Template:

```modelfile
FROM llama3.1:8b

SYSTEM """
[paste SKILL.md body here]
"""
```

Or generate the Modelfile from the canonical skill:

```bash
node scripts/build-ollama-modelfile.mjs smith llama3.1:8b > Smith.Modelfile
```

Recommended source prompts:

- Smith: `smith/skills/smith/SKILL.md`
- Jo: `jo/skills/jo/SKILL.md`
- Tim: `tim/skills/tim/SKILL.md`
- Rimmer: `rimmer/skills/rimmer/SKILL.md`

Build example:

```bash
node scripts/build-ollama-modelfile.mjs smith llama3.1:8b > Smith.Modelfile
ollama create smith -f Smith.Modelfile
ollama run smith "Stress-test this plan: ..."
```

The base model is deployment-specific. Use the largest capable instruction-following model available locally; these skills rely on voice and lane discipline, so weak instruction following will show drift.
