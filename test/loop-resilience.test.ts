import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { run } from "../src/kernel/loop.js"
import type { Model } from "../src/model/model.js"
import { type Connection, ok } from "../src/schema/connection.js"
import { SqliteLog } from "../src/store/log.js"

function harness() {
  const db = new Database(":memory:")
  const log = new SqliteLog(db)
  const echo: Connection = {
    id: "echo",
    trust: "trusted",
    schema: {
      name: "echo",
      description: "echo",
      inputSchema: z.object({ text: z.string() }),
    },
    async call(args: unknown) {
      return ok(args)
    },
  }
  return { log, connections: new Map<string, Connection>([["echo", echo]]) }
}

describe("kernel run loop resilience", () => {
  test("a throwing connection becomes a failed result and the run continues", async () => {
    const { log, connections } = harness()
    const boom: Connection = {
      id: "boom",
      trust: "trusted",
      schema: { name: "boom", description: "boom", inputSchema: z.object({}) },
      async call() {
        throw new Error("kaboom")
      },
    }
    connections.set("boom", boom)
    // First decide: boom throws; the loop converts it into a failed result
    // and asks again; the model then finishes.
    let decides = 0
    const model: Model = {
      async decide() {
        decides += 1
        return [decides === 1 ? { type: "tool", tool: "boom", args: {} } : { type: "done", answer: "recovered" }]
      },
    }
    const result = await run({ sessionId: "s", goal: "g", context: "", model, connections, log })
    expect(result.answer).toBe("recovered")
    expect(result.stopped).toBe("done")
    const results = log.replay().filter((e) => e.type === "result")
    expect(results).toHaveLength(1)
    expect((results[0] as { result: { ok: boolean; error: { code: string; message: string } } }).result).toEqual({
      ok: false,
      error: { code: "connection_threw", message: "kaboom" },
    })
  })

  test("decide is retried once after a transient failure", async () => {
    const { log, connections } = harness()
    let calls = 0
    const model: Model = {
      async decide() {
        calls += 1
        if (calls === 1) throw new Error("transient network error")
        return [{ type: "done", answer: "ok" }]
      },
    }
    const result = await run({ sessionId: "s", goal: "g", context: "", model, connections, log })
    expect(calls).toBe(2)
    expect(result.answer).toBe("ok")
    expect(result.stopped).toBe("done")
  })

  test("two decide failures stop the run with stopped=error instead of crashing", async () => {
    const { log, connections } = harness()
    let calls = 0
    const model: Model = {
      async decide() {
        calls += 1
        throw new Error("persistent failure")
      },
    }
    const result = await run({ sessionId: "s", goal: "g", context: "", model, connections, log })
    expect(calls).toBe(2)
    expect(result.stopped).toBe("error")
    expect(result.answer).toContain("(error: model call failed")
    const doneEvents = log.replay().filter((e) => e.type === "done")
    expect(doneEvents).toHaveLength(1)
    expect((doneEvents[0] as { stopped: string }).stopped).toBe("error")
  })

  test("a decide returning no steps fails the run instead of spinning forever", async () => {
    const { log, connections } = harness()
    let calls = 0
    const model: Model = {
      async decide() {
        calls += 1
        return []
      },
    }
    const result = await run({ sessionId: "s", goal: "g", context: "", model, connections, log })
    expect(calls).toBe(1)
    expect(result.stopped).toBe("error")
    expect(result.answer).toContain("empty step batch")
    const doneEvents = log.replay().filter((e) => e.type === "done")
    expect(doneEvents).toHaveLength(1)
    expect((doneEvents[0] as { stopped: string }).stopped).toBe("error")
  })

  test("max_steps records a structured stopped field on the done event", async () => {
    const { log, connections } = harness()
    const model = {
      async decide() {
        return [{ type: "tool", tool: "echo", args: { text: "x" } } as const]
      },
    }
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections,
      log,
      maxSteps: 2,
    })
    expect(result.stopped).toBe("max_steps")
    const done = log.replay().find((e) => e.type === "done") as { stopped: string }
    expect(done.stopped).toBe("max_steps")
  })

  test("batch steps beyond maxSteps are recorded as skipped, not dropped silently", async () => {
    const { log, connections } = harness()
    const model: Model = {
      async decide() {
        return [
          { type: "tool", tool: "echo", args: { text: "1" } },
          { type: "tool", tool: "echo", args: { text: "2" } },
          { type: "tool", tool: "echo", args: { text: "3" } },
        ]
      },
    }
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections,
      log,
      maxSteps: 2,
    })
    expect(result.stopped).toBe("max_steps")
    const steps = log.replay().filter((e) => e.type === "step")
    const results = log.replay().filter((e) => e.type === "result")
    expect(steps).toHaveLength(3)
    expect(results).toHaveLength(3)
    const third = results[2] as { result: { ok: boolean; error: { code: string } } }
    expect(third.result.ok).toBe(false)
    expect(third.result.error.code).toBe("skipped_max_steps")
    // Only the two executed steps got verdicts.
    expect(log.replay().filter((e) => e.type === "verdict")).toHaveLength(2)
  })

  test("oversized tool results are truncated in history but kept full in the log", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const big = "x".repeat(10_000)
    const bigEcho: Connection = {
      id: "echo",
      trust: "trusted",
      schema: { name: "echo", description: "echo", inputSchema: z.object({}) },
      async call() {
        return ok({ data: big })
      },
    }
    const seen: unknown[] = []
    const model: Model = {
      async decide(input) {
        const toolItem = input.history.find((h) => h.role === "tool")
        if (toolItem) {
          seen.push(toolItem.result)
          return [{ type: "done", answer: "done" }]
        }
        return [{ type: "tool", tool: "echo", args: {} }]
      },
    }
    await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections: new Map([["echo", bigEcho]]),
      log,
    })
    expect(seen).toHaveLength(1)
    expect(typeof seen[0]).toBe("string")
    expect(String(seen[0])).toContain("[result truncated]")
    expect(String(seen[0]).length).toBeLessThan(5000)

    const resultEvent = log.replay().find((e) => e.type === "result") as { result: { value: { data: string } } }
    expect(resultEvent.result.value.data).toBe(big)
  })
})
