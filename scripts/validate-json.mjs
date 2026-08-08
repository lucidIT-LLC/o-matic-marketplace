#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const explicit = process.argv.slice(2);
const files = explicit.length
  ? explicit
  : execFileSync("git", ["ls-files", "*.json", ":(exclude)omatic-server-connection/server/node_modules/**"], {
      encoding: "utf8",
    })
      .trim()
      .split("\n")
      .filter(Boolean);

let failures = 0;

function location(src, index) {
  const before = src.slice(0, index);
  const lines = before.split("\n");
  return `${lines.length}:${lines[lines.length - 1].length + 1}`;
}

function scanString(src, i) {
  const start = i;
  i++;
  let out = "";
  while (i < src.length) {
    const ch = src[i];
    if (ch === '"') return { value: out, end: i + 1, start };
    if (ch === "\\") {
      out += ch;
      i++;
      if (i >= src.length) break;
      out += src[i++];
      continue;
    }
    out += ch;
    i++;
  }
  throw new Error(`unterminated string at ${location(src, start)}`);
}

function skipWs(src, i) {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
}

function skipPrimitive(src, i) {
  while (i < src.length && !/[\s,\]}]/.test(src[i])) i++;
  return i;
}

function scanValue(src, i, file, problems) {
  i = skipWs(src, i);
  if (src[i] === "{") return scanObject(src, i, file, problems);
  if (src[i] === "[") return scanArray(src, i, file, problems);
  if (src[i] === '"') return scanString(src, i).end;
  return skipPrimitive(src, i);
}

function scanArray(src, i, file, problems) {
  i++;
  i = skipWs(src, i);
  if (src[i] === "]") return i + 1;
  while (i < src.length) {
    i = scanValue(src, i, file, problems);
    i = skipWs(src, i);
    if (src[i] === "]") return i + 1;
    if (src[i] !== ",") throw new Error(`expected "," or "]" at ${location(src, i)}`);
    i++;
  }
  throw new Error(`unterminated array at ${location(src, i)}`);
}

function scanObject(src, i, file, problems) {
  const keys = new Map();
  i++;
  i = skipWs(src, i);
  if (src[i] === "}") return i + 1;
  while (i < src.length) {
    i = skipWs(src, i);
    if (src[i] !== '"') throw new Error(`expected object key at ${location(src, i)}`);
    const key = scanString(src, i);
    const first = keys.get(key.value);
    const here = location(src, key.start);
    if (first) problems.push(`${file}:${here}: duplicate key "${key.value}" (first at ${first})`);
    else keys.set(key.value, here);
    i = skipWs(src, key.end);
    if (src[i] !== ":") throw new Error(`expected ":" after key at ${location(src, i)}`);
    i = scanValue(src, i + 1, file, problems);
    i = skipWs(src, i);
    if (src[i] === "}") return i + 1;
    if (src[i] !== ",") throw new Error(`expected "," or "}" at ${location(src, i)}`);
    i++;
  }
  throw new Error(`unterminated object at ${location(src, i)}`);
}

for (const file of files) {
  const src = readFileSync(file, "utf8");
  try {
    JSON.parse(src);
    const problems = [];
    const end = scanValue(src, 0, file, problems);
    if (skipWs(src, end) !== src.length) {
      throw new Error(`unexpected trailing content at ${location(src, end)}`);
    }
    for (const problem of problems) console.error(problem);
    if (problems.length) failures += problems.length;
  } catch (err) {
    console.error(`${file}: ${err.message}`);
    failures++;
  }
}

if (failures) {
  console.error(`json validation failed: ${failures} problem(s)`);
  process.exit(1);
}

console.log(`json validation ok: ${files.length} file(s)`);
