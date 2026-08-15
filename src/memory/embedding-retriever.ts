import { type KnowledgeObject, stableStringify } from "../schema/knowledge.js"
import { cosineDense } from "./embedding.js"
import type { EmbeddingProvider } from "./embedding-provider.js"
import { injectable, isExpired, type Retriever, usageFactor } from "./retriever.js"

export function createEmbeddingRetriever(
  store: { latest(): KnowledgeObject[] },
  provider: EmbeddingProvider,
  now: () => number = Date.now,
): Retriever {
  // Knowledge ids are content hashes, so an id only ever maps to one
  // content: vectors are cached per id and a new version (new id) misses
  // naturally. This keeps the per-run embedding cost at "changed entries
  // only" instead of the whole knowledge base.
  const cache = new Map<string, number[]>()

  return {
    async retrieve(query, limit) {
      const candidates = store.latest().filter((o) => injectable(o) && !isExpired(o, now()))
      if (candidates.length === 0) return []

      const missing = candidates.filter((o) => !cache.has(o.id))
      if (missing.length > 0) {
        const vectors = await provider.embed(missing.map((o) => stableStringify(o.content)))
        missing.forEach((o, i) => {
          const v = vectors[i]
          if (v !== undefined) cache.set(o.id, v)
        })
      }

      const qvec = (await provider.embed([query]))[0] ?? []

      return candidates
        .map((o) => ({ o, score: cosineDense(qvec, cache.get(o.id) ?? []) * usageFactor(o) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(0, limit))
        .map((x) => x.o)
    },
  }
}
