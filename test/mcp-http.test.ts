import { describe, expect, test } from "bun:test"
import { createMcpConnections } from "../src/connection/mcp.js"
import { McpHttpClient } from "../src/connection/mcp-http.js"

interface JsonRpc {
  jsonrpc: string
  id?: number
  method?: string
  params?: unknown
}

function fakeMcpServer() {
  return Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 })
      const body = (await req.json()) as JsonRpc

      const reply = (id: number | undefined, result: unknown, init: ResponseInit = {}) =>
        Response.json({ jsonrpc: "2.0", id, result }, init)

      if (body.method === "initialize") {
        return reply(
          body.id,
          { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "fake", version: "1" } },
          {
            headers: { "mcp-session-id": "sess-1" },
          },
        )
      }
      if (body.method === "notifications/initialized") return new Response(null, { status: 202 })
      if (body.method === "tools/list") {
        return reply(body.id, {
          tools: [
            {
              name: "echo",
              description: "echo",
              inputSchema: { type: "object", properties: { text: { type: "string" } } },
            },
          ],
        })
      }
      if (body.method === "tools/call") {
        const p = body.params as { name: string; arguments?: { text?: string } }
        return reply(body.id, { content: [{ type: "text", text: `http-echo: ${p.arguments?.text ?? ""}` }] })
      }
      return reply(body.id, {})
    },
  })
}

describe("MCP streamable HTTP client", () => {
  test("connects, discovers tools, and calls them over HTTP", async () => {
    const server = fakeMcpServer()
    const client = new McpHttpClient({ url: `http://127.0.0.1:${server.port}/mcp` })
    try {
      await client.connect()
      expect(client.getTools().map((t) => t.name)).toEqual(["echo"])
      const r = await client.callTool("echo", { text: "hi" })
      expect(r.content).toBe("http-echo: hi")
      expect(r.isError).toBe(false)
    } finally {
      server.stop(true)
    }
  })

  test("bridges MCP HTTP tools to the Connection contract", async () => {
    const server = fakeMcpServer()
    const client = new McpHttpClient({ url: `http://127.0.0.1:${server.port}/mcp` })
    try {
      await client.connect()
      const connections = createMcpConnections(client)
      const echo = connections.find((c) => c.schema.name === "echo")!
      expect(echo.id).toBe("mcp_echo")
      const r = await echo.call({ text: "yo" })
      expect((r as { value: { content: string } }).value.content).toBe("http-echo: yo")
    } finally {
      server.stop(true)
    }
  })
})
