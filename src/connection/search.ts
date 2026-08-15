import { z } from "zod"
import { type CallContext, type Connection, fail, ok } from "../schema/connection.js"
import { type Log, validEvidenceIds } from "../store/log.js"
import type { SelfStore } from "../store/self.js"
import { fetchWithTimeout } from "../util/fetch.js"

export interface SearchResult {
  title: string
  url: string
  snippet: string
}

export interface SearchProvider {
  search(query: string, limit: number): Promise<SearchResult[]>
}

const SearchOp = z.object({
  op: z.literal("search"),
  query: z.string(),
  limit: z.number().int().positive().max(20).optional(),
})
const RememberOp = z.object({
  op: z.literal("remember"),
  key: z.string(),
  content: z.unknown(),
  sourceUrl: z.string().optional(),
  ttlHours: z.number().positive().optional(),
})

export function createSearchConnection(provider: SearchProvider, self: SelfStore, log?: Log): Connection {
  return {
    id: "search",
    trust: "reviewed",
    schema: {
      name: "search",
      description:
        "Search the web for up-to-date information. Use remember to persist a distilled fact from search results into memory (with source URL and a freshness TTL).",
      inputSchema: z.discriminatedUnion("op", [SearchOp, RememberOp]),
    },
    async call(args: unknown, ctx?: CallContext) {
      const parsed = z.discriminatedUnion("op", [SearchOp, RememberOp]).safeParse(args)
      if (!parsed.success) return fail("invalid_args", parsed.error.message)
      const op = parsed.data

      if (op.op === "search") {
        try {
          const results = await provider.search(op.query, op.limit ?? 5)
          return ok({ query: op.query, results })
        } catch (e) {
          return fail("search_failed", e instanceof Error ? e.message : String(e))
        }
      }

      const ttl = op.ttlHours ? op.ttlHours * 3_600_000 : null
      const evidence = ctx?.stepId === undefined ? [] : log ? validEvidenceIds(log, [ctx.stepId]) : [ctx.stepId]
      self.add(op.key, {
        kind: "memory",
        content: op.content,
        provenance: {
          source: "search",
          refs: op.sourceUrl ? [{ url: op.sourceUrl }] : [],
          created: Date.now(),
        },
        evidence,
        verification: { status: "unverified", check: null, lastVerifiedAt: null },
        ttl,
        state: "active",
        metrics: { uses: 0, successes: 0, lastUsedAt: null },
      })
      return ok({ key: op.key, remembered: true, ttlHours: op.ttlHours ?? null })
    },
  }
}

export function createFakeSearchProvider(results: SearchResult[] = []): SearchProvider {
  return {
    async search(_query: string, limit: number) {
      return results.slice(0, limit)
    },
  }
}

export interface HttpSearchConfig {
  url: string
  apiKey?: string
  headers?: Record<string, string>
}

export function createHttpSearchProvider(config: HttpSearchConfig): SearchProvider {
  return {
    async search(query: string, limit: number) {
      const res = await fetchWithTimeout(
        config.url,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : {}),
            ...config.headers,
          },
          body: JSON.stringify({ query, limit }),
        },
        30_000,
      )
      if (!res.ok) throw new Error(`search provider error: ${res.status}`)
      const data = (await res.json()) as {
        results?: Array<{ title?: string; url?: string; snippet?: string }>
      }
      return (data.results ?? []).map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.snippet ?? "",
      }))
    },
  }
}
