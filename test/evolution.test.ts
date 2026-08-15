import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import { createTaskConnection } from "../src/connection/task.js"
import { consolidate } from "../src/kernel/consolidate.js"
import { createFakeModel } from "../src/model/fake.js"
import type { NewKnowledgeObject } from "../src/schema/knowledge.js"
import { SqliteLog } from "../src/store/log.js"
import { SqliteSelfStore } from "../src/store/self.js"
import { tmpDir } from "./helpers.js"

function memory(content: unknown, opts: Partial<NewKnowledgeObject> = {}): NewKnowledgeObject {
  return {
    kind: "memory",
    content,
    provenance: { source: "human", refs: [], created: Date.now() },
    evidence: [],
    verification: { status: "unverified", check: null, lastVerifiedAt: null },
    ttl: null,
    state: "active",
    metrics: { uses: 0, successes: 0, lastUsedAt: null },
    ...opts,
  }
}

describe("task connection", () => {
  test("creates open tasks and updates their status in the event log", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const task = createTaskConnection(log)
    const r1 = await task.call({ op: "create", taskId: "T1", title: "root" }, { sessionId: "s" })
    expect(r1.ok).toBe(true)
    await task.call({ op: "create", taskId: "T1.1", title: "child", parentId: "T1" }, { sessionId: "s" })
    await task.call({ op: "complete", taskId: "T1.1" }, { sessionId: "s" })
    const r4 = await task.call({ op: "fail", taskId: "T1" }, { sessionId: "s" })

    expect((r4 as { value: { status: string } }).value.status).toBe("failed")
    const taskEvents = log.replay().filter((e) => e.type === "task")
    expect(taskEvents.map((e) => (e as { taskId: string }).taskId)).toEqual(["T1", "T1.1", "T1.1", "T1"])
    expect(taskEvents.map((e) => (e as { status: string }).status)).toEqual(["open", "open", "done", "failed"])
  })

  test("fails closed without a session context", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const task = createTaskConnection(log)
    const r = await task.call({ op: "create", taskId: "T1", title: "x" })
    expect(r.ok).toBe(false)
    expect((r as { error: { code: string } }).error.code).toBe("no_session")
  })

  test("an agent run with task calls records the tree in the log", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel([
        { type: "tool", tool: "task", args: { op: "create", taskId: "T1", title: "plan" } },
        { type: "tool", tool: "task", args: { op: "create", taskId: "T1.1", title: "sub", parentId: "T1" } },
        { type: "done", answer: "planned" },
      ]),
    })
    const { answer } = await agent.session().run("complex goal")
    expect(answer).toBe("planned")
    const all = agent.log.replay().filter((e) => e.type === "task")
    expect(all.map((e) => (e as { taskId: string }).taskId)).toEqual(["T1", "T1.1"])
    agent.dispose()
  })
})

describe("consolidation", () => {
  test("merges near-duplicate memories and archives the loser (append-only)", () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const a = self.add("port-rule", memory({ rule: "use port 9090" }))
    const b = self.add("server-port", memory({ rule: "use port 9090" }))

    const result = consolidate(self)
    expect(result.merged).toBe(1)
    expect(result.mapping).toEqual([{ from: b.id, to: a.id }])
    expect(self.get("memory", "server-port")?.state).toBe("archived")
    expect(self.get("memory", "port-rule")?.state).toBe("active")
    // Append-only: the loser is still in its history chain.
    expect(self.history("memory", "server-port")).toHaveLength(1)
  })

  test("does not merge dissimilar memories", () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    self.add("a", memory({ note: "use sqlite for storage" }))
    self.add("b", memory({ note: "the sky is blue and grass is green" }))
    const result = consolidate(self)
    expect(result.merged).toBe(0)
    expect(self.get("memory", "a")?.state).toBe("active")
    expect(self.get("memory", "b")?.state).toBe("active")
  })

  test("promotes memories with a proven track record to verified", () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    self.add("rule", memory({ rule: "snake_case" }))
    for (let i = 0; i < 5; i++) self.recordOutcome("memory", "rule", true)
    const result = consolidate(self)
    expect(result.promoted).toBe(1)
    expect(self.get("memory", "rule")?.verification.status).toBe("verified")
  })

  test("does not promote below the usage or success thresholds", () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    self.add("few-uses", memory({ rule: "x" }))
    self.add("flaky", memory({ rule: "y" }))
    // 3 uses: below the usage threshold.
    for (let i = 0; i < 3; i++) self.recordOutcome("memory", "few-uses", true)
    // 5 uses but only 20% success: below the success threshold.
    for (let i = 0; i < 5; i++) self.recordOutcome("memory", "flaky", false)
    consolidate(self)
    expect(self.get("memory", "few-uses")?.verification.status).toBe("unverified")
    expect(self.get("memory", "flaky")?.verification.status).toBe("unverified")
  })

  test("stales zombies: barely used entries untouched for a month", () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const now = Date.now()
    self.add(
      "zombie",
      memory({ old: true }, { metrics: { uses: 2, successes: 1, lastUsedAt: now - 31 * 24 * 3600_000 } }),
    )
    self.add("alive", memory({ fresh: true }, { metrics: { uses: 0, successes: 0, lastUsedAt: now } }))
    const result = consolidate(self, now)
    expect(result.staled).toBe(1)
    expect(self.get("memory", "zombie")?.state).toBe("stale")
    expect(self.get("memory", "alive")?.state).toBe("active")
  })

  test("stales entries that were never used within a month of creation", () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const now = Date.now()
    const day = 24 * 3600_000
    self.add(
      "old-unused",
      memory({ old: true }, { provenance: { source: "human", refs: [], created: now - 31 * day } }),
    )
    self.add("fresh-unused", memory({ new: true }, { provenance: { source: "human", refs: [], created: now } }))
    const result = consolidate(self, now)
    expect(result.staled).toBe(1)
    expect(self.get("memory", "old-unused")?.state).toBe("stale")
    expect(self.get("memory", "fresh-unused")?.state).toBe("active")
  })

  test("stales TTL-expired entries", () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const now = Date.now()
    self.add(
      "old-fact",
      memory({ fact: 1 }, { ttl: 1000, provenance: { source: "search", refs: [], created: now - 2000 } }),
    )
    consolidate(self, now)
    expect(self.get("memory", "old-fact")?.state).toBe("stale")
  })

  test("a heavily used entry is not a zombie", () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const now = Date.now()
    self.add("popular", memory({ v: 1 }, { metrics: { uses: 10, successes: 8, lastUsedAt: now - 40 * 24 * 3600_000 } }))
    consolidate(self, now)
    expect(self.get("memory", "popular")?.state).toBe("active")
  })
})

describe("consolidation trigger", () => {
  test("runs every N sessions and emits a consolidate event", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel([{ type: "done", answer: "ok" }]),
      consolidateEvery: 2,
    })
    const session = agent.session()
    await session.run("one")
    expect(agent.log.replay().filter((e) => e.type === "consolidate")).toHaveLength(0)
    await session.run("two")
    const events = agent.log.replay().filter((e) => e.type === "consolidate")
    expect(events).toHaveLength(1)
    expect((events[0] as { data: { merged: number } }).data.merged).toBe(0)
    agent.dispose()
  })

  test("can be disabled with consolidateEvery 0", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model: createFakeModel([{ type: "done", answer: "ok" }]),
      consolidateEvery: 0,
    })
    const session = agent.session()
    for (let i = 0; i < 3; i++) await session.run(`run ${i}`)
    expect(agent.log.replay().filter((e) => e.type === "consolidate")).toHaveLength(0)
    agent.dispose()
  })
})
