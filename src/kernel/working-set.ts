import { type KnowledgeKind, type KnowledgeObject, stableStringify } from "../schema/knowledge.js"

export interface IncludedEntry {
  kind: KnowledgeKind
  name: string
}

export interface AssembledContext {
  context: string
  included: IncludedEntry[]
  evicted: string[]
}

function estimateTokens(s: string): number {
  return Math.ceil(s.length / 4)
}

export function assembleContext(entries: KnowledgeObject[], budgetTokens: number): AssembledContext {
  if (entries.length === 0) return { context: "", included: [], evicted: [] }

  const included: IncludedEntry[] = []
  const evicted: string[] = []
  const parts: string[] = []
  let used = 0

  for (const e of entries) {
    const rendered = `[memory:${e.name}]\n${stableStringify(e.content)}`
    const tokens = estimateTokens(rendered)
    if (used + tokens > budgetTokens && parts.length > 0) {
      evicted.push(e.name)
      continue
    }
    parts.push(rendered)
    included.push({ kind: e.kind, name: e.name })
    used += tokens
  }

  if (evicted.length > 0) {
    parts.push(`[evicted memories (not loaded due to budget): ${evicted.join(", ")}]`)
  }

  return { context: parts.join("\n\n"), included, evicted }
}
