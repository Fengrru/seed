import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createMemoryConnection } from "../src/connection/memory.js"
import { SqliteSelfStore } from "../src/store/self.js"

describe("memory connection", () => {
  test("write then read round-trips through the self store", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const memory = createMemoryConnection(self)
    const w = await memory.call({ op: "write", key: "pref", content: { style: "snake_case" } })
    expect(w.ok).toBe(true)
    const r = await memory.call({ op: "read", key: "pref" })
    expect(r.ok).toBe(true)
    expect((r as { value: { content: { style: string } } }).value.content.style).toBe("snake_case")
  })

  test("rewriting with different content bumps version", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const memory = createMemoryConnection(self)
    await memory.call({ op: "write", key: "k", content: 1 })
    const second = await memory.call({ op: "write", key: "k", content: 2 })
    expect((second as { value: { newVersion: boolean } }).value.newVersion).toBe(true)
    expect(self.history("memory", "k")).toHaveLength(2)
  })

  test("rewriting identical content is a no-op", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const memory = createMemoryConnection(self)
    await memory.call({ op: "write", key: "k", content: 1 })
    const second = await memory.call({ op: "write", key: "k", content: 1 })
    expect((second as { value: { newVersion: boolean } }).value.newVersion).toBe(false)
    expect(self.history("memory", "k")).toHaveLength(1)
  })

  test("search returns matching memories", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const memory = createMemoryConnection(self)
    await memory.call({ op: "write", key: "db-rule", content: { note: "use sqlite" } })
    const s = await memory.call({ op: "search", query: "sqlite" })
    const value = (s as { value: { results: Array<{ key: string }> } }).value
    expect(value.results.map((r) => r.key)).toContain("db-rule")
  })

  test("read of missing key returns not_found", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const memory = createMemoryConnection(self)
    const r = await memory.call({ op: "read", key: "nope" })
    expect(r.ok).toBe(false)
  })

  test("invalid op shape returns invalid_args", async () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const memory = createMemoryConnection(self)
    const r = await memory.call({ op: "bogus" })
    expect(r.ok).toBe(false)
  })
})
