import { z } from "zod"
import { fetchWithTimeout } from "../util/fetch.js"
import { toJsonSchema } from "../util/json-schema.js"
import {
  type DecideInput,
  type HarvestOutput,
  type HistoryItem,
  type Model,
  ModelCallError,
  type Step,
} from "./model.js"

export interface OpenAIConfig {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
  harvestTimeoutMs?: number
  judgeTimeoutMs?: number
  compactTimeoutMs?: number
}

const FinishSchema = z.object({ answer: z.string() })

const HarvestSchema = z.object({
  memories: z.array(z.object({ key: z.string(), content: z.unknown() })),
  skills: z.array(
    z.object({
      name: z.string(),
      description: z.string(),
      steps: z.string(),
      verification: z.string().optional(),
    }),
  ),
})

const HARVEST_PROMPT = `You are distilling a completed work session into durable knowledge.
Given the transcript below, extract two kinds of things worth persisting:
1. memories: durable facts, user preferences, or decisions the agent should remember.
2. skills: reusable procedures that generalize beyond this one task (only include these if they clearly generalize; a skill may include a shell command to verify its result).

Respond ONLY with a JSON object matching this shape:
{"memories":[{"key":"...","content":{...}}],"skills":[{"name":"...","description":"...","steps":"...","verification":"..."}]}
If nothing is worth saving, return empty arrays.`

const SYSTEM_PROMPT = `You are an agent completing a goal by taking steps.
You are given a set of tools and a history of previous steps. Decide the next single step.
- If the goal is already achieved or nothing useful can be done, call the finish tool with your final answer.
- Otherwise, choose exactly one available tool with the required arguments.
- Do not repeat a tool call that already succeeded; check the history first.`

type Message =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant"
      content: string | null
      tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>
    }
  | { role: "tool"; tool_call_id: string; content: string }

// Tool results are untrusted input; cap how much of the conversation is sent
// back so one oversized result cannot exhaust the context window or price the
// rest of the session out of the prompt.
const MAX_HISTORY_CHARS = 60_000

function historyToMessages(history: HistoryItem[]): Message[] {
  const all = history.flatMap((item): Message[] => {
    switch (item.role) {
      case "user":
        return [{ role: "user", content: item.content }]
      case "assistant-text":
        return [{ role: "assistant", content: item.content }]
      case "assistant-tool":
        return [
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: item.toolCallId,
                type: "function",
                function: { name: item.tool, arguments: JSON.stringify(item.args) },
              },
            ],
          },
        ]
      case "tool":
        return [{ role: "tool", tool_call_id: item.toolCallId, content: JSON.stringify(item.result) }]
    }
  })

  let budget = MAX_HISTORY_CHARS
  const kept: Message[] = []
  let omitted = 0
  for (let i = all.length - 1; i >= 0; i--) {
    const msg = all[i]
    if (!msg) break
    const size = JSON.stringify(msg).length
    if (size > budget && kept.length > 0) {
      omitted = i + 1
      break
    }
    budget -= size
    kept.unshift(msg)
  }
  if (omitted > 0) {
    // The kept suffix is contiguous, so a cut that lands between an assistant
    // tool_calls message and its result leaves orphaned tool messages at the
    // front — a shape OpenAI-compatible APIs reject. Drop them too.
    while (kept[0]?.role === "tool") {
      kept.shift()
      omitted += 1
    }
    kept.unshift({ role: "user", content: `[${omitted} earlier message(s) omitted due to context budget]` })
  }
  return kept
}

const EMPTY_HARVEST: HarvestOutput = { memories: [], skills: [] }

const JUDGE_PROMPT = `You are evaluating whether an agent achieved a goal.
Given the goal, the agent's final answer, and a transcript of its actions, decide whether the goal was actually achieved.
Answer ONLY with the single word "yes" or "no".`

const COMPACT_PROMPT = `You are compressing completed turns of an agent session into a compact summary for future context.
Preserve: each turn's goal, the key decisions, what was done (tool use, in brief), errors encountered, and the final outcome.
Respond ONLY with a concise plain-text summary of at most 800 characters, no markdown headers.`

// Model-written summaries replace one folded round at a time; capping the
// transcript keeps the call cheap no matter how large the round was.
const MAX_COMPACT_TRANSCRIPT_CHARS = 30_000

export function createOpenAIModel(config: OpenAIConfig): Model {
  const timeoutMs = config.timeoutMs ?? 120_000
  const harvestTimeoutMs = config.harvestTimeoutMs ?? 60_000
  const judgeTimeoutMs = config.judgeTimeoutMs ?? 30_000
  const compactTimeoutMs = config.compactTimeoutMs ?? 60_000

  return {
    async decide(input: DecideInput): Promise<Step[]> {
      const tools = input.tools.map((t) => ({
        type: "function",
        function: {
          name: t.name,
          description: t.description,
          parameters: t.jsonSchema ?? toJsonSchema(t.inputSchema),
        },
      }))
      tools.push({
        type: "function",
        function: {
          name: "finish",
          description: "Signal that the goal is complete and provide the final answer.",
          parameters: toJsonSchema(FinishSchema),
        },
      })

      const system =
        `${SYSTEM_PROMPT}\n\n(You are running on ${process.platform}. Use the correct shell commands for this platform.)` +
        (input.context ? `\n\nRelevant knowledge from memory:\n${input.context}` : "")

      const messages: Message[] = [{ role: "system", content: system }, ...historyToMessages(input.history)]

      const res = await fetchWithTimeout(
        `${config.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages,
            tools,
            tool_choice: "auto",
          }),
        },
        timeoutMs,
      )

      if (!res.ok) throw new Error(`model error: ${res.status} ${await res.text()}`)
      const data = (await res.json()) as {
        choices: Array<{
          finish_reason?: string
          message: { content?: string; tool_calls?: Array<{ function: { name: string; arguments: string } }> }
        }>
      }

      // Length-stop protection (pi's design): when the provider truncated the
      // output, any tool arguments are possibly incomplete. Never salvage them
      // by parsing — the kernel retries once, then fails the run.
      if (data.choices[0]?.finish_reason === "length") {
        throw new ModelCallError("model output was truncated (length limit reached)")
      }

      const calls = data.choices[0]?.message?.tool_calls ?? []
      if (calls.length === 0) {
        return [{ type: "done", answer: data.choices[0]?.message?.content ?? "" }]
      }

      // Every tool call from the response becomes a step; none are dropped.
      return calls.map((call) => {
        const name = call.function.name
        let args: unknown
        try {
          args = JSON.parse(call.function.arguments)
        } catch (e) {
          throw new ModelCallError(
            `model returned malformed tool arguments: ${e instanceof Error ? e.message : String(e)}`,
          )
        }
        if (name === "finish") {
          const parsed = FinishSchema.safeParse(args)
          if (!parsed.success) throw new ModelCallError(`finish tool has invalid arguments: ${parsed.error.message}`)
          return { type: "done", answer: parsed.data.answer } as const
        }
        return { type: "tool", tool: name, args } as const
      })
    },
    async harvest(transcript: string): Promise<HarvestOutput> {
      let res: Response
      try {
        res = await fetchWithTimeout(
          `${config.baseUrl}/chat/completions`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`,
            },
            body: JSON.stringify({
              model: config.model,
              messages: [
                { role: "system", content: HARVEST_PROMPT },
                { role: "user", content: transcript },
              ],
              response_format: { type: "json_object" },
            }),
          },
          harvestTimeoutMs,
        )
      } catch {
        return EMPTY_HARVEST
      }
      if (!res.ok) {
        try {
          throw new Error(`harvest error: ${res.status} ${await res.text()}`)
        } catch {
          return EMPTY_HARVEST
        }
      }
      // Harvest is best-effort: a failed distillation must never take down
      // (or invalidate) a run that already produced an answer.
      try {
        const data = (await res.json()) as { choices: Array<{ message: { content: string } }> }
        const content = data.choices[0]?.message?.content ?? ""
        const parsed = HarvestSchema.parse(JSON.parse(content))
        return {
          memories: parsed.memories.map((m) => ({ key: m.key, content: m.content ?? null })),
          skills: parsed.skills.map((s) => ({
            name: s.name,
            description: s.description,
            steps: s.steps,
            ...(s.verification === undefined ? {} : { verification: s.verification }),
          })),
        }
      } catch {
        return EMPTY_HARVEST
      }
    },
    async judge(goal: string, answer: string, transcript: string): Promise<boolean> {
      const res = await fetchWithTimeout(
        `${config.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: "system", content: JUDGE_PROMPT },
              { role: "user", content: `Goal: ${goal}\n\nFinal answer:\n${answer}\n\nTranscript:\n${transcript}` },
            ],
            max_tokens: 16,
          }),
        },
        judgeTimeoutMs,
      )
      if (!res.ok) throw new Error(`judge error: ${res.status} ${await res.text()}`)
      const data = (await res.json()) as { choices: Array<{ message: { content: string } }> }
      const verdict = (data.choices[0]?.message?.content ?? "").trim().toLowerCase()
      if (verdict.startsWith("yes")) return true
      if (verdict.startsWith("no")) return false
      throw new Error(`unparseable judge verdict: ${JSON.stringify(verdict)}`)
    },
    async summarizeRounds(transcript: string): Promise<string> {
      const res = await fetchWithTimeout(
        `${config.baseUrl}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${config.apiKey}`,
          },
          body: JSON.stringify({
            model: config.model,
            messages: [
              { role: "system", content: COMPACT_PROMPT },
              { role: "user", content: transcript.slice(-MAX_COMPACT_TRANSCRIPT_CHARS) },
            ],
            max_tokens: 400,
          }),
        },
        compactTimeoutMs,
      )
      if (!res.ok) throw new Error(`compact error: ${res.status} ${await res.text()}`)
      const data = (await res.json()) as { choices: Array<{ message: { content: string } }> }
      return (data.choices[0]?.message?.content ?? "").trim()
    },
  }
}
