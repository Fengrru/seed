import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { createMemoryConnection } from "../src/connection/memory.js"
import { harvestInto } from "../src/kernel/harvest.js"
import { invalidateKnowledge } from "../src/kernel/invalidate.js"
import { verifyDraftSkills } from "../src/kernel/skill-verify.js"
import type { Event } from "../src/schema/event.js"
import { contentHash, type NewKnowledgeObject } from "../src/schema/knowledge.js"
import { SqliteLog } from "../src/store/log.js"
import { SqliteSelfStore } from "../src/store/self.js"

function stepEvent(id: string): Event {
  return { type: "step", id, ts: 1, sessionId: "s", tool: "echo", args: {} }
}

function knowledge(content: unknown, refs: NewKnowledgeObject["provenance"]["refs"] = []): NewKnowledgeObject {
  return {
    kind: "memory",
    content,
    provenance: { source: "human", refs, created: Date.now() },
    evidence: [],
    verification: { status: "unverified", check: null, lastVerifiedAt: null },
    ttl: null,
    state: "active",
    metrics: { uses: 0, successes: 0, lastUsedAt: null },
  }
}

describe("content-addressed evidence", () => {
  test("verifyEvidence accepts intact events and rejects tampered, missing, and legacy rows", () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const e1 = stepEvent("e1")
    log.append(e1)
    // Tamper with the stored payload after the fact.
    db.query("UPDATE events SET data = ? WHERE id = 'e1'").run(
      '{"type":"step","id":"e1","ts":1,"sessionId":"s","tool":"bash","args":{}}',
    )
    // A legacy row without a hash.
    db.query("INSERT INTO events (id, ts, type, session_id, data) VALUES ('legacy', 2, 'step', 's', '{}')").run()

    const result = log.verifyEvidence(["e1", "missing", "legacy"])
    expect(result.ok).toBe(false)
    expect(result.invalid.sort()).toEqual(["e1", "legacy", "missing"])
  })

  test("verifyEvidence accepts rows written by append", () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    log.append(stepEvent("e1"))
    const result = log.verifyEvidence(["e1"])
    expect(result.ok).toBe(true)
    expect(result.invalid).toEqual([])
  })

  test("a legacy database without the hash column is migrated on open", () => {
    const db = new Database(":memory:")
    db.run(`
      CREATE TABLE events (
        id TEXT PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL,
        session_id TEXT NOT NULL, data TEXT NOT NULL
      )
    `)
    const log = new SqliteLog(db)
    log.append(stepEvent("e1"))
    expect(log.replay()).toHaveLength(1)
    expect(log.verifyEvidence(["e1"]).ok).toBe(true)
  })
})

describe("write-path evidence validation", () => {
  test("a connection with a log drops citations to nonexistent events", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const self = new SqliteSelfStore(db)
    const memory = createMemoryConnection(self, log)
    const r = await memory.call({ op: "write", key: "k", content: 1 }, { sessionId: "s", stepId: "ghost" })
    expect(r.ok).toBe(true)
    expect(self.get("memory", "k")?.evidence).toEqual([])
  })

  test("a connection with a log keeps citations to real events", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    log.append(stepEvent("real-step"))
    const self = new SqliteSelfStore(db)
    const memory = createMemoryConnection(self, log)
    await memory.call({ op: "write", key: "k", content: 1 }, { sessionId: "s", stepId: "real-step" })
    expect(self.get("memory", "k")?.evidence).toEqual(["real-step"])
  })
})

describe("cascade invalidation", () => {
  test("staling a root stales everything derived from it, transitively", () => {
    const db = new Database(":memory:")
    const self = new SqliteSelfStore(db)
    const a = self.add("a", knowledge({ v: 1 }))
    const b = self.add("b", knowledge({ v: 2 }, [{ knowledgeId: a.id }]))
    const c = self.add("c", knowledge({ v: 3 }, [{ knowledgeId: b.id }]))
    const unrelated = self.add("d", knowledge({ v: 4 }))

    const { staled } = invalidateKnowledge(self, [a.id])
    expect(staled.sort()).toEqual([a.id, b.id, c.id].sort())
    expect(self.get("memory", "a")?.state).toBe("stale")
    expect(self.get("memory", "b")?.state).toBe("stale")
    expect(self.get("memory", "c")?.state).toBe("stale")
    expect(self.get("memory", "c")?.verification.status).toBe("stale")
    expect(self.get("memory", "d")?.state).toBe("active")
    expect(unrelated.state).toBe("active")
  })

  test("archived entries stop the cascade", () => {
    const db = new Database(":memory:")
    const self = new SqliteSelfStore(db)
    const a = self.add("a", knowledge({ v: 1 }))
    const b = self.add("b", knowledge({ v: 2 }, [{ knowledgeId: a.id }]))
    self.setState("memory", "b", "archived")
    self.add("c", knowledge({ v: 3 }, [{ knowledgeId: b.id }]))

    invalidateKnowledge(self, [a.id])
    expect(self.get("memory", "a")?.state).toBe("stale")
    // b was archived (untouched) and the cascade does not cross it.
    expect(self.get("memory", "b")?.state).toBe("archived")
    expect(self.get("memory", "c")?.state).toBe("active")
  })

  test("memory revoke stales the entry and its dependents", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const self = new SqliteSelfStore(db)
    const memory = createMemoryConnection(self, log)
    const root = self.add("root", knowledge({ v: 1 }))
    self.add("child", knowledge({ v: 2 }, [{ knowledgeId: root.id }]))

    const r = await memory.call({ op: "revoke", key: "root" })
    expect(r.ok).toBe(true)
    expect((r as { value: { staled: string[] } }).value.staled).toHaveLength(2)
    expect(self.get("memory", "root")?.state).toBe("stale")
    expect(self.get("memory", "child")?.state).toBe("stale")
  })

  test("derived knowledge is not injectable after invalidation", () => {
    const db = new Database(":memory:")
    const self = new SqliteSelfStore(db)
    const a = self.add("a", knowledge({ v: 1 }))
    self.add("b", knowledge({ v: 2 }, [{ knowledgeId: a.id }]))
    invalidateKnowledge(self, [a.id])
    const latest = self.latest()
    expect(latest.filter((o) => o.state === "active")).toHaveLength(0)
  })

  test("superseded derivation edges do not cascade into the new version", () => {
    const db = new Database(":memory:")
    const self = new SqliteSelfStore(db)
    const upstream = self.add("upstream", knowledge({ v: 0 }))
    // v1 depends on upstream; v2 (same name, different content) does not.
    self.add("derived", knowledge({ v: 1 }, [{ knowledgeId: upstream.id }]))
    const v2 = self.add("derived", knowledge({ v: 2 }))
    expect(v2.version).toBe(2)

    // The old version's edge is gone: upstream no longer reaches "derived".
    expect(self.dependentsOf(upstream.id)).toEqual([])
    invalidateKnowledge(self, [upstream.id])
    expect(self.get("memory", "upstream")?.state).toBe("stale")
    expect(self.get("memory", "derived")?.state).toBe("active")
  })
})

describe("harvest source quality gate", () => {
  test("poor-quality sessions distill memories as drafts", () => {
    const db = new Database(":memory:")
    const self = new SqliteSelfStore(db)
    harvestInto(
      self,
      { memories: [{ key: "m", content: { x: 1 } }], skills: [] },
      { sessionId: "s", evidenceIds: ["e1"], sourceQuality: "poor" },
    )
    const mem = self.get("memory", "m")!
    expect(mem.state).toBe("draft")
    expect(mem.evidence).toEqual(["e1"])
    expect(mem.provenance.refs).toEqual([{ sessionId: "s" }])
  })

  test("good-quality sessions distill memories as active", () => {
    const db = new Database(":memory:")
    const self = new SqliteSelfStore(db)
    harvestInto(self, { memories: [{ key: "m", content: { x: 1 } }], skills: [] }, { sourceQuality: "good" })
    expect(self.get("memory", "m")?.state).toBe("active")
  })
})

describe("verification audit trail", () => {
  test("verifyDraftSkills appends verdict events when given a log", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const self = new SqliteSelfStore(db)
    harvestInto(self, {
      memories: [],
      skills: [
        { name: "good", description: "x", steps: "x", verification: `${process.execPath} -e "process.exit(0)"` },
      ],
    })
    await verifyDraftSkills(self, process.cwd(), log, "sess-audit")
    const verdicts = log.replay().filter((e) => e.type === "verdict")
    expect(verdicts).toHaveLength(1)
    expect((verdicts[0] as { ok: boolean; sessionId: string }).ok).toBe(true)
    expect((verdicts[0] as { sessionId: string }).sessionId).toBe("sess-audit")
  })
})

describe("content hash stability", () => {
  test("contentHash of knowledge is deterministic across key order", () => {
    const h1 = contentHash({ name: "k", kind: "memory", content: { a: 1, b: 2 } })
    const h2 = contentHash({ name: "k", kind: "memory", content: { b: 2, a: 1 } })
    expect(h1).toBe(h2)
  })
})
