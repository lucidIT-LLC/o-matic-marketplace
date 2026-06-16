# Ollama Adapter

Ollama can run the bundled skills as prompt-only local models.

Generate a Modelfile:

```bash
node scripts/build-ollama-modelfile.mjs probot llama3.1:8b > Probot.Modelfile
ollama create probot -f Probot.Modelfile
```

Limit: this does not give Ollama access to the O-Matic factory database. Factory operations require a local app that combines Ollama with MCP/tool calls, or a host that can launch `server/index.js` as an MCP server.
