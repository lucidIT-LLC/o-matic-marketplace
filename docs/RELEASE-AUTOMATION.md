# Release Automation — o-matic-marketplace

Per factory decision **#198** (post-Smith gate). The model is **state reconciliation**, not
version-change detection: the manifest version is *desired state*, the set of git tags is
*actual state*, and the tooling drives actual → desired idempotently.

## Source of truth

Each plugin's version is **canonical in the marketplace catalog entry** (`marketplace.json`,
mirrored byte-for-byte in `.claude-plugin/marketplace.json`). Every other place a version
appears — `plugin.json`, `package.json`, `server/package.json`, and hardcoded runtime
constants — must equal the catalog. That alignment requirement is **rule #287**.

The full list of version sources per plugin lives in [`scripts/version-sources.json`](../scripts/version-sources.json).
**When a plugin grows a new place that carries its version, add it there** or the check will
not see it.

## The pieces

| File | Role |
|---|---|
| `scripts/version-sources.json` | The rule #287 expected-fields map. |
| `scripts/lib/versions.mjs` | Shared reader/writer + semver/tag helpers (zero deps). |
| `scripts/version-align.mjs` | The #287 gate: existence, equality, canonical, catalog parity, monotonicity, runtime-identity reporting. |
| `scripts/backfill-versions.mjs` | One-time: forces drifted sources up to canonical (file edits only). |
| `scripts/release-reconcile.mjs` | Cuts missing `<plugin>-vX.Y.Z` tags + GitHub Releases. Idempotent. |
| `.github/workflows/verify-versions.yml` | Runs the gate on every push + PR. |
| `.github/workflows/release.yml` | On push to `stable`: verify, then reconcile releases. |

## How to cut a release (the ritual)

1. Bump the plugin's version in **the catalog** (`marketplace.json` **and**
   `.claude-plugin/marketplace.json` — keep them identical).
2. Bump every other source for that plugin to match (`plugin.json`, `package.json`,
   `server/package.json`, runtime constants). Run `node scripts/version-align.mjs` until green.
3. Open a PR. `verify-versions` must pass (it will fail on any drift or a downward bump).
4. Merge to `stable`. `release.yml` runs the gate again, then cuts the immutable
   `<plugin>-vX.Y.Z` tag and publishes the Release. Already-released versions are skipped.

Releasing multiple plugins in one merge is fine — reconciliation tags every plugin whose
canonical version lacks a tag.

## What is intentionally NOT automated

- **The marketplace-wide milestone `vX.Y.Z`** is cut **manually** when a catalog-level
  release is meaningful (decision #177). Checklist:
  1. Confirm `verify-versions` is green on `stable`.
  2. `git tag -a vX.Y.Z -m "O-Matic Marketplace vX.Y.Z"` on the release commit.
  3. `git push origin refs/tags/vX.Y.Z`
  4. `gh release create vX.Y.Z --repo lucidIT-LLC/o-matic-marketplace --title "O-Matic Marketplace vX.Y.Z" --notes "<catalog summary>"`
- **The moving `stable` git tag** is never created or moved (decision #180 — it broke in-app
  updates). Channel is carried by the catalog's top-level `tags:["stable"]` (decision #194).

## Operator prerequisite — tag protection (Smith #4)

Immutability is a convention until the repo enforces it. Apply a ruleset once (Probot drafted
the `gh api` command) denying force-push and deletion on `v*` and `*-v*`. Without it, nothing
stops a `git tag -f` from reintroducing the moving-tag bug.

## Known, accepted

- **Backfill tags point at current `HEAD`**, not the historical commit where each version
  shipped (Smith #10). Acceptable for one-time reconciliation; not historically precise.
- **Runtime versions are hardcoded constants** (`PLUGIN_VERSION` in `server/index.js`;
  `version:` literals in `index.mjs`/`elementor.mjs`). The check reads and verifies them, but
  the lasting fix is to have each server read its version from one file (e.g. `package.json`)
  so there is one source to bump. Recommended follow-up, not done here.

## Backfill status

The one-time backfill has been **applied to the working tree** — the two drifted runtime
plugins (omatic-server-connection → 2.2.0, o-matic-wordpress-factory → 1.0.2) are now aligned
across all sources. Review with `git diff`, stage **only** the version files, and PR into
`stable`. (Two unrelated files — `server/embedder-worker.js` and the embedder `SKILL.md` —
were already dirty in the tree from separate work; do not bundle them into the alignment PR.)
