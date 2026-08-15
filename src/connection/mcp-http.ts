import { fetchWithTimeout } from "../util/fetch.js"
import type { McpClient, McpTool } from "./mcp-client.js"

export interface McpHttpConfig {
  url: string
  headers?: Record<string, string>
  requestTimeoutMs?: number
}

interface RpcResult {
  result?: unknown
  error?: { message?: string }
}

const DEFAULT_TIMEOUT_MS = 30_000

export class McpHttpClient implements McpClient {
  private readonly config: McpHttpConfig
  private sessionId: string | null = null
  private tools: McpTool[] = []
  private nextId = 1

  constructor(config: McpHttpConfig) {
    this.config = config
  }

  async connect(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "seed", version: "0.1.0" },
    })
    await this.notify("notifications/initialized")
    const list = (await this.request("tools/list", {})) as { tools?: McpTool[] }
    this.tools = list.tools ?? []
  }

  getTools(): McpTool[] {
    return this.tools
  }

  async callTool(name: string, args: unknown): Promise<{ content: string; isError: boolean }> {
    const result = (await this.request("tools/call", { name, arguments: args })) as
      | {
          content?: Array<{ type: string; text?: string }>
          isError?: boolean
        }
      | undefined
    if (!result || typeof result !== "object") {
      throw new Error("mcp http server returned an empty tool result")
    }
    const content = (result.content ?? [])
      .filter((c) => c.type === "text" && typeof c.text === "string")
      .map((c) => c.text as string)
      .join("\n")
    return { content, isError: result.isError ?? false }
  }

  close(): void {
    const sid = this.sessionId
    this.sessionId = null
    if (sid) void this.sendDelete(sid)
  }

  private async sendDelete(sessionId: string): Promise<void> {
    try {
      await fetchWithTimeout(
        this.config.url,
        {
          method: "DELETE",
          headers: {
            ...(sessionId ? { "mcp-session-id": sessionId } : {}),
            ...this.config.headers,
          },
        },
        this.config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
      )
    } catch {
      // Session teardown is best-effort; the server has its own reaping.
    }
  }

  private async request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++
    const res = await fetchWithTimeout(
      this.config.url,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      },
      this.config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    this.captureSession(res)
    if (!res.ok) throw new Error(`mcp http error: ${res.status}`)
    const rpc = await this.readResponse(res, id)
    if (rpc.error) throw new Error(rpc.error.message ?? "mcp request error")
    return rpc.result
  }

  private async notify(method: string, params?: unknown): Promise<void> {
    const res = await fetchWithTimeout(
      this.config.url,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({ jsonrpc: "2.0", method, params }),
      },
      this.config.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    this.captureSession(res)
    await res.text()
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(this.sessionId ? { "mcp-session-id": this.sessionId } : {}),
      ...this.config.headers,
    }
  }

  private captureSession(res: Response): void {
    const sid = res.headers.get("mcp-session-id")
    if (sid) this.sessionId = sid
  }

  private async readResponse(res: Response, id: number): Promise<RpcResult> {
    const ct = res.headers.get("content-type") ?? ""
    if (!ct.includes("text/event-stream")) {
      return (await res.json()) as RpcResult
    }
    return this.readSseResponse(res, id)
  }

  // Streamable HTTP servers typically keep the SSE stream open after sending
  // the response, so waiting for end-of-body (res.text()) hangs forever.
  // Parse events incrementally and stop as soon as the matching id arrives.
  private async readSseResponse(res: Response, id: number): Promise<RpcResult> {
    if (!res.body) return {}
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    const dataLines: string[] = []

    const handleBlock = (): RpcResult | null => {
      const payload = dataLines.join("\n")
      dataLines.length = 0
      if (!payload) return null
      try {
        const msg = JSON.parse(payload) as { id?: number; result?: unknown; error?: { message?: string } }
        if (msg.id === id) return msg
      } catch {
        // skip non-JSON SSE events
      }
      return null
    }

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let newlineIdx: number
        while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIdx).replace(/\r$/, "")
          buffer = buffer.slice(newlineIdx + 1)
          if (line.startsWith("data:")) {
            dataLines.push(line.slice(5).replace(/^ /, ""))
          } else if (line === "") {
            const matched = handleBlock()
            if (matched) return matched
          }
        }
      }
      return handleBlock() ?? {}
    } finally {
      // Cancel first: it also releases the lock (releaseLock-then-cancel
      // throws ERR_INVALID_STATE in Bun).
      void reader.cancel()
    }
  }
}
