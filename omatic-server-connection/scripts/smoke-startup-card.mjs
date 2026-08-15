#!/usr/bin/env node
// Task #336 — the test that was missing. Golden-output assertions for the startup
// card, so "did the host render the card" is a string comparison and not a matter
// of opinion.
//
// Why this exists: the card failed three acceptance attempts, twice because a model
// with §7b loaded wrote a fluent summary instead. The first remedy was firmer prose.
// Prose is not a control. This is.

import { formatStartupCard, looksLikeCard, REQUIRED_COLUMNS } from "./format-startup-card.mjs";

let pass = 0;
let fail = 0;
const ok = (name, cond, detail) => {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${name}`);
  } else {
    fail += 1;
    console.error(`  FAIL ${name}${detail ? `\n       ${detail}` : ""}`);
  }
};

// A degraded row, matching the shapes measured on o-matic 2026-08-15.
const degraded = {
  factory_name: "O-Matic",
  factory_subtitle: "an o-MATIC factory",
  factory_id: "omatic",
  factory_version: "3.1.0",
  state: "DEGRADED",
  state_reason: "version=warn; retrieval=bad; corpus=warn; resume=warn",
  pin_path: "/Users/lucid/Documents/Work/O-Matic",
  pin_state: "resolved",
  connection_name: "o-MATIC  - Corp",
  connection_database: "o-matic",
  granted_count: 3,
  configured_count: 7,
  retrieval_state: "fts_only",
  last_vector_retrieval_age: "6d",
  corpus_unembedded_total: 1,
  last_embed_age: "2h",
  drain_scope_state: "in_scope_inferred",
  roster_ready: "11/11",
  last_session_label: "#173 2026-08-13 claude-code/ops/startup",
  last_session_age: "2d",
  open_p1_count: 96,
  open_task_total: 229,
};

const card = formatStartupCard(degraded);

ok("first line starts with the robot glyph", /^🤖 /.test(card), card.split("\n")[0]);
ok("looksLikeCard accepts a rendered card", looksLikeCard(card));
ok("identity line carries id, version and state", /omatic · v3\.1\.0 · DEGRADED/.test(card));
ok("every labelled row is present", ["Pin", "Connection", "Retrieval", "Corpus", "Roster", "Session", "Open"].every((l) => new RegExp(`^   ${l}\\s`, "m").test(card)));
ok("granted count renders as 'N of M granted'", /3 of 7 granted/.test(card));
ok("reason line present and verbatim when not READY", card.includes("⚠ version=warn; retrieval=bad; corpus=warn; resume=warn"));

// READY omits the reason line — a warning glyph on a healthy factory is the
// amber-fatigue defect (task #253) reproduced in the card.
const ready = { ...degraded, state: "READY", state_reason: null };
ok("READY omits the reason line", !formatStartupCard(ready).includes("⚠"));

// UNKNOWN must survive as UNKNOWN. A blank reads as "fine", which is the
// absence-rendered-as-success failure this whole programme exists to close.
const sparse = { factory_id: "omatic", state: "BLOCKED" };
const sparseCard = formatStartupCard(sparse);
ok("missing values print UNKNOWN, never blank", (sparseCard.match(/UNKNOWN/g) || []).length >= 6, sparseCard);
ok("BLOCKED still renders a card", looksLikeCard(sparseCard));
ok("a blank line never stands in for a value", !/^   \w+\s+$/m.test(sparseCard));

// The failure mode that actually happened three times.
const summary = [
  "Probot: Factory started — DEGRADED, not blocked.",
  "• Conductor pairing: 7/7 connections granted",
  "• Query embedding: healthy — 768d",
].join("\n");
ok("looksLikeCard REJECTS a bullet summary", !looksLikeCard(summary));

// Spec/view contract: every column §7b maps must be one the renderer reads.
ok("REQUIRED_COLUMNS is non-empty", REQUIRED_COLUMNS.length > 0);
ok("REQUIRED_COLUMNS has no duplicates", new Set(REQUIRED_COLUMNS).size === REQUIRED_COLUMNS.length,
   REQUIRED_COLUMNS.filter((c, i) => REQUIRED_COLUMNS.indexOf(c) !== i).join(", "));
ok("state_reason is a declared column", REQUIRED_COLUMNS.includes("state_reason"));

ok("bad input throws rather than rendering a hollow card", (() => {
  try { formatStartupCard(null); return false; } catch { return true; }
})());

console.log(`\nstartup-card smoke: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
