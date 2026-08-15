import type { Event } from "../schema/event.js"
import type { SelfStore } from "../store/self.js"

export interface SessionStats {
  repeatedTools: Array<{ tool: string; count: number }>
  failedTools: Array<{ tool: string; count: number }>
  maxStepsHit: boolean
  totalSteps: number
}

// Guidance and meta-cognition read the most recent events only: their cost
// must stay bounded as the append-only log grows without limit.
export const GUIDANCE_WINDOW_EVENTS = 5000

export function analyzeEvents(events: Event[]): SessionStats {
  const toolCounts = new Map<string, number>()
  const failures = new Map<string, number>()
  const stepTool = new Map<string, string>()
  let maxStepsHit = false
  let totalSteps = 0

  for (const e of events) {
    if (e.type === "step") {
      toolCounts.set(e.tool, (toolCounts.get(e.tool) ?? 0) + 1)
      stepTool.set(e.id, e.tool)
      totalSteps += 1
    } else if (e.type === "result") {
      const r = e.result as { ok?: boolean } | null
      if (r && typeof r === "object" && r.ok === false) {
        const tool = stepTool.get(e.stepId) ?? "unknown"
        failures.set(tool, (failures.get(tool) ?? 0) + 1)
      }
    } else if (e.type === "done") {
      // Structured field since the error/max-steps outcomes were added;
      // the prefix check covers rows written by older versions.
      maxStepsHit ||= e.stopped === "max_steps" || (e.stopped === undefined && e.answer.startsWith("(stopped"))
    }
  }

  const repeatedTools = [...toolCounts.entries()]
    .filter(([, count]) => count >= 3)
    .map(([tool, count]) => ({ tool, count }))
  const failedTools = [...failures.entries()].map(([tool, count]) => ({ tool, count }))

  return { repeatedTools, failedTools, maxStepsHit, totalSteps }
}

function reflection(_name: string, note: string, evidence: string[]): Parameters<SelfStore["add"]>[1] {
  return {
    kind: "memory" as const,
    content: { note },
    provenance: { source: "self-reflection" as const, refs: [], created: Date.now() },
    evidence,
    verification: { status: "unverified" as const, check: null, lastVerifiedAt: null },
    ttl: null,
    state: "active" as const,
    metrics: { uses: 0, successes: 0, lastUsedAt: null },
  }
}

export function metacognize(events: Event[], self: SelfStore): string[] {
  const stats = analyzeEvents(events)
  // Reflections cite the events they were derived from (content-addressed
  // evidence); cross-session aggregates are bounded to the most recent ones.
  const evidence = events
    .filter((e) => e.type === "step" || e.type === "result")
    .map((e) => e.id)
    .slice(-50)

  const perTool = new Map<string, string[]>()
  for (const { tool, count } of stats.failedTools) {
    perTool.set(tool, [...(perTool.get(tool) ?? []), `failed ${count}x`])
  }
  for (const { tool, count } of stats.repeatedTools) {
    perTool.set(tool, [...(perTool.get(tool) ?? []), `repeatedly called (${count}x)`])
  }

  const notes: string[] = []
  for (const [tool, obs] of perTool) {
    const note = `${tool}: ${obs.join("; ")} — consider a different approach`
    self.add(`self-reflection:${tool}`, reflection(tool, note, evidence))
    notes.push(note)
  }
  if (stats.maxStepsHit) {
    const note = "ran out of steps without finishing — the task may need decomposition"
    self.add("self-reflection:steps", reflection("steps", note, evidence))
    notes.push(note)
  }

  return notes
}

export function buildGuidance(events: Event[]): string {
  const stats = analyzeEvents(events)
  if (stats.failedTools.length === 0 && stats.repeatedTools.length === 0 && !stats.maxStepsHit) return ""

  const parts: string[] = []
  for (const { tool, count } of stats.failedTools) parts.push(`${tool} failed ${count}x`)
  for (const { tool, count } of stats.repeatedTools) parts.push(`${tool} repeated ${count}x`)
  if (stats.maxStepsHit) parts.push("ran out of steps")
  return `[guidance] recent issues: ${parts.join("; ")} — consider a different approach`
}
