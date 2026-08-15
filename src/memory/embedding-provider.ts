import { fetchWithTimeout } from "../util/fetch.js"
import { tokenize } from "./embedding.js"

export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>
}

export interface OpenAIEmbeddingConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export function createOpenAIEmbeddingProvider(config: OpenAIEmbeddingConfig): EmbeddingProvider {
  return {
    async embed(texts: string[]) {
      const res = await fetchWithTimeout(
        `${config.baseUrl}/embeddings`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({ model: config.model, input: texts }),
        },
        30_000,
      )
      if (!res.ok) throw new Error(`embedding error: ${res.status} ${await res.text()}`)
      const data = (await res.json()) as { data: Array<{ embedding: number[] }> }
      return data.data.map((d) => d.embedding)
    },
  }
}

function hash(s: string): number {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h
}

const DIM = 32

export function createFakeEmbeddingProvider(): EmbeddingProvider {
  return {
    async embed(texts: string[]) {
      return texts.map((t) => {
        const vec = new Array<number>(DIM).fill(0)
        for (const tok of tokenize(t)) {
          vec[hash(tok) % DIM] = (vec[hash(tok) % DIM] ?? 0) + 1
        }
        return vec
      })
    },
  }
}
