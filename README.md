# Seed

[![CI](https://github.com/Fengrru/seed/actions/workflows/ci.yml/badge.svg)](https://github.com/Fengrru/seed/actions/workflows/ci.yml)

A self-hosting agent: a stable kernel loop over a writable, versioned, evidence-backed self.

The agent runs a goal by repeatedly asking a model for the next step, executing it through a
uniform `Connection` interface, and persisting every event before it happens. What the agent
learns — memories, skills, self-reflections — is stored as versioned knowledge objects with
provenance and an evidence trail, and only verified skills are injected back into the context.
The evolution loop (learn → verify → consolidate → forget) runs by default, so the agent
genuinely gets better with use: retrieval ranking is driven by usage feedback, memories from
failed runs stay proposals, and the knowledge base is kept small and high-signal.

## Quick start

Requires [Bun](https://bun.sh) >= 1.3 and an OpenAI-compatible API (defaults to DeepSeek).

```bash
bun install
OPENAI_API_KEY=sk-... bun run run
```

REPL commands: `/new` starts a fresh session, `/quit` exits. Pass a goal as an
argument to run a single task and exit instead of entering the REPL:

```bash
OPENAI_API_KEY=sk-... bun run run "create a hello.py that prints hello"
```

The session id persists (see `SEED_SESSION`), so repeated one-shots resume the
same conversation.

## Environment variables

| Variable                  | Default                     | Meaning                                                      |
| ------------------------- | --------------------------- | ------------------------------------------------------------ |
| `OPENAI_API_KEY`          | required                    | API key for the model                                        |
| `OPENAI_BASE_URL`         | `https://api.deepseek.com/v1` | OpenAI-compatible endpoint                                |
| `SEED_MODEL`              | `deepseek-chat`             | Model name                                                   |
| `SEED_WORKSPACE`          | current directory           | Directory the fs/bash tools operate in                       |
| `SEED_DB`                 | `./seed.db`                 | SQLite path (event log + knowledge store)                    |
| `SEED_SESSION`            | `default`                   | Initial session id                                           |
| `SEED_AUTO_HARVEST`       | `1`                         | Distill memories/skills after each successful run            |
| `SEED_AUTO_VERIFY_SKILLS` | `0`                         | Run distilled skills' verification commands automatically    |
| `SEED_AUTO_META`          | `1`                         | Write self-reflections when tools fail repeatedly            |
| `SEED_CONFIRM`            | `0`                         | Ask for confirmation before reviewed tools (bash, search, MCP) |
| `SEED_MCP`                | —                           | JSON array of MCP stdio servers: `[{"command":"npx","args":["-y","server"],"requestTimeoutMs":30000}]` |
| `SEED_MCP_HTTP`           | —                           | JSON array of MCP HTTP servers: `[{"url":"http://host/mcp","headers":{...}}]` |
| `SEED_SEARCH_URL`         | —                           | HTTP search provider endpoint (POST `{query, limit}`, expects `{results:[{title,url,snippet}]}`) |
| `SEED_SEARCH_API_KEY`     | —                           | Bearer token sent to the search provider                     |
| `SEED_SEARCH_HEADERS`     | —                           | Extra JSON object of headers for the search provider         |
| `SEED_EMBEDDING_MODEL`    | —                           | Enable embedding-based retrieval with this model (uses `OPENAI_BASE_URL`/`OPENAI_API_KEY`) |
| `SEED_COMPACT_THRESHOLD`  | `30000`                     | Fold completed earlier rounds into compact summaries once a session's history exceeds this many characters (`0` disables) |
| `SEED_COMPACT_MODEL`      | `0`                         | Write fold summaries with the model instead of the deterministic format (falls back on failure) |
| `SEED_LOG_RETENTION_DAYS` | `0` (off)                   | Archive event-log rows older than this many days to `<db>.archive.jsonl` and prune them; pruning breaks evidence citations into the pruned range |

## The evolution loop

Four loops keep the self converging toward knowledge that works:

- **Usage feedback** — every entry injected into a run's context gets its outcome recorded
  (`metrics.uses` / `metrics.successes`), driven by an independent **goal verdict**: after a run,
  the model judges whether the goal was actually achieved (`judge`), so "finished" is never
  mistaken for "succeeded" (falls back to the run outcome if the judge fails; disable with
  `goalVerify: false`). Retrieval ranking multiplies relevance by a usage factor: frequently
  used entries rise, frequently failing entries sink.
- **Evidence** — every event is stored with the hash of its canonical JSON. Knowledge cites
  events by id; citations are verified at write time (unverifiable ones are dropped), and
  `memory revoke` stales an entry **and everything derived from it** (derivation edges come
  from `refs.knowledgeId`). Harvest from sessions with failed tool calls distills memories as
  drafts instead of active.
- **Verification** — distilled skills start `draft`, pass their verification command to become
  `active`, and the verdict is itself an auditable event. Usage-based promotion marks
  memories with a proven track record (≥5 uses, ≥80% success) as verified.
- **Consolidation & forgetting** — every N sessions (default 8, see `consolidateEvery`), the
  agent merges near-duplicate memories, archives the losers (append-only, mapping recorded in
  a `consolidate` event), and stales zombies (barely used, untouched for 30 days) and
  TTL-expired entries.

## Complex tasks

- **Task tree** — the `task` tool declares a hierarchical plan (T1, T1.1, …) recorded as
  events; execution stays with `delegate`. The tree is rendered into the harvest transcript,
  so decomposition patterns themselves become distillable knowledge.
- **Multi-tool turns** — every tool call in a model response executes (in order) within one
  turn; a `done` step short-circuits the rest.
- **Anti-degeneration** — truncated model output (`finish_reason: length`) is never salvaged:
  the run retries once, then fails. Three identical tool calls in a row are intercepted with a
  `doom_loop` result instead of being executed.
- **History compaction** — once a session's reconstructed history exceeds a character budget
  (`SEED_COMPACT_THRESHOLD`, default 30 000), completed earlier rounds fold into `compact`
  events: deterministic summaries whose `covers` are content-addressed evidence, verified at
  write time. The event log stays complete; only the working history shrinks, keeping decide
  payloads bounded on long sessions. Compacts with unverifiable covers degrade to a full replay.
  With `SEED_COMPACT_MODEL=1` the model writes the summaries instead (deterministic fallback on
  failure).

## Security model

Tools carry a trust level (`trusted` > `reviewed` > `untrusted`). `bash`, `search`, and MCP
tools are `reviewed`; file, memory, skill, and task tools are `trusted`. Embedders can gate
calls below a threshold with `approveCall`/`confirmBelowTrust`, and the CLI's `SEED_CONFIRM=1`
asks before each reviewed call (failing closed when stdin is not interactive).

Other boundaries worth knowing:

- `fs_read`/`fs_write` are confined to the workspace, including symlink-resolved paths, and
  reads are capped at 256 KB.
- Tool results are truncated before they enter model history (full results stay in the log).
- Distilled skills start as `draft` and only become injectable after their verification
  command passes. Verification commands never run automatically unless
  `SEED_AUTO_VERIFY_SKILLS=1` is set explicitly.
- `bash` is intentionally unrestricted inside the workspace — run Seed only in an
  environment you would give the model a shell in.

## Evaluation

```bash
OPENAI_API_KEY=sk-... SEED_BENCH_SAMPLES=3 bun run eval
```

Scenarios verify what actually happened in the workspace (files created, contents written),
not just whether the final answer repeats a keyword. Each scenario is isolated: failures are
recorded per scenario, wall-clock timeouts keep a hung model call from stalling the whole
benchmark, and temp directories are cleaned up.

The evolution claim — "gets smarter with use" — has its own benchmark: a rule is taught in a
dedicated teach run and then never restated; later runs must retrieve it from the self and
comply. It reports whether the rule was distilled into memory and the per-run pass/steps trend.

```bash
OPENAI_API_KEY=sk-... SEED_EVOL_RUNS=3 bun run eval:evolution
```

## Development

```bash
bun run typecheck   # tsc --noEmit
bun test            # 232 tests, no real network
bun run coverage    # test coverage report
bun run lint        # biome check
bun run format      # biome check --write
bun run check       # typecheck + lint + tests
```

## Architecture

```
schema/     pure types (zod) for events, knowledge, connections
store/      event log (content-hashed) + versioned knowledge store (SQLite)
kernel/     the loop, context assembly, harvesting, verification, meta-cognition,
            cascade invalidation, consolidation
connection/ tool adapters: builtin fs/bash, memory, skill, task, search, delegate, MCP
model/      model adapters (OpenAI-compatible; fake for tests)
session/    event log -> conversation transcript reconstruction (with task tree)
eval/       learning benchmark (cold vs warm)
```

Design invariants:

- **I6**: a step is persisted to the event log *before* it executes, so a crash never loses
  the fact that an action was about to run. Replays of a crashed session get an
  `interrupted` marker for the dangling step.
- **I7**: knowledge writes carry verifiable evidence (event ids, content-hash checked at
  write time) or an explicit human provenance.
- **I8**: automatic state changes (stale/active/verified/archived) always leave a trace —
  either an event (verdict, consolidate, tool result) or a new knowledge version.
- Knowledge writes are idempotent (content-hash ids) and append-only (version chains with
  `parentId`), scoped by `(kind, name)`.
- Distilled skills are proposals until proven: `draft` -> `verified` -> `active`, and only
  verified, non-expired, non-stale entries are injectable.

## License

MIT — see [LICENSE](LICENSE). Security reports: see [SECURITY.md](SECURITY.md).
