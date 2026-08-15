import type { ToolSchema } from "../schema/connection.js"

export type Step = { type: "tool"; tool: string; args: unknown } | { type: "done"; answer: string }

export type HistoryItem =
  | { role: "user"; content: string }
  | { role: "assistant-text"; content: string }
  | { role: "assistant-tool"; toolCallId: string; tool: string; args: unknown }
  | { role: "tool"; toolCallId: string; result: unknown }

export interface DecideInput {
  context: string
  tools: ToolSchema[]
  history: HistoryItem[]
}

export interface HarvestMemory {
  key: string
  content: unknown
}

export interface HarvestSkill {
  name: string
  description: string
  steps: string
  verification?: string
}

export interface HarvestOutput {
  memories: HarvestMemory[]
  skills: HarvestSkill[]
}

export interface Model {
  // A decide call may propose several steps at once (parallel tool calls in
  // a single model response). The kernel executes them in order within the
  // same turn, short-circuiting when one of them is a done step.
  decide(input: DecideInput): Promise<Step[]>
  harvest?(transcript: string): Promise<HarvestOutput>
  // Independent verdict on whether the goal was actually achieved. Used by
  // the feedback loop so "finished" is not mistaken for "succeeded".
  judge?(goal: string, answer: string, transcript: string): Promise<boolean>
  // Optional model-written summary for history compaction (phase 2). The
  // caller falls back to the deterministic summary when this is absent or
  // throws.
  summarizeRounds?(transcript: string): Promise<string>
}

// Raised by model adapters when the upstream response is unusable (malformed
// JSON, failed schema validation). The kernel loop catches this and retries
// once before failing the run.
export class ModelCallError extends Error {}
