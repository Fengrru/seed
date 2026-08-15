import { type KnowledgeObject, stableStringify } from "../schema/knowledge.js"
import { cosine, TfidfVectorizer, tokenize } from "./embedding.js"

export { tokenize }

export interface Retriever {
  retrieve(query: string, limit: number): Promise<KnowledgeObject[]>
}

export function isExpired(obj: KnowledgeObject, now: number): boolean {
  return obj.ttl !== null && obj.provenance.created + obj.ttl < now
}

export function injectable(obj: KnowledgeObject): boolean {
  if (obj.state === "stale" || obj.state === "archived") return false
  if (obj.kind === "skill") return obj.verification.status === "verified"
  return true
}

// Usage-derived multiplier applied to retrieval scores: entries that are used
// often rank higher, and entries that keep failing once used are penalized.
// This is the "gets smarter with use" signal — small, bounded, no storage cost.
export function usageFactor(o: KnowledgeObject): number {
  const { uses, successes } = o.metrics
  const health = 1 + 0.3 * Math.tanh((successes - uses / 2) / 5)
  return (1 + Math.log10(uses + 2) * 0.2) * health
}

export function createRetriever(store: { latest(): KnowledgeObject[] }, now: () => number = Date.now): Retriever {
  return {
    async retrieve(query, limit) {
      const candidates = store.latest().filter((o) => injectable(o) && !isExpired(o, now()))

      if (candidates.length === 0) return []

      const docs = candidates.map((o) => stableStringify(o.content))
      const tfidf = new TfidfVectorizer(docs)
      const qvec = tfidf.vectorize(query)
      const qTokens = tokenize(query)

      return candidates
        .map((o, i) => {
          const sim = cosine(qvec, tfidf.vectorize(docs[i]!))
          const nameTokens = tokenize(o.name)
          let score = sim * 3
          if (qTokens.some((t) => nameTokens.includes(t))) score += 5
          if (o.kind === "memory") score += 0.5
          return { o, score: score * usageFactor(o) }
        })
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, limit))
        .map((x) => x.o)
    },
  }
}
