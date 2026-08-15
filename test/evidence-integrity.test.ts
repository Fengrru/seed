import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import { createMemoryConnection } from "../src/connection/memory.js"
import { harvestInto } from "../src/kernel/harvest.js"
import { metacognize } from "../src/kernel/meta.js"
import { createFakeModel } from "../src/model/fake.js"
import type { Event } from "../src/schema/event.js"
import { SqliteLog } from "../src/store/log.js"
import { DataCorruptionError, SqliteSelfStore } from "../src/store/self.js"
import { tmpDir } from "./helpers.js"

function makeStore(): SqliteSelfStore {
  return new SqliteSelfStore(new Database(":memory:"))
}

describe("evidence trail", () => {
  test("memory writes record the calling step as evidence", async () => {
    const self = makeStore()
    const memory = createMemoryConnection(self)
    const r = await memory.call({ op: "write", key: "k", content: 1 }, { sessionId: "sess-1", stepId: "step-42" })
    expect(r.ok).toBe(true)
    expect(self.get("memory", "k")?.evidence).toEqual(["step-42"])
  })

  test("harvest records the session as evidence", () => {
    const self = makeStore()
    harvestInto(
      self,
      { memories: [{ key: "m", content: { x: 1 } }], skills: [] },
      { sessionId: "sess-9", evidenceIds: ["evt-9"] },
    )
    expect(self.get("memory", "m")?.evidence).toEqual(["evt-9"])
  })

  test("self-reflection records the session as evidence", () => {
    const self = makeStore()
    const events: Event[] = [
      { type: "turn", id: "t1", ts: 1, sessionId: "sess-7", goal: "g" },
      { type: "step", id: "s1", ts: 2, sessionId: "sess-7", tool: "bash", args: {} },
      { type: "result", id: "r1", ts: 3, sessionId: "sess-7", stepId: "s1", result: { ok: false } },
      { type: "step", id: "s2", ts: 4, sessionId: "sess-7", tool: "bash", args: {} },
      { type: "result", id: "r2", ts: 5, sessionId: "sess-7", stepId: "s2", result: { ok: false } },
      { type: "step", id: "s3", ts: 6, sessionId: "sess-7", tool: "bash", args: {} },
      { type: "result", id: "r3", ts: 7, sessionId: "sess-7", stepId: "s3", result: { ok: false } },
      { type: "done", id: "d1", ts: 8, sessionId: "sess-7", answer: "x", stopped: "done" },
    ]
    metacognize(events, self)
    expect(self.get("memory", "self-reflection:bash")?.evidence).toEqual(["s1", "r1", "s2", "r2", "s3", "r3"])
  })

  test("agent emits a run-level harvest event after distilling", async () => {
    const dir = tmpDir()
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      autoHarvest: true,
      model: createFakeModel(
        [
          { type: "tool", tool: "fs_write", args: { path: "a.txt", content: "x" } },
          { type: "done", answer: "done" },
        ],
        { memories: [{ key: "m", content: 1 }], skills: [] },
      ),
    })
    await agent.session().run("task")
    const harvestEvents = agent.log.replay().filter((e) => e.type === "harvest")
    expect(harvestEvents).toHaveLength(1)
    expect((harvestEvents[0] as { data: { memories: number } }).data.memories).toBe(1)
  })
})

describe("storage integrity", () => {
  test("kind scopes name: a memory and a skill with the same name coexist independently", () => {
    const self = makeStore()
    self.add("dup", {
      kind: "memory",
      content: { m: 1 },
      provenance: { source: "human", refs: [], created: 1 },
      evidence: [],
      verification: { status: "unverified", check: null, lastVerifiedAt: null },
      ttl: null,
      state: "active",
      metrics: { uses: 0, successes: 0, lastUsedAt: null },
    })
    self.add("dup", {
      kind: "skill",
      content: { description: "d", steps: "s" },
      provenance: { source: "human", refs: [], created: 1 },
      evidence: [],
      verification: { status: "unverified", check: null, lastVerifiedAt: null },
      ttl: null,
      state: "draft",
      metrics: { uses: 0, successes: 0, lastUsedAt: null },
    })
    const mem = self.get("memory", "dup")!
    const skill = self.get("skill", "dup")!
    expect(mem.kind).toBe("memory")
    expect(skill.kind).toBe("skill")
    expect(mem.version).toBe(1)
    expect(skill.version).toBe(1)
    expect(self.history("memory", "dup")).toHaveLength(1)
    expect(self.history("skill", "dup")).toHaveLength(1)
    expect(self.latest()).toHaveLength(2)
  })

  test("corrupt knowledge rows raise DataCorruptionError instead of leaking garbage", () => {
    const db = new Database(":memory:")
    const self = new SqliteSelfStore(db)
    db.query(
      "INSERT INTO knowledge (id, name, kind, version, parent_id, content, source, refs, evidence, verification_status, verification_check, last_verified_at, ttl, state, uses, successes, last_used_at, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "bad-row",
      "broken",
      "not-a-kind",
      1,
      null,
      "{}",
      "human",
      "[]",
      "[]",
      "unverified",
      null,
      null,
      null,
      "active",
      0,
      0,
      null,
      1,
    )
    expect(() => self.latest()).toThrow(DataCorruptionError)
  })

  test("the event log skips unparseable rows instead of poisoning replay", () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const good: Event = { type: "turn", id: "t1", ts: 1, sessionId: "s", goal: "g" }
    log.append(good)
    db.query("INSERT INTO events (id, ts, type, session_id, data) VALUES (?, ?, ?, ?, ?)").run(
      "bad-1",
      2,
      "turn",
      "s",
      "{this is not json",
    )
    db.query("INSERT INTO events (id, ts, type, session_id, data) VALUES (?, ?, ?, ?, ?)").run(
      "bad-2",
      3,
      "bogus-type",
      "s",
      '{"type":"bogus-type"}',
    )
    const events = log.replaySession("s")
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual(good)
  })
})
