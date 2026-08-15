import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { assembleContext } from "../src/kernel/working-set.js"
import { createRetriever, tokenize } from "../src/memory/retriever.js"
import type { NewKnowledgeObject } from "../src/schema/knowledge.js"
import { SqliteSelfStore } from "../src/store/self.js"

function memory(
  _name: string,
  content: unknown,
  state: "draft" | "active" | "stale" | "archived" = "active",
): NewKnowledgeObject {
  return {
    kind: "memory",
    content,
    provenance: { source: "human", refs: [], created: Date.now() },
    evidence: [],
    verification: { status: "verified", check: null, lastVerifiedAt: Date.now() },
    ttl: null,
    state,
    metrics: { uses: 0, successes: 0, lastUsedAt: null },
  }
}

describe("tokenize", () => {
  test("splits on punctuation and lowercases", () => {
    expect(tokenize("Hello, World! how-are_you")).toEqual(["hello", "world", "how", "are", "you"])
  })
})

describe("retriever", () => {
  test("ranks objects by query token overlap", async () => {
    const store = new SqliteSelfStore(new Database(":memory:"))
    store.add("db", memory("db", { rule: "use sqlite for persistence" }))
    store.add("css", memory("css", { rule: "use tailwind for styling" }))
    const retriever = createRetriever(store)
    const results = await retriever.retrieve("how should I persist data with sqlite", 5)
    expect(results[0]?.name).toBe("db")
  })

  test("an unverified skill is NOT injected; a verified one is", async () => {
    const store = new SqliteSelfStore(new Database(":memory:"))
    store.add("unverified-skill", {
      kind: "skill",
      content: { description: "x", steps: "x" },
      provenance: { source: "trajectory", refs: [], created: Date.now() },
      evidence: [],
      verification: { status: "unverified", check: null, lastVerifiedAt: null },
      ttl: null,
      state: "draft",
      metrics: { uses: 0, successes: 0, lastUsedAt: null },
    })
    store.add("verified-skill", {
      kind: "skill",
      content: { description: "deploy", steps: "run deploy" },
      provenance: { source: "trajectory", refs: [], created: Date.now() },
      evidence: [],
      verification: { status: "verified", check: null, lastVerifiedAt: null },
      ttl: null,
      state: "active",
      metrics: { uses: 0, successes: 0, lastUsedAt: null },
    })
    const retriever = createRetriever(store)
    const names = (await retriever.retrieve("deploy", 5)).map((o) => o.name)
    expect(names).toContain("verified-skill")
    expect(names).not.toContain("unverified-skill")
  })

  test("name match gets a bonus", async () => {
    const store = new SqliteSelfStore(new Database(":memory:"))
    store.add("tailwind-config", memory("tailwind-config", { note: "x" }))
    store.add("other", memory("other", { note: "tailwind is mentioned here too" }))
    const retriever = createRetriever(store)
    expect((await retriever.retrieve("tailwind", 5))[0]?.name).toBe("tailwind-config")
  })

  test("only latest version is returned, not history", async () => {
    const store = new SqliteSelfStore(new Database(":memory:"))
    store.add("k", memory("k", { v: 1 }))
    store.add("k", memory("k", { v: 2 }))
    const retriever = createRetriever(store)
    expect(await retriever.retrieve("k", 5)).toHaveLength(1)
  })

  test("archived and stale objects are excluded", async () => {
    const store = new SqliteSelfStore(new Database(":memory:"))
    store.add("a", memory("a", { x: 1 }, "active"))
    store.add("b", memory("b", { x: 1 }, "archived"))
    store.add("c", memory("c", { x: 1 }, "stale"))
    const retriever = createRetriever(store)
    expect((await retriever.retrieve("x", 5)).map((o) => o.name)).toEqual(["a"])
  })
})

describe("assembleContext", () => {
  test("includes entries within budget and evicts the rest with a trace", async () => {
    const store = new SqliteSelfStore(new Database(":memory:"))
    store.add("one", memory("one", { rule: "aaaa" }))
    store.add("two", memory("two", { rule: "bbbb" }))
    const retriever = createRetriever(store)
    const entries = await retriever.retrieve("aaaa bbbb", 5)
    const assembled = assembleContext(entries, 20)
    expect(assembled.included.length).toBeGreaterThanOrEqual(1)
    expect(assembled.context).toContain("[memory:")
  })

  test("empty entries yields empty context", () => {
    expect(assembleContext([], 100).context).toBe("")
  })
})
