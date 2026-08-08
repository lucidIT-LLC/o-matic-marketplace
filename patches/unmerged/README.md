# Unmerged patches

Work that is **not in the shipped source** and is kept here so it survives review
rather than living in an untracked folder on one machine. Nothing in this
directory is built, loaded, or tested. It is not a plugin surface.

Delete a patch when its content is either merged or formally rejected — and
record which, in the decision log.

***

## `onboard-mcp-embedder-tools.js.diff`

**Status:** unmerged. **Base:** `omatic-server-connection-v3.6.0`, `server/tools.js`.
**Verified 2026-08-08:** applies cleanly to the tagged 3.6.0 file, 10 hunks, no fuzz.

Teaches `tools.js` that an onboard embedding provider speaks **MCP JSON-RPC**, not
the OpenAI REST shape. Introduces `ONBOARD_PROVIDER_PATTERN` and
`resolveOnboardEndpoint`, and deliberately ships **no default endpoint** — its own
comment explains why: a baked-in default would ship one factory's host address to
every install, and fail as a confusing timeout instead of a clear "not configured".

Neither symbol exists in tracked 3.7.0 source. Confirmed by grep, 0 hits each.

### Why it is kept

It addresses a live defect. Task **#210**: the corpus embedding drain is down —
`factory_config.embedding_endpoint` (`…:8438/mcp`, MCP JSON-RPC) refuses
connections, and the documented fallback `server/embedder-worker.js` targets
`https://api.openai.com/v1` and POSTs `/v1/embeddings`. The fallback cannot drain
the configured provider because of exactly the protocol mismatch this patch fixes.

Decisions **#257** and **#258** flagged the originating folder as discardable once a
clean 3.7.0 was proven. What #258 actually proved was the **query** path, which
correctly needs no patch — per Blueprint s9 and decision **#118** the plugin never
generates query vectors; sessions embed through the `conductor-embedder` MCP tool.
The **corpus** path was never proven, and that is what this patch touches.

### Not retained

`tools.js.patched-3.6.0` (232 KB, sha256 `55d130f3a08a4ac5…`) was a full copy of
3.6.0 `tools.js` with this diff already applied. Dropped rather than committed — a
stale near-duplicate of tracked source is a maintenance hazard, and it is exactly
reconstructible:

```bash
git show omatic-server-connection-v3.6.0:omatic-server-connection/server/tools.js > tools.js
patch -p0 tools.js < patches/unmerged/onboard-mcp-embedder-tools.js.diff
```

### Before merging

The diff is against 3.6.0 and will need rebasing onto current `tools.js`. Route to
Carver to port and Smith to review — the endpoint-resolution path handles a
configured host address, so it earns a look at how a bad or hostile
`embedding_endpoint` value is treated.
