process.stdin.setEncoding("utf8")

let buffer = ""

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function handle(msg: { jsonrpc: string; id?: number; method?: string; params?: unknown }): void {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "fake-mcp", version: "1.0.0" },
      },
    })
    return
  }
  if (msg.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        tools: [
          {
            name: "echo",
            description: "echo the input text",
            inputSchema: {
              type: "object",
              properties: { text: { type: "string" } },
              required: ["text"],
            },
          },
          {
            name: "add",
            description: "add two numbers",
            inputSchema: {
              type: "object",
              properties: { a: { type: "number" }, b: { type: "number" } },
              required: ["a", "b"],
            },
          },
        ],
      },
    })
    return
  }
  if (msg.method === "tools/call") {
    const params = msg.params as { name: string; arguments?: Record<string, unknown> }
    if (params.name === "echo") {
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: `echo: ${String(params.arguments?.text ?? "")}` }] },
      })
      return
    }
    if (params.name === "add") {
      const a = Number(params.arguments?.a)
      const b = Number(params.arguments?.b)
      send({
        jsonrpc: "2.0",
        id: msg.id,
        result: { content: [{ type: "text", text: String(a + b) }] },
      })
      return
    }
  }
  send({ jsonrpc: "2.0", id: msg.id, result: {} })
}

process.stdin.on("data", (chunk: string) => {
  buffer += chunk
  let idx: number
  while ((idx = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, idx).trim()
    buffer = buffer.slice(idx + 1)
    if (line) {
      try {
        handle(JSON.parse(line))
      } catch {
        // ignore malformed lines
      }
    }
  }
})
