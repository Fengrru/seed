import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createFakeSearchProvider, createSearchConnection, type SearchResult } from "../src/connection/search.js"
import { SqliteSelfStore } from "../src/store/self.js"

describe("search connection", () => {
  test("search returns provider results", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const results: SearchResult[] = [{ title: "A", url: "https://a", snippet: "about x" }]
    const search = createSearchConnection(createFakeSearchProvider(results), self)
    const r = await search.call({ op: "search", query: "x" })
    expect(r.ok).toBe(true)
    expect((r as { value: { results: SearchResult[] } }).value.results).toHaveLength(1)
  })

  test("remember stores a fact with search provenance and TTL", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const search = createSearchConnection(createFakeSearchProvider(), self)
    await search.call({ op: "remember", key: "fact", content: { a: 1 }, sourceUrl: "https://a", ttlHours: 24 })
    const obj = self.get("memory", "fact")!
    expect(obj.provenance.source).toBe("search")
    expect(obj.provenance.refs).toEqual([{ url: "https://a" }])
    expect(obj.ttl).toBe(24 * 3_600_000)
    expect(obj.verification.status).toBe("unverified")
  })

  test("provider failure returns search_failed, not thrown", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const failing = {
      async search() {
        throw new Error("down")
      },
    }
    const search = createSearchConnection(failing, self)
    const r = await search.call({ op: "search", query: "x" })
    expect(r.ok).toBe(false)
  })
})
