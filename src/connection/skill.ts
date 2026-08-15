import { z } from "zod"
import { verifySkill } from "../kernel/skill-verify.js"
import { type CallContext, type Connection, fail, ok } from "../schema/connection.js"
import { type Log, validEvidenceIds } from "../store/log.js"
import type { SelfStore } from "../store/self.js"

const DefineSchema = z.object({
  op: z.literal("define"),
  name: z.string(),
  description: z.string(),
  steps: z.string(),
  verification: z.string().optional(),
})
const VerifySchema = z.object({ op: z.literal("verify"), name: z.string() })
const ListSchema = z.object({ op: z.literal("list") })
const ReadSchema = z.object({ op: z.literal("read"), name: z.string() })

export function createSkillConnection(self: SelfStore, cwd: string, log?: Log): Connection {
  const schema = z.discriminatedUnion("op", [DefineSchema, VerifySchema, ListSchema, ReadSchema])
  return {
    id: "skill",
    trust: "trusted",
    schema: {
      name: "skill",
      description:
        "Manage reusable skills. define to register a procedure (optionally with a verification command); verify to run its check; list and read to discover and load skills.",
      inputSchema: schema,
    },
    async call(args: unknown, ctx?: CallContext) {
      const parsed = schema.safeParse(args)
      if (!parsed.success) return fail("invalid_args", parsed.error.message)
      const op = parsed.data

      if (op.op === "define") {
        const check = op.verification ? ({ type: "command", cmd: op.verification } as const) : null
        const evidence = ctx?.stepId === undefined ? [] : log ? validEvidenceIds(log, [ctx.stepId]) : [ctx.stepId]
        const obj = self.add(op.name, {
          kind: "skill",
          content: { description: op.description, steps: op.steps },
          provenance: { source: "trajectory", refs: [], created: Date.now() },
          evidence,
          verification: { status: "unverified", check, lastVerifiedAt: null },
          ttl: null,
          // A skill is a proposal until proven: it starts draft and only
          // becomes active (and thus auto-injectable) after verify passes.
          state: "draft",
          metrics: { uses: 0, successes: 0, lastUsedAt: null },
        })
        return ok({ name: op.name, state: obj.state, hasVerification: check !== null })
      }

      if (op.op === "verify") {
        const obj = self.get("skill", op.name)
        if (obj?.kind !== "skill") return fail("not_found", `no skill named ${op.name}`)
        if (!obj.verification.check) return fail("no_verification", `skill ${op.name} has no verification command`)
        // Verification verdicts are auditable events (when the connection
        // has access to the log).
        const r = await verifySkill(self, op.name, cwd, log, ctx?.sessionId)
        if (!r) return fail("verify_failed", `could not verify skill ${op.name}`)
        return ok({ name: r.name, verified: r.verified, state: r.verified ? "active" : "draft" })
      }

      if (op.op === "list") {
        const skills = self.latest().filter((o) => o.kind === "skill")
        return ok({
          skills: skills.map((s) => ({ name: s.name, state: s.state, verification: s.verification.status })),
        })
      }

      const obj = self.get("skill", op.name)
      if (obj?.kind !== "skill") return fail("not_found", `no skill named ${op.name}`)
      self.touch("skill", op.name)
      const content = obj.content as { description: string; steps: string }
      return ok({ name: op.name, description: content.description, steps: content.steps })
    },
  }
}
