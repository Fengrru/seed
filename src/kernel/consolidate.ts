import { tokenize } from "../memory/embedding.js"
import { isExpired } from "../memory/retriever.js"
import { stableStringify } from "../schema/knowledge.js"
import type { SelfStore } from "../store/self.js"

export interface ConsolidateResult {
  merged: number
  archived: number
  promoted: number
  staled: number
  mapping: Array<{ from: string; to: string }>
}

const ZOMBIE_DAYS = 30
const DAY_MS = 24 * 3600_000
const MERGE_SIMILARITY = 0.9

function jaccard(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1
  const sa = new Set(a)
  const sb = new Set(b)
  let intersection = 0
  for (const t of sa) if (sb.has(t)) intersection += 1
  return intersection / (sa.size + sb.size - intersection)
}

// Loop D: keeps the knowledge base small and high-signal. Every action is
// append-only — merges create new versions, losers are archived, zombies are
// staled — so the whole pass is replayable and reversible.
export function consolidate(self: SelfStore, now: number = Date.now()): ConsolidateResult {
  const result: ConsolidateResult = { merged: 0, archived: 0, promoted: 0, staled: 0, mapping: [] }
  const latest = self.latest()

  // 1. Zombies: barely used entries that nobody has touched for a month
  // (or that hit their TTL) stop being injected. Never-used entries age from
  // their creation instead of a missing lastUsedAt.
  for (const o of latest) {
    if (o.state === "stale" || o.state === "archived") continue
    const lastTouch = o.metrics.lastUsedAt ?? o.provenance.created
    if ((now - lastTouch > ZOMBIE_DAYS * DAY_MS && o.metrics.uses < 3) || isExpired(o, now)) {
      self.setState(o.kind, o.name, "stale")
      result.staled += 1
    }
  }

  // 2. Near-duplicates across different names (same kind): the entry with
  // the shorter content survives, the loser is archived, and the mapping is
  // recorded in the consolidate event. Because ids are content-hash based,
  // the survivor keeps its identity; the loser stays in history (append-only).
  const active = self.latest().filter((o) => o.state === "active")
  const consumed = new Set<string>()
  for (let i = 0; i < active.length; i++) {
    const a = active[i]
    if (a === undefined || consumed.has(a.id)) continue
    for (let j = i + 1; j < active.length; j++) {
      const b = active[j]
      if (b === undefined || consumed.has(b.id) || b.kind !== a.kind) continue
      const similarity = jaccard(tokenize(stableStringify(a.content)), tokenize(stableStringify(b.content)))
      if (similarity < MERGE_SIMILARITY) continue

      const keepA = stableStringify(a.content).length <= stableStringify(b.content).length
      const survivor = keepA ? a : b
      const loser = keepA ? b : a

      self.setState(loser.kind, loser.name, "archived")
      result.merged += 1
      result.archived += 1
      result.mapping.push({ from: loser.id, to: survivor.id })
      consumed.add(survivor.id)
      consumed.add(loser.id)
      break
    }
  }

  // 3. Promotion: usage is a weak form of verification. Memories with a
  // proven track record become verified. (Skills are promoted at verify time
  // already: verified always implies active.)
  for (const o of self.latest()) {
    if (o.kind !== "memory" || o.state !== "active" || o.metrics.uses < 5) continue
    if (o.verification.status !== "verified" && o.metrics.successes / o.metrics.uses >= 0.8) {
      self.setVerification("memory", o.name, "verified", now)
      result.promoted += 1
    }
  }

  return result
}
