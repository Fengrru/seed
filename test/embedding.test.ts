import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { cosine, TfidfVectorizer, tokenize } from "../src/memory/embedding.js"
import { createFakeEmbeddingProvider } from "../src/memory/embedding-provider.js"
import { createEmbeddingRetriever } from "../src/memory/embedding-retriever.js"
import { createRetriever } from "../src/memory/retriever.js"
import type { NewKnowledgeObject } from "../src/schema/knowledge.js"
import { SqliteSelfStore } from "../src/store/self.js"

function memory(_name: string, content: unknown, ttl: number | null = null, created = Date.now()): NewKnowledgeObject {
  return {
    kind: "memory",
    content,
    provenance: { source: "human", refs: [], created },
    evidence: [],
    verification: { status: "verified", check: null, lastVerifiedAt: created },
    ttl,
    state: "active",
    metrics: { uses: 0, successes: 0, lastUsedAt: null },
  }
}

describe("embedding", () => {
  test("tokenize handles CJK and punctuation", () => {
    expect(tokenize("Hello, 世界 foo-bar")).toEqual(["hello", "世界", "foo", "bar"])
  })

  test("cosine similarity is 1 for identical, 0 for disjoint", () => {
    const v = new TfidfVectorizer(["the quick brown fox", "lazy dog sleeps"])
    const a = v.vectorize("quick brown fox")
    const b = v.vectorize("quick brown fox")
    const c = v.vectorize("lazy dog")
    expect(cosine(a, b)).toBeCloseTo(1)
    expect(cosine(a, c)).toBeCloseTo(0)
  })
})

describe("TF-IDF retriever", () => {
  test("ranks semantically related content above unrelated", async () => {
    const store = new SqliteSelfStore(new Database(":memory:"))
    store.add("sql", memory("sql", { rule: "use sqlite for persistence and queries" }))
    store.add("css", memory("css", { rule: "use tailwind for styling" }))
    const r = createRetriever(store)
    expect((await r.retrieve("how do I persist data with sqlite", 5))[0]?.name).toBe("sql")
  })

  test("excludes expired memories (TTL)", async () => {
    const store = new SqliteSelfStore(new Database(":memory:"))
    const now = 1_000_000
    store.add("fresh", memory("fresh", { x: "sqlite" }, null, now))
    store.add("stale-ttl", memory("stale-ttl", { x: "sqlite" }, 1000, now - 5000))
    const r = createRetriever(store, () => now)
    expect((await r.retrieve("sqlite", 5)).map((o) => o.name)).toEqual(["fresh"])
  })
})

describe("embedding retriever", () => {
  test("ranks by embedding cosine similarity", async () => {
    const store = new SqliteSelfStore(new Database(":memory:"))
    store.add("sql", memory("sql", { rule: "use sqlite for persistence" }))
    store.add("css", memory("css", { rule: "use tailwind for styling" }))
    const r = createEmbeddingRetriever(store, createFakeEmbeddingProvider())
    expect((await r.retrieve("sqlite persistence", 5))[0]?.name).toBe("sql")
  })
})
