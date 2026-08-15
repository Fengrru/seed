export interface McpServerConfig {
  command: string
  args: string[]
  env?: Record<string, string>
  requestTimeoutMs?: number
}

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

export interface McpClient {
  getTools(): McpTool[]
  callTool(name: string, args: unknown): Promise<{ content: string; isError: boolean }>
  close(): void
}

interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number
  result?: unknown
  error?: { code: number; message: string }
}

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
}

interface Sink {
  write(data: string): undefined | number
  end?(): void
}

const DEFAULT_TIMEOUT_MS = 30_000
// A single line larger than this means a broken or hostile server; dropping
// the buffer beats letting memory grow without bound.
const MAX_BUFFER_CHARS = 10 * 1024 * 1024

export class McpStdioClient implements McpClient {
  private readonly config: McpServerConfig
  private proc: ReturnType<typeof Bun.spawn> | null = null
  private stdin: Sink | null = null
  private nextId = 1
  private readonly pending = new Map<number, Pending>()
  private tools: McpTool[] = []
  private buffer = ""
  private closed = false

  constructor(config: McpServerConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    try {
      const proc = Bun.spawn([this.config.command, ...this.config.args], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        ...(this.config.env === undefined ? {} : { env: this.config.env }),
      })
      this.proc = proc
      this.stdin = proc.stdin as unknown as Sink
      void this.consume(proc.stdout as ReadableStream<Uint8Array>)
      // stderr must be drained: a chatty server that fills the pipe buffer
      // would block itself (and us) forever.
      void this.discard(proc.stderr as ReadableStream<Uint8Array>)
      // Belt and braces: on some platforms the stdout pipe does not report EOF
      // promptly when the child exits, so watch the process itself as well.
      void proc.exited.finally(() => {
        this.rejectPending(new Error("mcp server closed connection"))
      })
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "seed", version: "0.1.0" },
      })
      this.notify("notifications/initialized")
      const result = (await this.request("tools/list", {})) as { tools: McpTool[] }
      this.tools = result.tools ?? []
    } catch (e) {
      // A failed handshake must not leak the spawned subprocess: the client
      // owns its process lifecycle and closes itself on failure.
      this.close()
      throw e
    }
  }

  getTools(): McpTool[] {
    return this.tools
  }

  async callTool(name: string, args: unknown): Promise<{ content: string; isError: boolean }> {
    const result = (await this.request("tools/call", { name, arguments: args })) as {
      content?: Array<{ type: string; text?: string }>
      isError?: boolean
    }
    const content = (result.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n")
    return { content, isError: result.isError ?? false }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.stdin?.end?.()
    this.stdin = null
    this.proc?.kill()
    this.proc = null
    this.rejectPending(new Error("mcp client closed"))
  }

  private rejectPending(reason: Error): void {
    for (const [id, pending] of this.pending) {
      pending.reject(reason)
      this.pending.delete(id)
    }
  }

  private request(method: string, params?: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("mcp client closed"))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`mcp request timed out: ${method}`))
      }, this.config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS)
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        reject: (reason) => {
          clearTimeout(timer)
          reject(reason)
        },
      })
      this.send({ jsonrpc: "2.0", id, method, params })
    })
  }

  private notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: "2.0", method, params })
  }

  private send(msg: { jsonrpc: "2.0"; method: string; id?: number; params?: unknown }): void {
    if (!this.stdin) throw new Error("mcp client not connected")
    this.stdin.write(`${JSON.stringify(msg)}\n`)
  }

  private async consume(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    const decoder = new TextDecoder()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        this.buffer += decoder.decode(value, { stream: true })
        if (this.buffer.length > MAX_BUFFER_CHARS) {
          this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFER_CHARS)
        }
        this.drain()
      }
    } catch {
      // stream closed
    } finally {
      reader.releaseLock()
    }
    // Server exited (or crashed) with requests still in flight: reject them
    // now instead of making callers wait out the timeout.
    this.rejectPending(new Error("mcp server closed connection"))
  }

  private async discard(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader()
    try {
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
    } catch {
      // stderr closed
    } finally {
      reader.releaseLock()
    }
  }

  private drain(): void {
    let idx: number
    while ((idx = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, idx).trim()
      this.buffer = this.buffer.slice(idx + 1)
      if (line) this.handleLine(line)
    }
  }

  private handleLine(line: string): void {
    let msg: JsonRpcResponse
    try {
      msg = JSON.parse(line) as JsonRpcResponse
    } catch {
      return
    }
    const pending = this.pending.get(msg.id)
    if (!pending) return
    this.pending.delete(msg.id)
    if (msg.error) pending.reject(new Error(msg.error.message))
    else pending.resolve(msg.result)
  }
}
