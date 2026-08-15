import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { run } from "../src/kernel/loop.js"
import { createFakeModel } from "../src/model/fake.js"
import type { HistoryItem, Model } from "../src/model/model.js"
import { type Connection, ok } from "../src/schema/connection.js"
import type { Event } from "../src/schema/event.js"
import { SqliteLog } from "../src/store/log.js"

function harness() {
  const db = new Database(":memory:")
  const log = new SqliteLog(db)
  const order: string[] = []
  const echo: Connection = {
    id: "echo",
    trust: "trusted",
    schema: {
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
    },
    async call(args: unknown) {
      order.push("call")
      return ok(args)
    },
  }
  const connections = new Map<string, Connection>([["echo", echo]])
  return { log, order, connections }
}

describe("kernel run loop", () => {
  test("runs to done and returns the answer", async () => {
    const { log, order, connections } = harness()
    const model = createFakeModel([
      { type: "tool", tool: "echo", args: { text: "hi" } },
      { type: "done", answer: "finished" },
    ])
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections,
      log,
    })
    expect(result.answer).toBe("finished")
    expect(result.steps).toBe(1)
    expect(result.stopped).toBe("done")
    expect(order).toEqual(["call"])
  })

  test("invariant I6: step persisted BEFORE connection executes", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const timeline: string[] = []
    const echo: Connection = {
      id: "echo",
      trust: "trusted",
      schema: { name: "echo", description: "echo", inputSchema: z.object({ text: z.string() }) },
      async call(args: unknown) {
        timeline.push("call")
        return ok(args)
      },
    }
    const recordingLog = {
      append(e: Event) {
        timeline.push(`log:${e.type}`)
        log.append(e)
      },
      replay: log.replay.bind(log),
      replaySince: log.replaySince.bind(log),
      replaySession: log.replaySession.bind(log),
      replayRecent: log.replayRecent.bind(log),
      eventsBefore: log.eventsBefore.bind(log),
      pruneBefore: log.pruneBefore.bind(log),
      verifyEvidence: log.verifyEvidence.bind(log),
    }
    const model = createFakeModel([{ type: "tool", tool: "echo", args: { text: "x" } }])
    await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections: new Map([["echo", echo]]),
      log: recordingLog,
    })
    const stepIdx = timeline.indexOf("log:step")
    const callIdx = timeline.indexOf("call")
    const resultIdx = timeline.indexOf("log:result")
    expect(stepIdx).toBeGreaterThanOrEqual(0)
    expect(callIdx).toBeGreaterThanOrEqual(0)
    expect(stepIdx).toBeLessThan(callIdx)
    expect(resultIdx).toBeGreaterThan(callIdx)
  })

  test("unknown tool is recorded as a failed result, not thrown", async () => {
    const { log, connections } = harness()
    const model = createFakeModel([
      { type: "tool", tool: "does-not-exist", args: {} },
      { type: "done", answer: "ok" },
    ])
    const result = await run({ sessionId: "s", goal: "g", context: "", model, connections, log })
    expect(result.answer).toBe("ok")
    const results = log.replay().filter((e) => e.type === "result")
    expect(results).toHaveLength(1)
    expect((results[0] as { result: { ok: boolean } }).result.ok).toBe(false)
  })

  test("verify hook runs and verdict is logged", async () => {
    const { log, connections } = harness()
    const model = createFakeModel([
      { type: "tool", tool: "echo", args: {} },
      { type: "done", answer: "ok" },
    ])
    const verifications: string[] = []
    await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections,
      log,
      verify: async () => {
        verifications.push("ran")
        return { ok: true, detail: "checked" }
      },
    })
    expect(verifications).toEqual(["ran"])
    const verdicts = log.replay().filter((e) => e.type === "verdict")
    expect(verdicts).toHaveLength(1)
  })

  test("maxSteps bounds a never-finishing model", async () => {
    const { log, connections } = harness()
    const model = createFakeModel([{ type: "tool", tool: "echo", args: {} }])
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections,
      log,
      maxSteps: 3,
    })
    expect(result.stopped).toBe("max_steps")
    expect(result.steps).toBe(3)
  })

  test("history accumulates: goal + step + result are fed back", async () => {
    const { log, connections } = harness()
    const seen: HistoryItem[][] = []
    const model: Model = {
      async decide(input) {
        seen.push([...input.history])
        if (seen.length === 1) return [{ type: "tool", tool: "echo", args: { n: 1 } }]
        return [{ type: "done", answer: "done" }]
      },
    }
    await run({ sessionId: "s", goal: "g", context: "", model, connections, log })
    expect(seen).toHaveLength(2)
    expect(seen[0]?.map((i) => i.role)).toEqual(["user"])
    expect(seen[1]?.map((i) => i.role)).toEqual(["user", "assistant-tool", "tool"])
  })
})
