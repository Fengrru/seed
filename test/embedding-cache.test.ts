import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createFakeEmbeddingProvider } from "../src/memory/embedding-provider.js"
import { createEmbeddingRetriever } from "../src/memory/embedding-retriever.js"
import type { NewKnowledgeObject } from "../src/schema/knowledge.js"
import { SqliteSelfStore } from "../src/store/self.js"

function memory(content: unknown): NewKnowledgeObject {
  return {
    kind: "memory",
    content,
    provenance: { source: "human", refs: [], created: Date.now() },
    evidence: [],
    verification: { status: "unverified", check: null, lastVerifiedAt: null },
    ttl: null,
    state: "active",
    metrics: { uses: 0, successes: 0, lastUsedAt: null },
  }
}

describe("embedding cache", () => {
  test("knowledge vectors are embedded once and reused across retrieves", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    self.add("a", memory({ note: "prefer sqlite for storage" }))
    self.add("b", memory({ note: "use port 9090" }))
    let docEmbedCalls = 0
    const provider = {
      async embed(texts: string[]) {
        if (texts.length === 1 && texts[0] === "storage query") return [[1, 0]]
        docEmbedCalls += 1
        return texts.map((_t, i) => [i + 1, 0])
      },
    }
    const retriever = createEmbeddingRetriever(self, provider)
    await retriever.retrieve("storage query", 5)
    await retriever.retrieve("storage query", 5)
    // Both knowledge docs were embedded exactly once across two retrieves.
    expect(docEmbedCalls).toBe(1)
  })

  test("a new knowledge version misses the cache and is embedded again", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    self.add("a", memory({ note: "prefer sqlite" }))
    const embedded: string[][] = []
    const retriever = createEmbeddingRetriever(self, {
      async embed(texts: string[]) {
        embedded.push(texts)
        return texts.map(() => [1, 0])
      },
    })
    await retriever.retrieve("sqlite", 5)
    self.add("a", memory({ note: "prefer postgres now" }))
    await retriever.retrieve("sqlite", 5)
    // The second retrieve only embeds the new content (id is content-hashed);
    // query embeddings are separate single-text calls.
    const docBatch = embedded.find((batch) => batch.some((t) => t.includes("postgres")))
    expect(docBatch).toHaveLength(1)
    expect(docBatch?.[0]).toContain("postgres")
  })

  test("the cache survives a provider that returns fewer vectors", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    self.add("a", memory({ note: "a" }))
    self.add("b", memory({ note: "b" }))
    const retriever = createEmbeddingRetriever(self, {
      async embed(texts: string[]) {
        if (texts.length === 1) return [[1, 0]]
        return texts.slice(0, 1).map(() => [1, 0]) // short-changes the batch
      },
    })
    const results = await retriever.retrieve("a", 5)
    expect(results.length).toBeGreaterThan(0)
  })

  test("fake embedding provider still works through the cached retriever", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    self.add("a", memory({ note: "sqlite storage" }))
    const retriever = createEmbeddingRetriever(self, createFakeEmbeddingProvider())
    const results = await retriever.retrieve("sqlite", 5)
    expect(results.map((r) => r.name)).toContain("a")
  })
})
