import { z } from "zod"

export const EventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("step"),
    id: z.string(),
    ts: z.number(),
    sessionId: z.string(),
    tool: z.string(),
    args: z.unknown(),
  }),
  z.object({
    type: z.literal("result"),
    id: z.string(),
    ts: z.number(),
    sessionId: z.string(),
    stepId: z.string(),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("verdict"),
    id: z.string(),
    ts: z.number(),
    sessionId: z.string(),
    // Optional: run-level verdicts (e.g. skill verification) have no step.
    stepId: z.string().optional(),
    ok: z.boolean(),
    detail: z.string(),
  }),
  z.object({
    type: z.literal("harvest"),
    id: z.string(),
    ts: z.number(),
    sessionId: z.string(),
    stepId: z.string().optional(),
    data: z.unknown(),
  }),
  z.object({
    type: z.literal("turn"),
    id: z.string(),
    ts: z.number(),
    sessionId: z.string(),
    goal: z.string(),
  }),
  z.object({
    type: z.literal("done"),
    id: z.string(),
    ts: z.number(),
    sessionId: z.string(),
    answer: z.string(),
    stopped: z.enum(["done", "max_steps", "error"]).optional(),
  }),
  z.object({
    type: z.literal("task"),
    id: z.string(),
    ts: z.number(),
    sessionId: z.string(),
    taskId: z.string(),
    parentId: z.string().nullable(),
    status: z.enum(["open", "done", "failed", "abandoned"]),
    title: z.string(),
  }),
  z.object({
    type: z.literal("consolidate"),
    id: z.string(),
    ts: z.number(),
    sessionId: z.string(),
    data: z.object({
      merged: z.number(),
      archived: z.number(),
      promoted: z.number(),
      staled: z.number(),
      mapping: z.array(z.object({ from: z.string(), to: z.string() })),
    }),
  }),
  z.object({
    type: z.literal("compact"),
    id: z.string(),
    ts: z.number(),
    sessionId: z.string(),
    // Event ids folded into the summary (content-addressed, verified at
    // write time). The covered events stay in the log; they are only skipped
    // when rebuilding the working history.
    covers: z.array(z.string()),
    summary: z.string(),
  }),
  z.object({
    type: z.literal("prune"),
    id: z.string(),
    ts: z.number(),
    sessionId: z.string(),
    // Retention audit trail: events strictly older than `before` were
    // archived to the sidecar file and removed from the log.
    before: z.number(),
    archived: z.number(),
  }),
])

export type Event = z.infer<typeof EventSchema>
