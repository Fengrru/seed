import { describe, expect, test } from "bun:test"
import { createOpenAIEmbeddingProvider } from "../src/memory/embedding-provider.js"

describe("OpenAI embedding provider", () => {
  test("POSTs {model,input} to /embeddings and maps the response", async () => {
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const body = (await req.json()) as { model: string; input: string[] }
        expect(body.model).toBe("text-embedding-3-small")
        expect(body.input).toHaveLength(2)
        expect(req.headers.get("authorization")).toBe("Bearer k")
        return Response.json({
          data: [{ embedding: [1, 0, 0] }, { embedding: [0, 1, 0] }],
        })
      },
    })
    try {
      const provider = createOpenAIEmbeddingProvider({
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "k",
        model: "text-embedding-3-small",
      })
      const vectors = await provider.embed(["a", "b"])
      expect(vectors).toEqual([
        [1, 0, 0],
        [0, 1, 0],
      ])
    } finally {
      server.stop(true)
    }
  })

  test("non-2xx throws", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("err", { status: 500 }) })
    try {
      const provider = createOpenAIEmbeddingProvider({
        baseUrl: `http://127.0.0.1:${server.port}`,
        apiKey: "k",
        model: "m",
      })
      await expect(provider.embed(["a"])).rejects.toThrow()
    } finally {
      server.stop(true)
    }
  })
})
