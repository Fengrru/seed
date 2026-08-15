import type { HarvestOutput } from "../model/model.js"
import type { SelfStore } from "../store/self.js"

export interface HarvestResult {
  memories: number
  skills: number
}

export interface HarvestOptions {
  sessionId?: string
  // Event ids the distillation was derived from (content-addressed evidence).
  evidenceIds?: string[]
  // "poor" sessions (failed tool calls, error outcomes) distill memories as
  // drafts instead of active: claims from failed trajectories are proposals.
  sourceQuality?: "good" | "poor"
}

export function harvestInto(self: SelfStore, output: HarvestOutput, opts: HarvestOptions = {}): HarvestResult {
  // A session id is not an event id: never store it as evidence. Callers
  // that have a log verify their ids before calling (see validEvidenceIds).
  const evidence = opts.evidenceIds ?? []
  const refs = opts.sessionId ? [{ sessionId: opts.sessionId }] : []
  const memoryState = opts.sourceQuality === "poor" ? "draft" : "active"

  for (const m of output.memories) {
    self.add(m.key, {
      kind: "memory",
      content: m.content,
      provenance: { source: "trajectory", refs, created: Date.now() },
      evidence,
      verification: { status: "unverified", check: null, lastVerifiedAt: null },
      ttl: null,
      state: memoryState,
      metrics: { uses: 0, successes: 0, lastUsedAt: null },
    })
  }
  for (const s of output.skills) {
    const check = s.verification ? ({ type: "command", cmd: s.verification } as const) : null
    self.add(s.name, {
      kind: "skill",
      content: { description: s.description, steps: s.steps },
      provenance: { source: "trajectory", refs, created: Date.now() },
      evidence,
      verification: { status: "unverified", check, lastVerifiedAt: null },
      ttl: null,
      // Distilled skills are proposals, never trusted by default: they stay
      // draft until the skill tool verifies them into "active".
      state: "draft",
      metrics: { uses: 0, successes: 0, lastUsedAt: null },
    })
  }
  return { memories: output.memories.length, skills: output.skills.length }
}
