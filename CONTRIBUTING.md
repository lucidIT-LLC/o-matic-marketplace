# Contributing

This repository publishes plugins that other people install. A change here runs
on someone else's machine, against someone else's database. The rules below exist
because of that, not for ceremony.

## Before you open a pull request

Run the three gates CI will run. All three are fast and none need network access
beyond npm.

```bash
node scripts/version-align.mjs              # version metadata agrees everywhere
node scripts/verify-vendored-deps.mjs       # shipped runtime matches the lockfile
node scripts/gen-third-party-notices.mjs --check   # attribution inventory is current
cd omatic-server-connection/server && npm run check   # server smoke suite
```

Validate any manifest you touched:

```bash
claude plugin validate .                    # the marketplace catalog
claude plugin validate ./smith              # a single plugin
```

## Versioning

**Changing a plugin's content requires bumping its version.** This is not a
style preference. Hosts compare versions to decide whether to re-materialise a
plugin, so content that changes at the same version is delivered to nobody —
installed copies keep the old files and report "already at latest" forever.

Every source listed for that plugin in `scripts/version-sources.json` must move
together: the three catalog files, the Claude and Codex manifests, any
`package.json` or `agent-pack.json`, runtime version strings, and the `SKILL.md`
header comment. `version-align.mjs` enforces this and will fail CI otherwise.

## Skills

A plugin skill's command name comes from the frontmatter `name`, or the
directory name. **Keep them identical.** When they disagree, the command that
resolves is not the one the skill declares, and the mismatch is invisible until
someone types the documented name and gets nothing.

## Vendored dependencies

`omatic-server-connection/server/node_modules` is committed on purpose: no host
runs an install step at plugin install, so that tree is the shipped runtime. It
is not a build artefact and must not be deleted "to clean up".

To change dependencies:

```bash
cd omatic-server-connection/server
npm install <pkg>          # or npm update
npm ci                     # re-materialise exactly from the lockfile
cd ../.. && git add -f omatic-server-connection/server/node_modules \
                       omatic-server-connection/server/package-lock.json
node scripts/gen-third-party-notices.mjs    # refresh attribution
```

`-f` is required: the path is ignored so that stray installs elsewhere stay
ignored. Committing a lockfile bump without the files it implies ships a broken
tree, which is what `verify-vendored-deps.mjs` exists to catch.

## Never commit

- Credentials of any kind. `.omatic/factory.json` holds database passwords and
  belongs in an operator's workspace, never in this repository. `.gitignore`
  denies it, `.env`, `*.pem` and `*.key`.
- **Client names or client-identifying detail.** This repository is public.
  Use neutral placeholders (`client-db`, `example-tenant`) in documentation,
  comments, tool descriptions and test fixtures alike. A test fixture is as
  public as a README.
- Real hostnames, connection strings, or internal network topology.

## Security

Do not open a public issue for a security defect. Follow
[`SECURITY.md`](SECURITY.md).

## Review

[`CODEOWNERS`](CODEOWNERS) defines review ownership. Changes to the published
catalog, the privileged runtime under `omatic-server-connection/server/`, CI, or
the compliance register require owner review.

Compliance-relevant changes should also update
[`docs/COMPLIANCE.md`](docs/COMPLIANCE.md) in the same pull request — a control
register that lags the code it describes is worse than none, because it is
believed.
