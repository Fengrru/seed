import type { Event } from "../schema/event.js"
import { reconstructHistory } from "./history.js"

// Once the reconstructed working history exceeds this many characters, the
// agent folds completed earlier rounds into compact events (see
// docs/history-compaction-design.md).
export const DEFAULT_COMPACT_THRESHOLD = 30_000

export interface PlannedCompact {
  covers: string[]
  events: Event[]
  summary: string
}

const MAX_STEP_ARGS_CHARS = 80
const MAX_GOAL_CHARS = 200
const MAX_OUTCOME_CHARS = 500

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s
}

// Deterministic, model-free summary of one completed round. Phase 2 of the
// design adds an optional model-based summarizer; this is the always-safe
// fallback and the default.
export function summarizeRound(events: Event[]): string {
  const turn = events.find((e) => e.type === "turn") as { goal: string } | undefined
  const done = events.find((e) => e.type === "done") as { answer: string; stopped?: string } | undefined
  const steps = events.filter((e) => e.type === "step")
  const failed = events.filter((e) => e.type === "result" && (e.result as { ok?: boolean } | null)?.ok === false).length

  const stepList = steps
    .map((s) => `${s.tool}(${truncate(JSON.stringify(s.args) ?? "undefined", MAX_STEP_ARGS_CHARS)})`)
    .join(", ")

  let outcome = "interrupted"
  if (done) {
    outcome =
      done.stopped === "max_steps"
        ? "max_steps reached"
        : done.stopped === "error"
          ? `error: ${done.answer}`
          : done.answer
  }

  return [
    `[compacted turn] goal: ${truncate(turn?.goal ?? "(no goal)", MAX_GOAL_CHARS)}`,
    `  steps: ${stepList || "(无)"} (共 ${steps.length} 步, 失败 ${failed} 次)`,
    `  outcome: ${truncate(outcome, MAX_OUTCOME_CHARS)}`,
  ].join("\n")
}

// Rounds are turn-delimited segments of events that are neither covered by a
// trusted compact nor compact events themselves.
function rounds(events: Event[], covered: Set<string>): Event[][] {
  const segments: Event[][] = []
  let current: Event[] | null = null
  for (const e of events) {
    if (covered.has(e.id) || e.type === "compact") continue
    if (e.type === "turn") {
      current = []
      segments.push(current)
    }
    current?.push(e)
  }
  return segments
}

// Plans which completed rounds to fold so the reconstructed history fits
// under the threshold. Only complete rounds fold, and the most recent round
// never does. Pure: reads events, returns drafts for the caller to verify
// and append. Reconstructing per candidate keeps the measurement exact at
// the cost of O(rounds × events) — one pass per session run.
export function planCompaction(
  events: Event[],
  thresholdChars: number,
  trustedCompacts: Set<string>,
): PlannedCompact[] {
  if (thresholdChars <= 0) return []

  const covered = new Set<string>()
  for (const e of events) {
    if (e.type === "compact" && trustedCompacts.has(e.id)) for (const c of e.covers) covered.add(c)
  }
  const candidates = rounds(events, covered)
    .slice(0, -1)
    .filter((seg) => seg.some((e) => e.type === "done"))

  const folds: PlannedCompact[] = []
  const folded = new Set<string>()
  for (const seg of candidates) {
    const skip = new Set(folded)
    for (const e of seg) skip.add(e.id)
    const history = reconstructHistory(events, { trustedCompacts, skipIds: skip })
    if (JSON.stringify(history).length <= thresholdChars) break
    folds.push({ covers: seg.map((e) => e.id), events: seg, summary: summarizeRound(seg) })
    for (const e of seg) folded.add(e.id)
  }
  return folds
}
