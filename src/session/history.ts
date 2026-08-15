import type { HistoryItem } from "../model/model.js"
import type { Event } from "../schema/event.js"

export interface ReconstructOptions {
  // Compact events whose id is NOT in this set are untrusted (their covers
  // failed evidence verification) and are ignored, so the covered events
  // expand back into the history.
  trustedCompacts?: Set<string>
  // Extra event ids to skip, as if covered (used by compaction planning).
  skipIds?: Set<string>
}

export function reconstructHistory(events: Event[], opts: ReconstructOptions = {}): HistoryItem[] {
  const covered = new Set(opts.skipIds)
  // Folded rounds render as summary messages, emitted before the live rounds
  // they replaced so the transcript stays chronological.
  const items: HistoryItem[] = []
  for (const e of events) {
    if (e.type !== "compact") continue
    if (opts.trustedCompacts === undefined || opts.trustedCompacts.has(e.id)) {
      for (const c of e.covers) covered.add(c)
      items.push({ role: "assistant-text", content: `[earlier turns summarized]\n${e.summary}` })
    }
  }

  for (const e of events) {
    if (covered.has(e.id)) continue
    switch (e.type) {
      case "turn":
        items.push({ role: "user", content: e.goal })
        break
      case "step":
        items.push({ role: "assistant-tool", toolCallId: e.id, tool: e.tool, args: e.args })
        break
      case "result":
        items.push({ role: "tool", toolCallId: e.stepId, result: e.result })
        break
      case "done":
        items.push({ role: "assistant-text", content: e.answer })
        break
      case "compact":
      case "verdict":
      case "harvest":
      case "task":
      case "consolidate":
      case "prune":
        break
    }
  }

  // Invariant I6 persists a step before executing it, so a crash mid-turn
  // leaves a trailing assistant-tool with no tool result. OpenAI-compatible
  // APIs reject that shape; substitute an interrupted marker so the
  // transcript stays valid and the model learns the tool never ran.
  const last = items.at(-1)
  if (last?.role === "assistant-tool") {
    items.push({
      role: "tool",
      toolCallId: last.toolCallId,
      result: { ok: false, error: { code: "interrupted", message: "restarted before the tool executed" } },
    })
  }

  return items
}

interface TaskRecord {
  taskId: string
  parentId: string | null
  title: string
  status: string
}

function taskDepth(tasks: Map<string, TaskRecord>, id: string | null, memo: Map<string | null, number>): number {
  if (id === null) return 0
  const cached = memo.get(id)
  if (cached !== undefined) return cached
  const task = tasks.get(id)
  const depth = task ? 1 + taskDepth(tasks, task.parentId, memo) : 0
  memo.set(id, depth)
  return depth
}

// Renders the raw event stream as harvest material. Task events render as an
// indented tree so the decomposition pattern itself becomes distillable.
export function renderTranscript(events: Event[]): string {
  const tasks = new Map<string, TaskRecord>()
  const lines: string[] = []

  for (const e of events) {
    switch (e.type) {
      case "turn":
        lines.push(`User: ${e.goal}`)
        break
      case "step":
        lines.push(`Assistant called ${e.tool} with ${JSON.stringify(e.args)}`)
        break
      case "result":
        lines.push(`Tool result: ${JSON.stringify(e.result)}`)
        break
      case "done":
        lines.push(`Assistant: ${e.answer}`)
        break
      case "task": {
        const prev = tasks.get(e.taskId)
        const record: TaskRecord = {
          taskId: e.taskId,
          parentId: e.parentId ?? prev?.parentId ?? null,
          title: e.title !== "" ? e.title : (prev?.title ?? ""),
          status: e.status,
        }
        tasks.set(e.taskId, record)
        const depth = taskDepth(tasks, record.parentId, new Map())
        lines.push(`${"  ".repeat(depth)}Task ${e.taskId}: ${record.title} [${e.status}]`)
        break
      }
      case "verdict":
      case "harvest":
      case "compact":
      case "consolidate":
      case "prune":
        break
    }
  }

  return lines.join("\n")
}
