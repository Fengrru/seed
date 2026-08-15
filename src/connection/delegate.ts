import { z } from "zod"
import { type Connection, fail, ok } from "../schema/connection.js"

export interface DelegateResult {
  answer: string
  steps: number
  worktree?: string
}

export interface DelegateHandlers {
  runOne: (goal: string) => Promise<DelegateResult>
  runMany: (goals: string[]) => Promise<DelegateResult[]>
}

const OneOp = z.object({ op: z.literal("one"), goal: z.string() })
const ManyOp = z.object({ op: z.literal("many"), goals: z.array(z.string()).min(1).max(10) })

export function createDelegateConnection(handlers: DelegateHandlers): Connection {
  return {
    id: "delegate",
    trust: "trusted",
    schema: {
      name: "delegate",
      description:
        "Spawn isolated subagents to parallelize a complex task. op=one runs a single subagent in the current workspace; op=many runs several sub-goals in parallel, each in its own isolated worktree.",
      inputSchema: z.discriminatedUnion("op", [OneOp, ManyOp]),
    },
    async call(args: unknown) {
      const parsed = z.discriminatedUnion("op", [OneOp, ManyOp]).safeParse(args)
      if (!parsed.success) return fail("invalid_args", parsed.error.message)
      try {
        if (parsed.data.op === "one") {
          const r = await handlers.runOne(parsed.data.goal)
          return ok({ answer: r.answer, steps: r.steps, worktree: r.worktree })
        }
        const results = await handlers.runMany(parsed.data.goals)
        return ok({ results })
      } catch (e) {
        return fail("delegate_failed", e instanceof Error ? e.message : String(e))
      }
    },
  }
}
