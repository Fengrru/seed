import type { McpServerConfig } from "./connection/mcp-client.js"
import type { McpHttpConfig } from "./connection/mcp-http.js"
import type { HttpSearchConfig } from "./connection/search.js"

export interface CliConfig {
  mcpServers: McpServerConfig[]
  mcpHttpServers: McpHttpConfig[]
  search?: HttpSearchConfig
  embeddingModel?: string
}

// Env-var config is best-effort: a malformed value warns and is ignored
// rather than taking the whole CLI down at startup.
function parseJsonArray<T>(name: string, value: string | undefined): T[] {
  if (value === undefined || value === "") return []
  try {
    const parsed: unknown = JSON.parse(value)
    if (!Array.isArray(parsed)) {
      console.warn(`(${name}: expected a JSON array, ignoring)`)
      return []
    }
    return parsed as T[]
  } catch {
    console.warn(`(${name}: invalid JSON, ignoring)`)
    return []
  }
}

function parseJsonObject(name: string, value: string | undefined): Record<string, string> {
  if (value === undefined || value === "") return {}
  try {
    const parsed: unknown = JSON.parse(value)
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      console.warn(`(${name}: expected a JSON object, ignoring)`)
      return {}
    }
    return Object.fromEntries(Object.entries(parsed as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
  } catch {
    console.warn(`(${name}: invalid JSON, ignoring)`)
    return {}
  }
}

export function cliConfigFromEnv(env: Record<string, string | undefined>): CliConfig {
  const config: CliConfig = {
    mcpServers: parseJsonArray<McpServerConfig>("SEED_MCP", env.SEED_MCP),
    mcpHttpServers: parseJsonArray<McpHttpConfig>("SEED_MCP_HTTP", env.SEED_MCP_HTTP),
  }

  if (env.SEED_SEARCH_URL) {
    const headers = parseJsonObject("SEED_SEARCH_HEADERS", env.SEED_SEARCH_HEADERS)
    config.search = {
      url: env.SEED_SEARCH_URL,
      ...(env.SEED_SEARCH_API_KEY === undefined ? {} : { apiKey: env.SEED_SEARCH_API_KEY }),
      ...(Object.keys(headers).length === 0 ? {} : { headers }),
    }
  }

  if (env.SEED_EMBEDDING_MODEL) config.embeddingModel = env.SEED_EMBEDDING_MODEL
  return config
}
