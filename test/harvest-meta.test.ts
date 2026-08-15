import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { harvestInto } from "../src/kernel/harvest.js"
import { analyzeEvents, buildGuidance, metacognize } from "../src/kernel/meta.js"
import type { HarvestOutput } from "../src/model/model.js"
import type { Event } from "../src/schema/event.js"
import { renderTranscript } from "../src/session/history.js"
import { SqliteSelfStore } from "../src/store/self.js"

describe("harvest", () => {
  test("stores memories and skills with trajectory provenance", () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const output: HarvestOutput = {
      memories: [{ key: "pref", content: { x: 1 } }],
      skills: [{ name: "s", description: "d", steps: "do", verification: `${process.execPath} -e "process.exit(0)"` }],
    }
    const result = harvestInto(self, output)
    expect(result).toEqual({ memories: 1, skills: 1 })

    const mem = self.get("memory", "pref")!
    expect(mem.provenance.source).toBe("trajectory")
    expect(mem.kind).toBe("memory")

    const skill = self.get("skill", "s")!
    expect(skill.kind).toBe("skill")
    expect(skill.state).toBe("draft")
    expect(skill.verification.check).toEqual({ type: "command", cmd: `${process.execPath} -e "process.exit(0)"` })
  })

  test("harvestInto records no pseudo-evidence from a session id", () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const output: HarvestOutput = { memories: [{ key: "m", content: 1 }], skills: [] }
    harvestInto(self, output, { sessionId: "s" })
    const mem = self.get("memory", "m")!
    expect(mem.evidence).toEqual([])
  })
})

describe("renderTranscript", () => {
  test("renders events as readable text", () => {
    const t = renderTranscript([
      { type: "turn", id: "t1", ts: 1, sessionId: "x", goal: "hi" },
      { type: "step", id: "s1", ts: 2, sessionId: "x", tool: "echo", args: { a: 1 } },
      { type: "result", id: "r1", ts: 3, sessionId: "x", stepId: "s1", result: { ok: true } },
      { type: "done", id: "d1", ts: 4, sessionId: "x", answer: "done" },
    ])
    expect(t).toContain("User: hi")
    expect(t).toContain("Assistant called echo")
    expect(t).toContain("Tool result:")
    expect(t).toContain("Assistant: done")
  })

  test("renders the task tree with indentation", () => {
    const t = renderTranscript([
      { type: "task", id: "k1", ts: 1, sessionId: "x", taskId: "T1", parentId: null, status: "open", title: "root" },
      { type: "task", id: "k2", ts: 2, sessionId: "x", taskId: "T1.1", parentId: "T1", status: "open", title: "child" },
      { type: "task", id: "k3", ts: 3, sessionId: "x", taskId: "T1.1", parentId: null, status: "done", title: "" },
    ])
    expect(t).toContain("Task T1: root [open]")
    expect(t).toContain("  Task T1.1: child [done]")
  })
})

describe("metacognition", () => {
  function events(): Event[] {
    return [
      { type: "step", id: "s1", ts: 1, sessionId: "x", tool: "bash", args: {} },
      { type: "result", id: "r1", ts: 2, sessionId: "x", stepId: "s1", result: { ok: false } },
      { type: "step", id: "s2", ts: 3, sessionId: "x", tool: "bash", args: {} },
      { type: "result", id: "r2", ts: 4, sessionId: "x", stepId: "s2", result: { ok: false } },
      { type: "step", id: "s3", ts: 5, sessionId: "x", tool: "bash", args: {} },
      { type: "result", id: "r3", ts: 6, sessionId: "x", stepId: "s3", result: { ok: false } },
    ]
  }

  test("analyzeEvents detects repeated and failed tools", () => {
    const stats = analyzeEvents(events())
    expect(stats.repeatedTools).toEqual([{ tool: "bash", count: 3 }])
    expect(stats.failedTools).toEqual([{ tool: "bash", count: 3 }])
  })

  test("metacognize writes per-tool self-reflections with actionable content", () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const result = metacognize(events(), self)
    expect(result.some((r) => r.includes("bash"))).toBe(true)
    expect(result.some((r) => r.includes("failed"))).toBe(true)
    const reflection = self.get("memory", "self-reflection:bash")!
    expect(reflection.provenance.source).toBe("self-reflection")
    expect(JSON.stringify(reflection.content)).toContain("different approach")
  })

  test("metacognize is a no-op for clean sessions", () => {
    const self = new SqliteSelfStore(new Database(":memory:"))
    const clean: Event[] = [
      { type: "step", id: "s1", ts: 1, sessionId: "x", tool: "read", args: {} },
      { type: "result", id: "r1", ts: 2, sessionId: "x", stepId: "s1", result: { ok: true } },
    ]
    expect(metacognize(clean, self)).toEqual([])
  })

  test("buildGuidance produces a note from failures", () => {
    expect(buildGuidance(events())).toContain("bash failed 3x")
    expect(buildGuidance([])).toBe("")
  })
})
