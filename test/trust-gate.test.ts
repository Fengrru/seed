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
  return { log }
}

function gatedConnection(id: string, trust: Connection["trust"], calls: string[]): Connection {
  return {
    id,
    trust,
    schema: { name: id, description: id, inputSchema: z.object({}) },
    async call() {
      calls.push(id)
      return ok({ ran: true })
    },
  }
}

function model(_calls: string[], tool: string): Model {
  let decides = 0
  return {
    async decide() {
      decides += 1
      return [decides === 1 ? { type: "tool", tool, args: {} } : { type: "done", answer: "done" }]
    },
  }
}

describe("trust gate", () => {
  test("an approved below-threshold call runs", async () => {
    const { log } = harness()
    const calls: string[] = []
    const conn = gatedConnection("untrusted-tool", "untrusted", calls)
    const approvals: string[] = []
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model: model(calls, "untrusted-tool"),
      connections: new Map([["untrusted-tool", conn]]),
      log,
      confirmBelow: "reviewed",
      approve: async (c) => {
        approvals.push(c.id)
        return true
      },
    })
    expect(result.answer).toBe("done")
    expect(calls).toEqual(["untrusted-tool"])
    expect(approvals).toEqual(["untrusted-tool"])
  })

  test("a denied below-threshold call becomes approval_denied and never runs", async () => {
    const { log } = harness()
    const calls: string[] = []
    const conn = gatedConnection("untrusted-tool", "untrusted", calls)
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model: model(calls, "untrusted-tool"),
      connections: new Map([["untrusted-tool", conn]]),
      log,
      confirmBelow: "reviewed",
      approve: async () => false,
    })
    expect(result.answer).toBe("done")
    expect(calls).toEqual([])
    const results = log.replay().filter((e) => e.type === "result")
    expect((results[0] as { result: { error: { code: string } } }).result.error.code).toBe("approval_denied")
  })

  test("below-threshold without an approve callback fails approval_required", async () => {
    const { log } = harness()
    const calls: string[] = []
    const conn = gatedConnection("untrusted-tool", "untrusted", calls)
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model: model(calls, "untrusted-tool"),
      connections: new Map([["untrusted-tool", conn]]),
      log,
      confirmBelow: "reviewed",
    })
    expect(result.answer).toBe("done")
    expect(calls).toEqual([])
    const results = log.replay().filter((e) => e.type === "result")
    expect((results[0] as { result: { error: { code: string } } }).result.error.code).toBe("approval_required")
  })

  test("trusted connections are not gated by default", async () => {
    const { log } = harness()
    const calls: string[] = []
    const conn = gatedConnection("trusted-tool", "trusted", calls)
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model: model(calls, "trusted-tool"),
      connections: new Map([["trusted-tool", conn]]),
      log,
      confirmBelow: "untrusted",
    })
    expect(result.answer).toBe("done")
    expect(calls).toEqual(["trusted-tool"])
  })

  test("reviewed connections are gated when confirmBelow is trusted", async () => {
    const { log } = harness()
    const calls: string[] = []
    const conn = gatedConnection("reviewed-tool", "reviewed", calls)
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model: model(calls, "reviewed-tool"),
      connections: new Map([["reviewed-tool", conn]]),
      log,
      confirmBelow: "trusted",
    })
    expect(result.answer).toBe("done")
    expect(calls).toEqual([])
    const results = log.replay().filter((e) => e.type === "result")
    expect((results[0] as { result: { error: { code: string } } }).result.error.code).toBe("approval_required")
  })

  test("an approved reviewed call runs when confirmBelow is trusted", async () => {
    const { log } = harness()
    const calls: string[] = []
    const conn = gatedConnection("reviewed-tool", "reviewed", calls)
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model: model(calls, "reviewed-tool"),
      connections: new Map([["reviewed-tool", conn]]),
      log,
      confirmBelow: "trusted",
      approve: async () => true,
    })
    expect(result.answer).toBe("done")
    expect(calls).toEqual(["reviewed-tool"])
  })
})
