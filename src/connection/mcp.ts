import { z } from "zod"
import { type Connection, fail, ok } from "../schema/connection.js"
import type { McpClient } from "./mcp-client.js"

export function createMcpConnections(client: McpClient): Connection[] {
  return client.getTools().map((tool) => ({
    id: `mcp_${tool.name}`,
    trust: "reviewed",
    schema: {
      name: tool.name,
      description: tool.description,
      inputSchema: z.record(z.unknown()),
      jsonSchema: tool.inputSchema,
    },
    async call(args: unknown) {
      try {
        const r = await client.callTool(tool.name, args)
        return r.isError ? fail("mcp_tool_error", r.content) : ok({ content: r.content })
      } catch (e) {
        return fail("mcp_call_failed", e instanceof Error ? e.message : String(e))
      }
    },
  }))
}
