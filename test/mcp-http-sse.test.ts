import { describe, expect, test } from "bun:test"
import { McpHttpClient } from "../src/connection/mcp-http.js"

interface JsonRpc {
  jsonrpc: string
  id?: number
  method?: string
  params?: unknown
}

function sseHoldingServer() {
  const sessionHeaders: Array<string | null> = []
  let deleteReceived = false
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      sessionHeaders.push(req.headers.get("mcp-session-id"))
      if (req.method === "DELETE") {
        deleteReceived = true
        return new Response(null, { status: 200 })
      }
      const body = (await req.json()) as JsonRpc

      if (body.method === "initialize") {
        return Response.json(
          {
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "sse", version: "1" } },
          },
          { headers: { "mcp-session-id": "sess-1" } },
        )
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (body.method === "tools/list") {
        return Response.json({
          jsonrpc: "2.0",
          id: body.id,
          result: { tools: [{ name: "echo", description: "echo", inputSchema: { type: "object" } }] },
        })
      }
      if (body.method === "tools/call") {
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: body.id,
          result: { content: [{ type: "text", text: "sse-result" }] },
        })
        // Split across two data: lines at a token boundary (the spec joins
        // them with "\n"), then hold the stream open, as streamable HTTP
        // servers do after delivering the response.
        const cut = payload.indexOf(",") + 1
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            controller.enqueue(encoder.encode(`event: message\ndata: ${payload.slice(0, cut)}\n`))
            controller.enqueue(encoder.encode(`data: ${payload.slice(cut)}\n\n`))
          },
          cancel() {
            // client stopped reading once it found its id — expected
          },
        })
        return new Response(stream, { headers: { "content-type": "text/event-stream" } })
      }
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {} })
    },
  })
  return { server, sessionHeaders, isDeleteReceived: () => deleteReceived }
}

describe("MCP streamable HTTP client (SSE)", () => {
  test("returns the result without waiting for the held-open stream to end", async () => {
    const { server } = sseHoldingServer()
    const client = new McpHttpClient({ url: `http://127.0.0.1:${server.port}/mcp` })
    try {
      await client.connect()
      const started = Date.now()
      const r = await client.callTool("echo", { text: "hi" })
      expect(r.content).toBe("sse-result")
      expect(Date.now() - started).toBeLessThan(5_000)
    } finally {
      server.stop(true)
    }
  })

  test("echoes the captured session id on subsequent requests and sends DELETE on close", async () => {
    const { server, sessionHeaders, isDeleteReceived } = sseHoldingServer()
    const client = new McpHttpClient({ url: `http://127.0.0.1:${server.port}/mcp` })
    try {
      await client.connect()
      const r = await client.callTool("echo", { text: "hi" })
      expect(r.content).toBe("sse-result")
      expect(sessionHeaders.slice(2).some((h) => h === "sess-1")).toBe(true)
      client.close()
      await new Promise((res) => setTimeout(res, 200))
      expect(isDeleteReceived()).toBe(true)
    } finally {
      server.stop(true)
    }
  })

  test("requests time out when the server never responds", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch() {
        return new Promise<Response>(() => {})
      },
    })
    try {
      const client = new McpHttpClient({
        url: `http://127.0.0.1:${server.port}/mcp`,
        requestTimeoutMs: 300,
      })
      await expect(client.connect()).rejects.toThrow("timed out")
    } finally {
      server.stop(true)
    }
  })

  test("an empty tools/call result raises a clear error instead of a TypeError", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as JsonRpc
        if (body.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "s", version: "1" } },
          })
        }
        if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
        if (body.method === "tools/list") {
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [] } })
        }
        // tools/call: respond with no result field at all
        return Response.json({ jsonrpc: "2.0", id: body.id })
      },
    })
    try {
      const client = new McpHttpClient({ url: `http://127.0.0.1:${server.port}/mcp` })
      await client.connect()
      await expect(client.callTool("echo", {})).rejects.toThrow("empty tool result")
    } finally {
      server.stop(true)
    }
  })
})
