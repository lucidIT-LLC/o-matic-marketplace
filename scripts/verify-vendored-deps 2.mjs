#!/usr/bin/env node
// The plugin runtime is vendored deliberately — no host installs dependencies,
// so the committed node_modules IS what ships. That makes it possible to commit
// a lockfile bump without the files it implies: `git add -A` skips them, because
// the path is ignored-but-tracked. That happened during PR #17 and would have
// shipped a broken dependency tree.
//
// This check runs `npm ci` from the lockfile and fails if the result differs
// from what is committed.
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const server = resolve(root, "omatic-server-connection/server");
const sh = (cmd, args, cwd) =>
  execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

console.log("npm ci from lockfile…");
sh("npm", ["ci", "--no-audit", "--no-fund"], server);

const dirty = sh("git", ["status", "--porcelain", "--", "omatic-server-connection/server/node_modules"], root).trim();

if (!dirty) {
  const n = sh("git", ["ls-files", "omatic-server-connection/server/node_modules"], root).trim().split("\n").length;
  console.log(`vendored deps match the lockfile — ${n} files tracked ✅`);
  process.exit(0);
}

const lines = dirty.split("\n");
console.error(`\nVENDORED TREE DOES NOT MATCH THE LOCKFILE — ${lines.length} path(s) differ:\n`);
console.error(lines.slice(0, 40).join("\n"));
if (lines.length > 40) console.error(`… and ${lines.length - 40} more`);
console.error(`\nThe committed node_modules is the shipped runtime. Commit what \`npm ci\` produced:`);
console.error(`  cd omatic-server-connection/server && npm ci`);
console.error(`  git add -f omatic-server-connection/server/node_modules`);
console.error(`\n(-f is required: the path is ignored so that stray local installs elsewhere stay ignored.)\n`);
process.exit(1);
