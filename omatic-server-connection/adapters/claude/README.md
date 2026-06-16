# Claude Code Adapter

Claude Code uses:

- Plugin manifest: `.claude-plugin/plugin.json`
- Server entrypoint: `${CLAUDE_PLUGIN_ROOT}/server/index.js`
- Project root: `${CLAUDE_PROJECT_DIR}`
- Bundled skills: `skills/*/SKILL.md`

The manifest sets:

```text
OMATIC_PROJECT_ROOT=${CLAUDE_PROJECT_DIR}
OMATIC_FACTORY_JSON_PATH=${CLAUDE_PROJECT_DIR}/.omatic/factory.json
OMATIC_PLATFORM=claude-code
```

Full support requires a project `.omatic/factory.json` or connection setup through the plugin tools.
