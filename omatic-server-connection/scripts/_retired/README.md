# Retired scripts

Kept, not deleted. A script that named a real mechanism is evidence of how the
factory used to work, and deleting it destroys the only record of why it went.

## `embed-drain.mjs` — retired 2026-08-15

**It could not run, and `npm run check` said it was fine.**

```
node --check scripts/embed-drain.mjs   → syntax OK
node scripts/embed-drain.mjs           → Cannot find module '.../server/connections.js'
```

It imports `server/connections.js`, deleted in `a524ad2` (plugin 5.0.0, "stop being
a database client", decision #283). The plugin holds no credentials and runs no SQL,
so a standalone drain script inside it has nothing to connect with.

**The check that covered it was `node --check` — a syntax check.** It passed for a
full release cycle on a script that could not start. This factory's own retrieval-floor
doctrine already names this exact case: *"A drain script was verified in CI with
`node --check` — it passed while the script could not start, because it imported a
module a later release had deleted. If the check would pass on a broken system, it is
not a check."* The doctrine was written from this file and the check stayed in
`npm run check` anyway, which is the whole lesson: writing the rule down did not
remove the instance.

**Replacement:** draining is Conductor's job and runs inside Conductor — on-device
Core ML, no credential in a script, no model context. See tasks #314 (tier resolution
by contract shape) and #358 (drain-on-write).

Do not reinstate this file. If a standalone drain is ever wanted again, it needs a
credential path that does not exist today, and that is a decision, not a restore.
