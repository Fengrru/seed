import type { HistoryItem, Model, Step } from "../model/model.js"
import type { Connection, Trust } from "../schema/connection.js"
import type { Event } from "../schema/event.js"
import { contentHash } from "../schema/knowledge.js"
import type { Log } from "../store/log.js"

export interface KernelHooks {
  verify?: (step: Step, result: unknown) => Promise<{ ok: boolean; detail: string }>
  harvest?: (step: Step, result: unknown, verdict: { ok: boolean; detail: string }) => Promise<void>
}

export interface RunOptions extends KernelHooks {
  sessionId: string
  goal: string
  context: string
  model: Model
  connections: Map<string, Connection>
  log: Log
  history?: HistoryItem[]
  maxSteps?: number
  onStep?: (event: Event) => void
  // Approval gate: when a connection's trust is below confirmBelow, the call
  // only runs if approve resolves true. Without an approve callback such a
  // call fails with "approval_required" instead of executing.
  approve?: (connection: Connection, args: unknown) => Promise<boolean>
  confirmBelow?: Trust
}

export interface RunResult {
  answer: string
  steps: number
  stopped: "done" | "max_steps" | "error"
}

const TRUST_LEVEL: Record<Trust, number> = { untrusted: 0, reviewed: 1, trusted: 2 }

// Doom-loop guard: a model repeating the exact same call burns tokens without
// making progress. The call is recorded but never executed.
const DOOM_LOOP_WINDOW = 8
const DOOM_LOOP_REPEAT = 3

// Tool results enter the model history verbatim, which makes them an injection
// surface: a hostile file or search result can smuggle instructions into the
// prompt. The full result is always kept in the event log for audit; only the
// copy fed back to the model is truncated.
const MAX_HISTORY_RESULT_CHARS = 4000

function truncateForHistory(result: unknown): unknown {
  let serialized: string
  try {
    serialized = JSON.stringify(result) ?? "undefined"
  } catch {
    return "[result could not be serialized]"
  }
  if (serialized.length <= MAX_HISTORY_RESULT_CHARS) return result
  return `${serialized.slice(0, MAX_HISTORY_RESULT_CHARS)}\n...[result truncated]`
}

function emit(log: Log, onStep: ((event: Event) => void) | undefined, event: Event): void {
  log.append(event)
  onStep?.(event)
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function executeCall(connection: Connection, args: unknown, sessionId: string, stepId: string): Promise<unknown> {
  try {
    return await connection.call(args, { sessionId, stepId })
  } catch (e) {
    // A connection that throws must never take down the whole run: record
    // it as a failed step and let the model react.
    return { ok: false, error: { code: "connection_threw", message: errorMessage(e) } }
  }
}

function callKey(tool: string, args: unknown): string {
  try {
    return `${tool}:${contentHash(args)}`
  } catch {
    return `${tool}:${String(args)}`
  }
}

export async function run(options: RunOptions): Promise<RunResult> {
  const maxSteps = options.maxSteps ?? 100
  const now = () => Date.now()
  const history: HistoryItem[] = [...(options.history ?? [])]

  emit(options.log, options.onStep, {
    type: "turn",
    id: crypto.randomUUID(),
    ts: now(),
    sessionId: options.sessionId,
    goal: options.goal,
  })

  history.push({ role: "user", content: options.goal })

  let answer = ""
  let steps = 0
  const recentCalls: string[] = []

  while (steps < maxSteps) {
    const decideInput = {
      context: options.context,
      tools: [...options.connections.values()].map((c) => c.schema),
      history,
    }
    let batch: Step[]
    try {
      batch = await options.model.decide(decideInput)
    } catch {
      try {
        // One retry: transient model failures (malformed JSON, network blip,
        // truncated output) are common enough that a single re-attempt is
        // worth the cost.
        batch = await options.model.decide(decideInput)
      } catch (secondError) {
        const message = `(error: model call failed: ${errorMessage(secondError)})`
        emit(options.log, options.onStep, {
          type: "done",
          id: crypto.randomUUID(),
          ts: now(),
          sessionId: options.sessionId,
          answer: message,
          stopped: "error",
        })
        return { answer: message, steps, stopped: "error" }
      }
    }

    // A decide call may propose several steps (multi-tool-call responses).
    // Execute them in order within the same turn, short-circuiting on done.
    if (batch.length === 0) {
      // A decide that proposes nothing cannot make progress; without a guard
      // the loop would spin forever. Treat it like a failed model call.
      const message = "(error: model returned an empty step batch)"
      emit(options.log, options.onStep, {
        type: "done",
        id: crypto.randomUUID(),
        ts: now(),
        sessionId: options.sessionId,
        answer: message,
        stopped: "error",
      })
      return { answer: message, steps, stopped: "error" }
    }
    for (const step of batch) {
      if (step.type === "done") {
        answer = step.answer
        history.push({ role: "assistant-text", content: answer })
        emit(options.log, options.onStep, {
          type: "done",
          id: crypto.randomUUID(),
          ts: now(),
          sessionId: options.sessionId,
          answer,
          stopped: "done",
        })
        return { answer, steps, stopped: "done" }
      }
      if (steps >= maxSteps) {
        // The model proposed steps the budget no longer allows. Record each
        // as a persisted step with a skipped result (I6: every proposed
        // action is visible in the log) instead of dropping them silently.
        const skippedId = crypto.randomUUID()
        emit(options.log, options.onStep, {
          type: "step",
          id: skippedId,
          ts: now(),
          sessionId: options.sessionId,
          tool: step.tool,
          args: step.args,
        })
        emit(options.log, options.onStep, {
          type: "result",
          id: crypto.randomUUID(),
          ts: now(),
          sessionId: options.sessionId,
          stepId: skippedId,
          result: {
            ok: false,
            error: { code: "skipped_max_steps", message: "step skipped: max steps reached before it could run" },
          },
        })
        continue
      }

      const stepId = crypto.randomUUID()

      history.push({ role: "assistant-tool", toolCallId: stepId, tool: step.tool, args: step.args })

      // Invariant I6: persist the step BEFORE executing it, so a crash mid-turn
      // never loses the fact that this action was about to run.
      emit(options.log, options.onStep, {
        type: "step",
        id: stepId,
        ts: now(),
        sessionId: options.sessionId,
        tool: step.tool,
        args: step.args,
      })

      const key = callKey(step.tool, step.args)
      recentCalls.push(key)
      if (recentCalls.length > DOOM_LOOP_WINDOW) recentCalls.shift()
      const isDoomLoop =
        recentCalls.length >= DOOM_LOOP_REPEAT && recentCalls.slice(-DOOM_LOOP_REPEAT).every((k) => k === key)

      let result: unknown
      if (isDoomLoop) {
        result = {
          ok: false,
          error: {
            code: "doom_loop",
            message: `tool ${step.tool} called with identical arguments ${DOOM_LOOP_REPEAT} times in a row — call intercepted`,
          },
        }
      } else {
        const connection = options.connections.get(step.tool)
        if (!connection) {
          result = { ok: false, error: { code: "unknown_tool", message: `no connection named ${step.tool}` } }
        } else if (TRUST_LEVEL[connection.trust] < TRUST_LEVEL[options.confirmBelow ?? "untrusted"]) {
          if (!options.approve) {
            result = {
              ok: false,
              error: {
                code: "approval_required",
                message: `tool ${connection.id} (trust: ${connection.trust}) requires approval`,
              },
            }
          } else {
            result = (await options.approve(connection, step.args))
              ? await executeCall(connection, step.args, options.sessionId, stepId)
              : { ok: false, error: { code: "approval_denied", message: `tool ${connection.id} call was denied` } }
          }
        } else {
          result = await executeCall(connection, step.args, options.sessionId, stepId)
        }
      }

      history.push({ role: "tool", toolCallId: stepId, result: truncateForHistory(result) })

      emit(options.log, options.onStep, {
        type: "result",
        id: crypto.randomUUID(),
        ts: now(),
        sessionId: options.sessionId,
        stepId,
        result,
      })

      const verdict = options.verify ? await options.verify(step, result) : { ok: true, detail: "unverified" }

      emit(options.log, options.onStep, {
        type: "verdict",
        id: crypto.randomUUID(),
        ts: now(),
        sessionId: options.sessionId,
        stepId,
        ok: verdict.ok,
        detail: verdict.detail,
      })

      if (options.harvest) await options.harvest(step, result, verdict)

      steps += 1
    }
  }

  emit(options.log, options.onStep, {
    type: "done",
    id: crypto.randomUUID(),
    ts: now(),
    sessionId: options.sessionId,
    answer: answer || "(stopped: max steps reached)",
    stopped: "max_steps",
  })

  return { answer: answer || "(stopped: max steps reached)", steps, stopped: "max_steps" }
}
