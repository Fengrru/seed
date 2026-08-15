import { describe, expect, test } from "bun:test"
import { fileURLToPath } from "node:url"
import { McpStdioClient } from "../src/connection/mcp-client.js"

function fixtureCommand(mode: string): { command: string; args: string[] } {
  const fixture = fileURLToPath(new URL("./fixtures/tricky-mcp-server.ts", import.meta.url))
  return { command: "bun", args: [fixture, mode] }
}

describe("MCP stdio client resilience", () => {
  test("a server flooding stderr does not deadlock the client", async () => {
    const client = new McpStdioClient(fixtureCommand("noise"))
    await client.connect()
    try {
      const r = await client.callTool("echo", { text: "hi" })
      expect(r.content).toBe("ok")
    } finally {
      client.close()
    }
  })

  test("a server that crashes mid-request rejects pending calls immediately", async () => {
    const client = new McpStdioClient(fixtureCommand("crash"))
    await client.connect()
    try {
      await expect(client.callTool("echo", { text: "hi" })).rejects.toThrow("mcp server closed connection")
    } finally {
      client.close()
    }
  })

  test("requests time out after the configured window", async () => {
    const client = new McpStdioClient({ ...fixtureCommand("hang"), requestTimeoutMs: 300 })
    await client.connect()
    try {
      await expect(client.callTool("echo", { text: "hi" })).rejects.toThrow("timed out")
    } finally {
      client.close()
    }
  })

  test("close rejects in-flight requests", async () => {
    const client = new McpStdioClient(fixtureCommand("hang"))
    await client.connect()
    const pending = client.callTool("echo", { text: "hi" })
    await new Promise((r) => setTimeout(r, 100)) // let the request reach the server
    client.close()
    await expect(pending).rejects.toThrow("mcp client closed")
  })

  test("a failed connect closes the client instead of leaking the subprocess", async () => {
    const client = new McpStdioClient({ command: "bun", args: ["-e", "process.exit(1)"] })
    await expect(client.connect()).rejects.toThrow("mcp server closed connection")
    // close() ran during the failed connect: further calls fail closed
    // instead of talking to a zombie process.
    await expect(client.callTool("echo", { text: "hi" })).rejects.toThrow("mcp client closed")
  })
})
