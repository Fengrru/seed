import { z } from "zod"
import { invalidateKnowledge } from "../kernel/invalidate.js"
import { createRetriever } from "../memory/retriever.js"
import { type CallContext, type Connection, fail, ok } from "../schema/connection.js"
import { type Log, validEvidenceIds } from "../store/log.js"
import type { SelfStore } from "../store/self.js"

const WriteSchema = z.object({ op: z.literal("write"), key: z.string(), content: z.unknown() })
const ReadSchema = z.object({ op: z.literal("read"), key: z.string() })
const SearchSchema = z.object({ op: z.literal("search"), query: z.string() })
const RevokeSchema = z.object({ op: z.literal("revoke"), key: z.string() })

export function createMemoryConnection(self: SelfStore, log?: Log): Connection {
  const retriever = createRetriever(self)
  const schema = z.discriminatedUnion("op", [WriteSchema, ReadSchema, SearchSchema, RevokeSchema])
  return {
    id: "memory",
    trust: "trusted",
    schema: {
      name: "memory",
      description:
        "Store or recall durable knowledge in the agent's own memory. Use write to persist a fact or preference, read to fetch one key, search to find relevant memories, revoke to retract a memory and everything derived from it.",
      inputSchema: schema,
    },
    async call(args: unknown, ctx?: CallContext) {
      const parsed = schema.safeParse(args)
      if (!parsed.success) return fail("invalid_args", parsed.error.message)
      const op = parsed.data

      if (op.op === "write") {
        const existing = self.get("memory", op.key)
        // Evidence must cite real, untampered events. When the log is
        // available, unverifiable citations are dropped rather than
        // recorded; without one, citations are kept but unverified.
        const evidence = ctx?.stepId === undefined ? [] : log ? validEvidenceIds(log, [ctx.stepId]) : [ctx.stepId]
        const obj = self.add(op.key, {
          kind: "memory",
          content: op.content,
          provenance: { source: "trajectory", refs: [], created: Date.now() },
          evidence,
          verification: { status: "unverified", check: null, lastVerifiedAt: null },
          ttl: null,
          state: "active",
          metrics: { uses: 0, successes: 0, lastUsedAt: null },
        })
        return ok({ key: op.key, written: true, newVersion: !existing || existing.id !== obj.id })
      }

      if (op.op === "read") {
        const obj = self.get("memory", op.key)
        if (!obj) return fail("not_found", `no memory with key ${op.key}`)
        self.touch("memory", op.key)
        return ok({ key: op.key, content: obj.content, version: obj.version })
      }

      if (op.op === "revoke") {
        const obj = self.get("memory", op.key)
        if (!obj) return fail("not_found", `no memory with key ${op.key}`)
        const { staled } = invalidateKnowledge(self, [obj.id])
        return ok({ key: op.key, revoked: true, staled })
      }

      const results = await retriever.retrieve(op.query, 5)
      return ok({
        query: op.query,
        results: results.map((r) => ({ key: r.name, content: r.content, verification: r.verification.status })),
      })
    },
  }
}
