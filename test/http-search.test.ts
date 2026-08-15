import { describe, expect, test } from "bun:test"
import { createHttpSearchProvider } from "../src/connection/search.js"

describe("HTTP search provider", () => {
  test("POSTs {query,limit} and maps the response", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { query: string; limit: number }
        expect(body.query).toBe("hello")
        expect(body.limit).toBe(5)
        return Response.json({
          results: [{ title: "A", url: "https://a", snippet: "s" }],
        })
      },
    })

    try {
      const provider = createHttpSearchProvider({ url: `http://127.0.0.1:${server.port}/search`, apiKey: "k" })
      const results = await provider.search("hello", 5)
      expect(results).toEqual([{ title: "A", url: "https://a", snippet: "s" }])
    } finally {
      server.stop(true)
    }
  })

  test("non-2xx throws", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("err", { status: 500 }) })
    try {
      const provider = createHttpSearchProvider({ url: `http://127.0.0.1:${server.port}/` })
      await expect(provider.search("x", 5)).rejects.toThrow()
    } finally {
      server.stop(true)
    }
  })
})
