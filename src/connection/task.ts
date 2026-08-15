import { z } from "zod"
import { type CallContext, type Connection, fail, ok } from "../schema/connection.js"
import type { Log } from "../store/log.js"

// Tasks are session-scoped data, not knowledge: the model declares a
// hierarchical plan through this connection, the tree is recorded in the
// event log (auditable, transcripted for harvesting), and execution stays
// where it always was — the delegate tool.
const CreateOp = z.object({
  op: z.literal("create"),
  taskId: z.string(),
  title: z.string(),
  parentId: z.string().nullable().optional(),
})
const CompleteOp = z.object({ op: z.literal("complete"), taskId: z.string() })
const FailOp = z.object({ op: z.literal("fail"), taskId: z.string() })
const AbandonOp = z.object({ op: z.literal("abandon"), taskId: z.string() })

const STATUS_BY_OP = { create: "open", complete: "done", fail: "failed", abandon: "abandoned" } as const

export function createTaskConnection(log: Log): Connection {
  const schema = z.discriminatedUnion("op", [CreateOp, CompleteOp, FailOp, AbandonOp])
  return {
    id: "task",
    trust: "trusted",
    schema: {
      name: "task",
      description:
        "Declare and update a hierarchical task plan (e.g. T1, T1.1). create opens a task (optionally under a parent), complete/fail/abandon update its status. Tasks are planning data: execution happens via the delegate tool.",
      inputSchema: schema,
    },
    async call(args: unknown, ctx?: CallContext) {
      const parsed = schema.safeParse(args)
      if (!parsed.success) return fail("invalid_args", parsed.error.message)
      const op = parsed.data
      const sessionId = ctx?.sessionId
      if (sessionId === undefined) return fail("no_session", "task tracking requires a session context")
      const status = STATUS_BY_OP[op.op]
      log.append({
        type: "task",
        id: crypto.randomUUID(),
        ts: Date.now(),
        sessionId,
        taskId: op.taskId,
        parentId: op.op === "create" ? (op.parentId ?? null) : null,
        status,
        title: op.op === "create" ? op.title : "",
      })
      return ok({ taskId: op.taskId, status })
    },
  }
}
