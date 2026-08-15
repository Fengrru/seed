# Changelog

## 0.1.0 — 2026-08-15

First release.

- Stable kernel loop with persist-before-execute event log (I6), content-addressed evidence
  (I7), and audited automatic state changes (I8).
- Evolution loop: usage feedback driven by an independent goal judge, draft → verified →
  active skill lifecycle, cascade invalidation (`memory revoke`), consolidation and
  zombie/TTL forgetting.
- Tools: workspace-confined `fs_read`/`fs_write`, `bash`, `memory`, `skill`, `task`,
  `delegate` (parallel isolated worktrees), web search (HTTP provider), MCP (stdio +
  streamable HTTP) with resilience handling and conflict rollback.
- Anti-degeneration: multi-tool turns with done short-circuit, doom-loop interception,
  length-stop protection, empty-batch guard, max-steps skip recording.
- History compaction: deterministic round folding with verified `covers`, plus optional
  model-written summaries (`SEED_COMPACT_MODEL=1`) with deterministic fallback.
- Retrieval: TF-IDF and embedding-based (with per-knowledge vector cache and TF-IDF
  fallback on outage).
- Optional event-log retention with JSONL sidecar archive (`SEED_LOG_RETENTION_DAYS`).
- CLI: REPL and one-shot mode, MCP/search/embedding wiring, trust gate
  (`SEED_CONFIRM=1`), 16 environment variables.
- Eval harness: cold/warm learning benchmark and evolution benchmark, both workspace-verified
  and isolated per scenario.
- 232 tests with no real network; CI on GitHub Actions (typecheck + lint + tests).
