import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { createMcpConnections } from "../src/connection/mcp.js"
import { McpStdioClient } from "../src/connection/mcp-client.js"

function fixtureCommand(): { command: string; args: string[] } {
  const fixture = fileURLToPath(new URL("./fixtures/fake-mcp-server.ts", import.meta.url))
  return { command: "bun", args: [fixture] }
}

describe("MCP stdio client", () => {
  test("connects, discovers tools, and calls them", async () => {
    const client = new McpStdioClient(fixtureCommand())
    await client.connect()
    try {
      const tools = client.getTools()
      expect(tools.map((t) => t.name)).toEqual(["echo", "add"])

      const echo = await client.callTool("echo", { text: "hi" })
      expect(echo.content).toBe("echo: hi")
      expect(echo.isError).toBe(false)

      const add = await client.callTool("add", { a: 2, b: 3 })
      expect(add.content).toBe("5")
    } finally {
      client.close()
    }
  })
})

describe("MCP connections", () => {
  test("bridges MCP tools to the Connection contract", async () => {
    const client = new McpStdioClient(fixtureCommand())
    await client.connect()
    try {
      const connections = createMcpConnections(client)
      const echo = connections.find((c) => c.schema.name === "echo")!
      expect(echo.id).toBe("mcp_echo")
      expect(echo.schema.jsonSchema).toMatchObject({ type: "object" })

      const r = await echo.call({ text: "hello" })
      expect(r.ok).toBe(true)
      expect((r as { value: { content: string } }).value.content).toBe("echo: hello")
    } finally {
      client.close()
    }
  })
})
