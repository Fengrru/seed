import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { type HistoryItem, ModelCallError } from "../src/model/model.js"
import { createOpenAIModel } from "../src/model/openai.js"

interface CapturedMessage {
  role: string
  content: string | null
  tool_calls?: Array<{ id: string }>
  tool_call_id?: string
}

interface RequestBody {
  messages?: CapturedMessage[]
}

function serve(handler: (body: RequestBody) => Response | Promise<Response>) {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 })
      return handler((await req.json()) as RequestBody)
    },
  })
}

const TOOLS = [{ name: "echo", description: "echo", inputSchema: z.object({ text: z.string() }) }]

describe("OpenAI model adapter", () => {
  test("decide maps a tool call to a tool step", async () => {
    const server = serve(() =>
      Response.json({
        choices: [{ message: { tool_calls: [{ function: { name: "echo", arguments: '{"text":"hi"}' } }] } }],
      }),
    )
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      const step = await model.decide({ context: "", tools: TOOLS, history: [] })
      expect(step).toEqual([{ type: "tool", tool: "echo", args: { text: "hi" } }])
    } finally {
      server.stop(true)
    }
  })

  test("decide maps the finish tool to a done step", async () => {
    const server = serve(() =>
      Response.json({
        choices: [
          { message: { tool_calls: [{ function: { name: "finish", arguments: '{"answer":"the answer"}' } }] } },
        ],
      }),
    )
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      const step = await model.decide({ context: "", tools: TOOLS, history: [] })
      expect(step).toEqual([{ type: "done", answer: "the answer" }])
    } finally {
      server.stop(true)
    }
  })

  test("decide falls back to message content when no tool is called", async () => {
    const server = serve(() => Response.json({ choices: [{ message: { content: "plain answer" } }] }))
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      const step = await model.decide({ context: "", tools: TOOLS, history: [] })
      expect(step).toEqual([{ type: "done", answer: "plain answer" }])
    } finally {
      server.stop(true)
    }
  })

  test("malformed tool arguments raise ModelCallError instead of crashing with a raw parse error", async () => {
    const server = serve(() =>
      Response.json({
        choices: [{ message: { tool_calls: [{ function: { name: "echo", arguments: "not json" } }] } }],
      }),
    )
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      await expect(model.decide({ context: "", tools: TOOLS, history: [] })).rejects.toThrow(ModelCallError)
    } finally {
      server.stop(true)
    }
  })

  test("invalid finish arguments raise ModelCallError", async () => {
    const server = serve(() =>
      Response.json({
        choices: [{ message: { tool_calls: [{ function: { name: "finish", arguments: '{"wrong":true}' } }] } }],
      }),
    )
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      await expect(model.decide({ context: "", tools: TOOLS, history: [] })).rejects.toThrow(ModelCallError)
    } finally {
      server.stop(true)
    }
  })

  test("non-2xx responses surface the status", async () => {
    const server = serve(() => new Response("boom", { status: 500 }))
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      await expect(model.decide({ context: "", tools: TOOLS, history: [] })).rejects.toThrow("model error: 500")
    } finally {
      server.stop(true)
    }
  })

  test("decide times out when the upstream never responds", async () => {
    const server = serve(() => new Promise<Response>(() => {}))
    try {
      const model = createOpenAIModel({
        baseUrl: `http://127.0.0.1:${server.port}/v1`,
        apiKey: "k",
        model: "m",
        timeoutMs: 300,
      })
      await expect(model.decide({ context: "", tools: TOOLS, history: [] })).rejects.toThrow("timed out")
    } finally {
      server.stop(true)
    }
  })

  test("harvest parses a well-formed distillation", async () => {
    const server = serve(() =>
      Response.json({
        choices: [
          {
            message: {
              content: JSON.stringify({
                memories: [{ key: "m1", content: { a: 1 } }],
                skills: [{ name: "s1", description: "d", steps: "do it", verification: "test -f x" }],
              }),
            },
          },
        ],
      }),
    )
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      const out = await model.harvest?.("transcript")
      expect(out?.memories).toEqual([{ key: "m1", content: { a: 1 } }])
      expect(out?.skills[0]?.verification).toBe("test -f x")
    } finally {
      server.stop(true)
    }
  })

  test("harvest returns an empty distillation on malformed JSON instead of throwing", async () => {
    const server = serve(() => Response.json({ choices: [{ message: { content: "this is not json" } }] }))
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      const out = await model.harvest?.("transcript")
      expect(out).toEqual({ memories: [], skills: [] })
    } finally {
      server.stop(true)
    }
  })

  test("summarizeRounds returns the trimmed model summary", async () => {
    const server = serve(() =>
      Response.json({ choices: [{ message: { content: "  A compact summary of the turns.  " } }] }),
    )
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      expect(await model.summarizeRounds?.("transcript")).toBe("A compact summary of the turns.")
    } finally {
      server.stop(true)
    }
  })

  test("summarizeRounds surfaces upstream errors so the caller can fall back", async () => {
    const server = serve(() => new Response("boom", { status: 500 }))
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      await expect(model.summarizeRounds?.("transcript")).rejects.toThrow("compact error: 500")
    } finally {
      server.stop(true)
    }
  })

  test("oversized history is capped and earlier messages are marked omitted", async () => {
    const state: { captured: RequestBody | null } = { captured: null }
    const server = serve((body) => {
      state.captured = body
      return Response.json({ choices: [{ message: { content: "ok" } }] })
    })
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      const bigResult = "y".repeat(100_000)
      const history: HistoryItem[] = [
        { role: "user", content: "first goal" },
        { role: "assistant-tool", toolCallId: "c1", tool: "echo", args: {} },
        { role: "tool", toolCallId: "c1", result: bigResult },
        { role: "user", content: "second goal" },
      ]
      await model.decide({ context: "", tools: TOOLS, history })
      const messages = state.captured?.messages ?? []
      const first = messages.find((m) => m.content?.includes("first goal"))
      expect(first).toBeUndefined()
      expect(messages.some((m) => m.content?.includes("omitted"))).toBe(true)
      expect(messages.some((m) => m.content?.includes("second goal"))).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test("budget truncation never orphans a tool result from its tool call", async () => {
    const state: { captured: RequestBody | null } = { captured: null }
    const server = serve((body) => {
      state.captured = body
      return Response.json({ choices: [{ message: { content: "ok" } }] })
    })
    try {
      const model = createOpenAIModel({ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "k", model: "m" })
      // The oversized args force the budget cut to land between c1's tool call
      // and its result, which without the fix leaves an orphaned tool message
      // at the front of the kept suffix — a shape the API rejects.
      const history: HistoryItem[] = [
        { role: "user", content: "first goal" },
        { role: "assistant-tool", toolCallId: "c1", tool: "echo", args: { text: "x".repeat(61_000) } },
        { role: "tool", toolCallId: "c1", result: { ok: true } },
        { role: "user", content: "second goal" },
        { role: "assistant-tool", toolCallId: "c2", tool: "echo", args: {} },
        { role: "tool", toolCallId: "c2", result: { ok: true } },
      ]
      await model.decide({ context: "", tools: TOOLS, history })
      const messages = state.captured?.messages ?? []
      const toolIds = messages.map((m) => m.tool_call_id).filter((id) => id !== undefined)
      expect(toolIds).not.toContain("c1")
      expect(toolIds).toContain("c2")
      expect(messages.some((m) => m.content?.includes("omitted"))).toBe(true)
      // First non-system message is the omitted-marker, never an orphaned
      // tool result.
      expect(messages[1]?.role).toBe("user")
      expect(messages[1]?.content).toContain("omitted")
    } finally {
      server.stop(true)
    }
  })
})
