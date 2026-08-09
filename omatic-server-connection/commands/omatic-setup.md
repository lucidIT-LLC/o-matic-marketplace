---
description: Point this project at its O-Matic factory. Pins the factory root, confirms it resolved, and shows which factory databases Conductor has granted this app.
disable-model-invocation: true
argument-hint: [project-root]
---

# O-Matic Server — Project Setup

You are helping the operator connect **this project** to its O-Matic factory.

**Read this before you start.** As of plugin 5.0.0 this command no longer
collects database credentials, and there is no tool here that can accept one.
The connector is not a database client: it holds no credentials, opens no
connections and runs no SQL. Credentials live in **Conductor**, in the macOS
Keychain, granted per paired app.

So this command does two things — pin the factory, and report what the databases
say back. If the operator wants to add or change a *database connection*, that
happens in Conductor, and **they do it themselves in Conductor's own UI.**

## Steps

1. **Pin the factory.** If the operator passed an argument, use it as the project
   root; otherwise ask for the absolute path to the project folder that contains
   `.omatic/factory.json`.

   ```
   omatic_select_factory(project_root="/absolute/path/to/the/project")
   ```

   This is required on every host, not a convenience. The plugin's process
   working directory is **host-dependent and is not the project folder** — on
   Cowork it is the session scratch directory, elsewhere the plugin install
   root. Re-mounting the folder in the host UI does **not** fix it: the host
   mount and the plugin process cwd are independent. Factory discovery also
   never walks up the directory tree (rule #259), so a `factory.json` in a parent
   folder is deliberately invisible.

   The selection is persisted and restored on the next start, so this is a
   once-per-project act, not a once-per-session one.

2. **Confirm it resolved.** Call `omatic_resolve_factory`.

   - Check `factory_id` is the factory the operator expected.
   - Check `factory_file` points at this project's `.omatic/factory.json`.
   - **If `factory_file` is `null`, stop.** The factory was not pinned. Report
     the resolution trace — it names every candidate root tried and why each was
     rejected — rather than continuing against an unresolved factory.

   If there is no `.omatic/factory.json` yet, create one. It carries **identity
   only**:

   ```json
   {
     "factory_id": "your-factory",
     "server_name": "Your Factory",
     "connection_profile": "default"
   }
   ```

   **It must not contain a host, user, password or `database_url`.** Nothing
   reads them — a credential there is a credential at rest serving no purpose.

3. **Report any leftover credentials.** `omatic_resolve_factory` returns a
   `legacy_connection_fields` block. If `present` is true, it lists the **key
   names** of pre-5.0.0 connection fields still sitting in the file (never their
   values). Tell the operator plainly: move those into Conductor, then delete the
   keys from `factory.json`.

4. **Show what the databases will allow.** Call Conductor's `connections_list`.

   Report two numbers, both of them meaningful:
   - the connections this app **was granted**, by their operator-facing names;
   - the count of connections that exist but were **not** granted.

   That second number is the pairing grant working as designed, not a gap. If a
   later query returns *"This app was not granted access to X"*, that is a
   **refusal** — report it as one, naming the connection. Never report it as
   "no data" or an empty result.

   Conductor's names are the operator-facing ones and differ from the plugin's
   old internal names: **o-MATIC Home Office** (was `omatic`), **Commons** (was
   `kb`), **About Jimmy** (was `aboutjimmy`), plus **Benecard**, **lucidIT
   Corp**, **Practically Adventist**, **theNest**.

5. **If a connection is missing or wrong**, hand it back to the operator. Say
   which connection is needed and that it is added or amended in Conductor —
   `connection_propose` / `connection_amend` / `connection_remove`, each approved
   by the operator in Conductor's own interface.

   **Do not ask the operator to paste a password, and do not accept one if it is
   offered.** There is nowhere here to put it that would be safe or useful. If a
   credential appears in the conversation, tell the operator it should be
   entered in Conductor instead, and treat the pasted value as compromised.

6. **Confirm next steps.** Verify with `omatic_resolve_factory` once more, then
   hand back to Probot for factory startup.

   Note that an MCP server is loaded at host process start and never
   hot-reloads. If the plugin was just installed or updated, the operator must
   fully restart the host — a new conversation is not enough.
