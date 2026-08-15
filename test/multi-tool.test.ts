import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { run } from "../src/kernel/loop.js"
import { createFakeModel } from "../src/model/fake.js"
import { type Model, ModelCallError } from "../src/model/model.js"
import { createOpenAIModel } from "../src/model/openai.js"
import { type Connection, ok } from "../src/schema/connection.js"
import { SqliteLog } from "../src/store/log.js"

function recordingConnection(name: string, calls: Array<{ tool: string; args: unknown }>): Connection {
  return {
    id: name,
    trust: "trusted",
    schema: { name, description: name, inputSchema: z.object({}) },
    async call(args: unknown) {
      calls.push({ tool: name, args })
      return ok({ ran: name })
    },
  }
}

describe("multi-tool batches", () => {
  test("a batch of tool steps executes in order within one decide call", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const calls: Array<{ tool: string; args: unknown }> = []
    const a = recordingConnection("a", calls)
    const b = recordingConnection("b", calls)
    let decides = 0
    const model: Model = {
      async decide() {
        decides += 1
        return decides === 1
          ? [
              { type: "tool", tool: "a", args: { n: 1 } },
              { type: "tool", tool: "b", args: { n: 2 } },
            ]
          : [{ type: "done", answer: "done" }]
      },
    }
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections: new Map([
        ["a", a],
        ["b", b],
      ]),
      log,
    })
    expect(result.answer).toBe("done")
    expect(result.steps).toBe(2)
    expect(decides).toBe(2)
    expect(calls.map((c) => c.tool)).toEqual(["a", "b"])
    const types = log.replay().map((e) => e.type)
    expect(types).toEqual(["turn", "step", "result", "verdict", "step", "result", "verdict", "done"])
  })

  test("a done step short-circuits the rest of the batch", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const calls: Array<{ tool: string; args: unknown }> = []
    const a = recordingConnection("a", calls)
    let decides = 0
    const model: Model = {
      async decide() {
        decides += 1
        return [
          { type: "tool", tool: "a", args: {} },
          { type: "done", answer: "early" },
          { type: "tool", tool: "a", args: { never: true } },
        ]
      },
    }
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections: new Map([["a", a]]),
      log,
    })
    expect(result.answer).toBe("early")
    expect(result.steps).toBe(1)
    expect(decides).toBe(1)
    expect(calls).toHaveLength(1)
  })

  test("fake model scripts a batch via an array entry", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const calls: Array<{ tool: string; args: unknown }> = []
    const a = recordingConnection("a", calls)
    const model = createFakeModel([
      [
        { type: "tool", tool: "a", args: { n: 1 } },
        { type: "tool", tool: "a", args: { n: 2 } },
      ],
      { type: "done", answer: "batched" },
    ])
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections: new Map([["a", a]]),
      log,
    })
    expect(result.answer).toBe("batched")
    expect(calls).toHaveLength(2)
  })
})

describe("doom-loop guard", () => {
  test("three identical calls in a row are intercepted, not executed", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const calls: Array<{ tool: string; args: unknown }> = []
    const echo = recordingConnection("echo", calls)
    let decides = 0
    const model: Model = {
      async decide() {
        decides += 1
        if (decides <= 3) return [{ type: "tool", tool: "echo", args: { text: "same" } }]
        return [{ type: "done", answer: "stopped looping" }]
      },
    }
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections: new Map([["echo", echo]]),
      log,
    })
    expect(result.answer).toBe("stopped looping")
    // Only the first two calls actually ran; the third was intercepted.
    expect(calls).toHaveLength(2)
    const results = log.replay().filter((e) => e.type === "result")
    expect(results).toHaveLength(3)
    const third = results[2] as { result: { ok: boolean; error: { code: string } } }
    expect(third.result.ok).toBe(false)
    expect(third.result.error.code).toBe("doom_loop")
  })

  test("the same call separated by other calls is not a doom loop", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    const calls: Array<{ tool: string; args: unknown }> = []
    const echo = recordingConnection("echo", calls)
    let decides = 0
    const model: Model = {
      async decide() {
        decides += 1
        if (decides === 1) return [{ type: "tool", tool: "echo", args: { text: "same" } }]
        if (decides === 2) return [{ type: "tool", tool: "echo", args: { text: "other" } }]
        if (decides === 3) return [{ type: "tool", tool: "echo", args: { text: "same" } }]
        return [{ type: "done", answer: "fine" }]
      },
    }
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections: new Map([["echo", echo]]),
      log,
    })
    expect(result.answer).toBe("fine")
    expect(calls).toHaveLength(3)
  })
})

describe("length-stop protection", () => {
  test("the openai adapter refuses truncated output instead of salvaging arguments", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return Response.json({
          choices: [
            {
              finish_reason: "length",
              message: { tool_calls: [{ function: { name: "echo", arguments: '{"text":"trunca' } }] },
            },
          ],
        })
      },
    })
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      await expect(
        model.decide({
          context: "",
          tools: [{ name: "echo", description: "e", inputSchema: z.object({ text: z.string() }) }],
          history: [],
        }),
      ).rejects.toThrow(ModelCallError)
    } finally {
      server.stop(true)
    }
  })

  test("a truncated decide is retried once by the loop, then fails the run", async () => {
    const db = new Database(":memory:")
    const log = new SqliteLog(db)
    let decides = 0
    const model: Model = {
      async decide() {
        decides += 1
        throw new ModelCallError("model output was truncated (length limit reached)")
      },
    }
    const result = await run({
      sessionId: "s",
      goal: "g",
      context: "",
      model,
      connections: new Map(),
      log,
    })
    expect(decides).toBe(2)
    expect(result.stopped).toBe("error")
    expect(result.answer).toContain("truncated")
  })
})

describe("openai multi tool_calls", () => {
  test("every tool call in the response becomes a step", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return Response.json({
          choices: [
            {
              finish_reason: "tool_calls",
              message: {
                tool_calls: [
                  { function: { name: "echo", arguments: '{"text":"a"}' } },
                  { function: { name: "echo", arguments: '{"text":"b"}' } },
                ],
              },
            },
          ],
        })
      },
    })
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      const steps = await model.decide({
        context: "",
        tools: [{ name: "echo", description: "e", inputSchema: z.object({ text: z.string() }) }],
        history: [],
      })
      expect(steps).toEqual([
        { type: "tool", tool: "echo", args: { text: "a" } },
        { type: "tool", tool: "echo", args: { text: "b" } },
      ])
    } finally {
      server.stop(true)
    }
  })
})
