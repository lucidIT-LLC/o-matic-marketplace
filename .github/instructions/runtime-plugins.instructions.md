---
applyTo: "omatic-server-connection/**,o-matic-wordpress-factory/**"
---

# Runtime Plugin Instructions

Runtime plugin changes require versioning and verification.

- Bump the changed plugin version in every source declared by
  `scripts/version-sources.json`.
- Add a changelog entry for runtime behavior changes.
- Keep local stdio host support separate from remote MCP support.
- For `omatic-server-connection`, use `DEFAULT_SSL_MODE` for every default TLS
  path. Do not hardcode `require`, `prefer`, or `disable` as a fallback.
- For `o-matic-wordpress-factory`, do not hardcode project profiles in plugin
  manifests. Let the project environment choose the active profile.
- Run the plugin's `npm run check` command after edits.
