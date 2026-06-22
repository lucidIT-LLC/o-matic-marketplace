// Shared version-source reader/writer for the o-matic-marketplace release tooling.
// Pure Node, zero dependencies — must run in CI without `npm install`.
//
// Source of truth: scripts/version-sources.json (the rule #287 expected-fields map).
// The marketplace catalog entry is canonical; every other declared source must equal it.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(__dirname, "..", "..");

export function loadMap() {
  const p = join(REPO_ROOT, "scripts", "version-sources.json");
  return JSON.parse(readFileSync(p, "utf8"));
}

function abs(relPath) {
  return join(REPO_ROOT, relPath);
}

// --- catalog (canonical) ---------------------------------------------------

export function readCatalog(catalogFile) {
  const p = abs(catalogFile);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function catalogVersion(pluginName, catalogFile = "marketplace.json") {
  const cat = readCatalog(catalogFile);
  if (!cat) return undefined;
  const entry = (cat.plugins || []).find((x) => x.name === pluginName);
  return entry ? entry.version : undefined;
}

// --- generic source read ---------------------------------------------------

// Returns { label, path, exists, value, error, matches }
export function readSource(pluginName, source) {
  if (source.type === "marketplace") {
    const value = catalogVersion(pluginName);
    return {
      label: source.label || "catalog (canonical)",
      path: "marketplace.json",
      exists: value !== undefined,
      value: value ?? null,
    };
  }

  const path = source.path;
  const p = abs(path);
  const out = { label: source.label || path, path, exists: existsSync(p), value: null };
  if (!out.exists) return out;

  const raw = readFileSync(p, "utf8");

  if (source.type === "json") {
    try {
      const obj = JSON.parse(raw);
      out.value = source.field.split(".").reduce((o, k) => (o == null ? o : o[k]), obj) ?? null;
    } catch (e) {
      out.error = `invalid JSON: ${e.message}`;
    }
    return out;
  }

  if (source.type === "regex") {
    const re = new RegExp(source.pattern, "g");
    const found = [];
    let m;
    while ((m = re.exec(raw)) !== null) found.push(m[1]);
    out.matches = found;
    if (found.length === 0) {
      out.error = "pattern matched nothing — runtime version could not be located";
    } else {
      // Take the first match; flag if multiple DISTINCT values exist in one file.
      out.value = found[0];
      const distinct = [...new Set(found)];
      if (distinct.length > 1) {
        out.error = `pattern matched conflicting values in one file: ${distinct.join(", ")}`;
      }
    }
    return out;
  }

  out.error = `unknown source type: ${source.type}`;
  return out;
}

// --- generic source write (backfill) ---------------------------------------

// Forces a single source's version to `newValue`. Returns true if the file changed.
export function writeSource(pluginName, source, newValue) {
  if (source.type === "marketplace") {
    throw new Error("refusing to rewrite the canonical catalog via writeSource — bump the catalog by hand");
  }
  const p = abs(source.path);
  if (!existsSync(p)) throw new Error(`cannot write missing source: ${source.path}`);
  const raw = readFileSync(p, "utf8");

  if (source.type === "json") {
    const obj = JSON.parse(raw);
    const keys = source.field.split(".");
    let o = obj;
    for (let i = 0; i < keys.length - 1; i++) o = o[keys[i]];
    if (o[keys[keys.length - 1]] === newValue) return false;
    o[keys[keys.length - 1]] = newValue;
    writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
    return true;
  }

  if (source.type === "regex") {
    const re = new RegExp(source.pattern);
    const m = re.exec(raw);
    if (!m) throw new Error(`pattern did not match in ${source.path}; cannot rewrite`);
    if (m[1] === newValue) return false;
    // Replace only the captured version substring within the matched line.
    const replaced = m[0].replace(m[1], newValue);
    writeFileSync(p, raw.replace(m[0], replaced));
    return true;
  }

  throw new Error(`unknown source type: ${source.type}`);
}

// --- per-plugin rollup ------------------------------------------------------

export function collectPlugin(pluginName, map) {
  const def = map.plugins[pluginName];
  const sources = def.sources.map((s) => readSource(pluginName, s));
  const canonical = sources.find((s) => s.path === "marketplace.json")?.value ?? null;
  return { name: pluginName, runtime: !!def.runtime, canonical, sources };
}

// --- semver compare (numeric, x.y.z; ignores pre-release tails) -------------

export function semverCmp(a, b) {
  const pa = String(a).split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split("-")[0].split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

// --- git tag helpers --------------------------------------------------------

export function git(args, opts = {}) {
  return execFileSync("git", args, { cwd: REPO_ROOT, encoding: "utf8", ...opts }).trim();
}

export function pluginTags(pluginName) {
  try {
    const out = git(["tag", "-l", `${pluginName}-v*`]);
    return out ? out.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

export function highestTagVersion(pluginName) {
  const versions = pluginTags(pluginName)
    .map((t) => t.slice(`${pluginName}-v`.length))
    .filter((v) => /^\d+\.\d+\.\d+/.test(v));
  if (versions.length === 0) return null;
  return versions.sort(semverCmp).at(-1);
}

export function tagExists(tag) {
  try {
    git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
}

// A tag can exist WITHOUT a published GitHub Release (partial run, or a hand-cut tag).
// Reconciliation must key on both, or such a tag is forever mislabeled "already released".
export function releaseExists(tag, repo = "lucidIT-LLC/o-matic-marketplace") {
  try {
    execFileSync("gh", ["release", "view", tag, "--repo", repo, "--json", "tagName"], {
      cwd: REPO_ROOT,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}
