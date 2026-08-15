import { describe, expect, test } from "bun:test"
import { cliConfigFromEnv } from "../src/cli-config.js"

describe("cli config from env", () => {
  test("an empty environment produces an empty config", () => {
    expect(cliConfigFromEnv({})).toEqual({ mcpServers: [], mcpHttpServers: [] })
  })

  test("parses MCP stdio and HTTP server lists", () => {
    const config = cliConfigFromEnv({
      SEED_MCP: JSON.stringify([{ command: "npx", args: ["-y", "server"], requestTimeoutMs: 5000 }]),
      SEED_MCP_HTTP: JSON.stringify([{ url: "http://localhost:8080/mcp", headers: { "x-token": "t" } }]),
    })
    expect(config.mcpServers).toEqual([{ command: "npx", args: ["-y", "server"], requestTimeoutMs: 5000 }])
    expect(config.mcpHttpServers).toEqual([{ url: "http://localhost:8080/mcp", headers: { "x-token": "t" } }])
  })

  test("malformed JSON is ignored instead of crashing the CLI", () => {
    const config = cliConfigFromEnv({ SEED_MCP: "not json", SEED_MCP_HTTP: '{"url":1}' })
    expect(config.mcpServers).toEqual([])
    expect(config.mcpHttpServers).toEqual([])
  })

  test("builds a search provider config from URL, key, and headers", () => {
    const config = cliConfigFromEnv({
      SEED_SEARCH_URL: "https://search.example.com/query",
      SEED_SEARCH_API_KEY: "sk-search",
      SEED_SEARCH_HEADERS: JSON.stringify({ "x-custom": "1" }),
    })
    expect(config.search).toEqual({
      url: "https://search.example.com/query",
      apiKey: "sk-search",
      headers: { "x-custom": "1" },
    })
  })

  test("search URL alone is enough; key and headers stay optional", () => {
    const config = cliConfigFromEnv({ SEED_SEARCH_URL: "https://s.example.com" })
    expect(config.search).toEqual({ url: "https://s.example.com" })
  })

  test("embedding model passes through", () => {
    const config = cliConfigFromEnv({ SEED_EMBEDDING_MODEL: "text-embedding-3-small" })
    expect(config.embeddingModel).toBe("text-embedding-3-small")
  })
})
