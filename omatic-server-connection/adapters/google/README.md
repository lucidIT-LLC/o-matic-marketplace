# Google / Gemini Adapter

Gemini, Google AI Studio, and Gems can use bundled skills as prompt-only behavior instructions.

Emit a canonical skill prompt:

```bash
node scripts/print-system-prompt.mjs probot
```

Then paste the output into the system instruction or Gem instruction field.

Limit: Google/Gemini does not get O-Matic factory DB tools from this package by reading a prompt. Factory operations require an MCP bridge, a custom tool adapter, or a separate application layer that calls the MCP server.
