# Changelog

## 2.1.5 — 2026-06-15

### Fixed
- `omatic_record_decision` failed with a NOT NULL violation on `category` and
  `title` (both required by the `decisions` table, no DB default). The tool now
  accepts optional `category` (default `general`) and `title` (default: a
  truncation of `decision`), sets `decision_date = CURRENT_DATE`, and maps the
  `owner` arg to `made_by`. Clarified that the `decisions` table has no `status`
  column — the `status` param is accepted for compatibility and ignored.

## 2.1.4

- Prior release.
