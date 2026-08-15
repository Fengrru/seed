import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { contentHash, type NewKnowledgeObject } from "../src/schema/knowledge.js"
import { SqliteSelfStore } from "../src/store/self.js"

function makeStore(): SqliteSelfStore {
  return new SqliteSelfStore(new Database(":memory:"))
}

function newMemory(_name: string, content: unknown, evidence: string[] = []): NewKnowledgeObject {
  return {
    kind: "memory",
    content,
    provenance: { source: "human", refs: [], created: Date.now() },
    evidence,
    verification: { status: "unverified", check: null, lastVerifiedAt: null },
    ttl: null,
    state: "draft",
    metrics: { uses: 0, successes: 0, lastUsedAt: null },
  }
}

describe("SelfStore", () => {
  test("add assigns content-hash id and version 1", () => {
    const store = makeStore()
    const obj = store.add("project:rules", newMemory("project:rules", { a: 1 }))
    expect(obj.version).toBe(1)
    expect(obj.id).toBe(contentHash({ name: "project:rules", kind: "memory", content: { a: 1 } }))
    expect(obj.parentId).toBeNull()
  })

  test("re-adding identical content is idempotent (no version bump)", () => {
    const store = makeStore()
    const v1 = store.add("k", newMemory("k", { a: 1 }))
    const again = store.add("k", newMemory("k", { a: 1 }))
    expect(again.id).toBe(v1.id)
    expect(again.version).toBe(1)
    expect(store.history("memory", "k")).toHaveLength(1)
  })

  test("second add is a new version linked by parentId (append-only chain)", () => {
    const store = makeStore()
    const v1 = store.add("project:rules", newMemory("project:rules", { a: 1 }))
    const v2 = store.add("project:rules", newMemory("project:rules", { a: 2 }))
    expect(v2.version).toBe(2)
    expect(v2.parentId).toBe(v1.id)
    expect(v2.id).not.toBe(v1.id)
  })

  test("history returns full chain newest-first", () => {
    const store = makeStore()
    store.add("k", newMemory("k", "v1"))
    store.add("k", newMemory("k", "v2"))
    store.add("k", newMemory("k", "v3"))
    const history = store.history("memory", "k")
    expect(history.map((h) => h.version)).toEqual([3, 2, 1])
  })

  test("get returns latest version; old versions preserved", () => {
    const store = makeStore()
    store.add("k", newMemory("k", "v1"))
    store.add("k", newMemory("k", "v2"))
    expect(store.get("memory", "k")?.content).toBe("v2")
    expect(store.history("memory", "k")).toHaveLength(2)
  })

  test("evidence is preserved across versions", () => {
    const store = makeStore()
    store.add("k", newMemory("k", "v1", ["evt-1"]))
    const v2 = store.add("k", newMemory("k", "v2", ["evt-2", "evt-3"]))
    expect(v2.evidence).toEqual(["evt-2", "evt-3"])
  })

  test("recordOutcome updates metrics on latest version only", () => {
    const store = makeStore()
    const v1 = store.add("k", newMemory("k", "v1"))
    store.add("k", newMemory("k", "v2"))
    store.recordOutcome("memory", "k", true)
    store.recordOutcome("memory", "k", false)
    const latest = store.get("memory", "k")!
    const first = store.history("memory", "k").at(-1)!
    expect(latest.metrics.uses).toBe(2)
    expect(latest.metrics.successes).toBe(1)
    expect(first.id).toBe(v1.id)
    expect(first.metrics.uses).toBe(0)
  })

  test("setVerification persists status and timestamp", () => {
    const store = makeStore()
    store.add("k", newMemory("k", "v1"))
    store.setVerification("memory", "k", "verified", 1234)
    const obj = store.get("memory", "k")!
    expect(obj.verification.status).toBe("verified")
    expect(obj.verification.lastVerifiedAt).toBe(1234)
  })
})
