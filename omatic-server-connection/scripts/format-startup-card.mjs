#!/usr/bin/env node
// Task #336. The startup card, as a FUNCTION rather than as prose.
//
// The card failed three acceptance attempts. Twice a model with the protocol
// loaded composed a fluent bullet summary instead. The first remedy was to write
// the instruction more forcefully — which is answering "the model ignored prose"
// with more prose, and it is not a control.
//
// This is the control: one pure function, one golden output, one test. §7b now
// points at THIS FILE as the definition of the shape, so "did the host render the
// card" is answerable by string comparison instead of by reading a paragraph and
// forming an opinion.
//
// Pure. No DB, no network, no host state. Takes the single row v_startup_card
// returns and emits the block.

const ROW_SPEC = [
  { label: "Pin", cols: ["pin_path", "pin_state"], fmt: (r) => join(r.pin_path, paren(r.pin_state)) },
  {
    label: "Connection",
    cols: ["connection_name", "connection_database", "granted_count", "configured_count"],
    fmt: (r) =>
      join(
        r.connection_name,
        r.connection_database,
        r.granted_count != null && r.configured_count != null
          ? `${r.granted_count} of ${r.configured_count} granted`
          : null
      ),
  },
  {
    label: "Retrieval",
    cols: ["retrieval_state", "last_vector_retrieval_age"],
    fmt: (r) => join(r.retrieval_state, age(r.last_vector_retrieval_age, "last vector hit")),
  },
  {
    label: "Corpus",
    cols: ["corpus_unembedded_total", "last_embed_age", "drain_scope_state"],
    fmt: (r) =>
      join(
        r.corpus_unembedded_total != null ? `${r.corpus_unembedded_total} unembedded` : null,
        age(r.last_embed_age, "last embed"),
        r.drain_scope_state
      ),
  },
  { label: "Roster", cols: ["roster_ready"], fmt: (r) => r.roster_ready },
  {
    label: "Session",
    cols: ["last_session_label", "last_session_age"],
    fmt: (r) => join(r.last_session_label, age(r.last_session_age)),
  },
  {
    label: "Open",
    cols: ["open_p1_count", "open_task_total"],
    fmt: (r) =>
      join(
        r.open_p1_count != null ? `${r.open_p1_count} P1` : null,
        r.open_task_total != null ? `${r.open_task_total} total` : null
      ),
  },
];

// Every column §7b claims to render. Exported so a test can assert the spec has
// not drifted from the view — a card row missing a column the spec maps is the
// failure that turns a render into an improvisation.
export const REQUIRED_COLUMNS = [
  "factory_name",
  "factory_subtitle",
  "factory_id",
  "factory_version",
  "state",
  "state_reason",
  ...ROW_SPEC.flatMap((r) => r.cols),
];

const join = (...parts) => parts.filter((p) => p != null && p !== "").join(" · ") || null;
const paren = (v) => (v == null || v === "" ? null : `(${v})`);
const age = (v, prefix) => (v == null || v === "" ? null : prefix ? `${prefix} ${v}` : v);

/**
 * Render the one row v_startup_card returns.
 * Missing values print as UNKNOWN — never blank, never guessed. A blank reads as
 * "fine"; UNKNOWN reads as what it is.
 */
export function formatStartupCard(row) {
  if (row == null || typeof row !== "object") {
    throw new TypeError("formatStartupCard requires the single v_startup_card row");
  }
  const out = [];
  out.push(`🤖 ${row.factory_name ?? "UNKNOWN"} · ${row.factory_subtitle ?? "an o-MATIC factory"}`);
  out.push(`   ${row.factory_id ?? "UNKNOWN"} · v${row.factory_version ?? "UNKNOWN"} · ${row.state ?? "UNKNOWN"}`);
  out.push("");
  const width = Math.max(...ROW_SPEC.map((r) => r.label.length));
  for (const spec of ROW_SPEC) {
    out.push(`   ${spec.label.padEnd(width)}  ${spec.fmt(row) ?? "UNKNOWN"}`);
  }
  // The reason line is omitted ONLY when the factory is READY. Any other state
  // must carry its reason: a bare DEGRADED tells an operator nothing actionable.
  if (row.state !== "READY") {
    out.push("");
    out.push(`   ⚠ ${row.state_reason ?? "UNKNOWN"}`);
  }
  return out.join("\n");
}

/** Is this text a rendered card rather than a summary of one? */
export function looksLikeCard(text) {
  return typeof text === "string" && /^🤖 /m.test(text);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let raw = "";
  process.stdin.on("data", (d) => (raw += d));
  process.stdin.on("end", () => {
    try {
      const parsed = JSON.parse(raw);
      console.log(formatStartupCard(Array.isArray(parsed) ? parsed[0] : parsed));
    } catch (e) {
      console.error(`format-startup-card: ${e.message}`);
      process.exit(1);
    }
  });
}
