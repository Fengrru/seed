// Modes: "noise" writes a flood of stderr before serving (proves the client
// drains stderr), "crash" exits without replying to tools/call (proves pending
// requests are rejected on EOF), "hang" never replies to tools/call (used with
// a short client timeout).
const mode = process.argv[2] ?? "normal"

if (mode === "noise") {
  for (let i = 0; i < 8000; i++) {
    process.stderr.write(`noise ${i} lorem ipsum dolor sit amet consectetur adipiscing elit\n`)
  }
}

process.stdin.setEncoding("utf8")

let buffer = ""

function send(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`)
}

function handle(msg: { jsonrpc: string; id?: number; method?: string }): void {
  if (msg.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "tricky-mcp", version: "1.0.0" },
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
        ],
      },
    })
    return
  }
  if (msg.method === "tools/call") {
    if (mode === "crash") {
      process.exit(1)
    }
    if (mode === "hang") {
      return // never reply
    }
    send({
      jsonrpc: "2.0",
      id: msg.id,
      result: { content: [{ type: "text", text: "ok" }] },
    })
  }
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

// Standalone script executed by bun; the export keeps its top-level names
// module-scoped so they do not collide with other fixture scripts in the
// typecheck program.
export {}
