import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { createAgent } from "../src/agent.js"
import type { Model } from "../src/model/model.js"
import type { Event } from "../src/schema/event.js"
import { planCompaction, summarizeRound } from "../src/session/compact.js"
import { reconstructHistory } from "../src/session/history.js"
import { tmpDir } from "./helpers.js"

// t0 offsets keep rounds' timestamps disjoint: replaySession orders by ts,
// so overlapping timestamps would interleave rounds and blur the boundaries.
function round(prefix: string, goal: string, answer: string, t0: number): Event[] {
  return [
    { type: "turn", id: `${prefix}-t`, ts: t0, sessionId: "s", goal },
    { type: "step", id: `${prefix}-s0`, ts: t0 + 1, sessionId: "s", tool: "echo", args: { text: "x".repeat(60) } },
    { type: "result", id: `${prefix}-r0`, ts: t0 + 2, sessionId: "s", stepId: `${prefix}-s0`, result: { ok: false } },
    { type: "step", id: `${prefix}-s1`, ts: t0 + 3, sessionId: "s", tool: "echo", args: { text: "y" } },
    { type: "result", id: `${prefix}-r1`, ts: t0 + 4, sessionId: "s", stepId: `${prefix}-s1`, result: { ok: true } },
    { type: "done", id: `${prefix}-d`, ts: t0 + 5, sessionId: "s", answer, stopped: "done" as const },
  ]
}

describe("summarizeRound", () => {
  test("renders a deterministic summary with counts and outcome", () => {
    const summary = summarizeRound(round("r1", "write a file", "wrote it", 1))
    expect(summary).toContain("[compacted turn] goal: write a file")
    expect(summary).toContain("(共 2 步, 失败 1 次)")
    expect(summary).toContain("echo(")
    expect(summary).toContain("outcome: wrote it")
  })

  test("truncates long args and long answers", () => {
    const events: Event[] = [
      { type: "turn", id: "t", ts: 1, sessionId: "s", goal: "g" },
      { type: "step", id: "s0", ts: 2, sessionId: "s", tool: "echo", args: { text: "z".repeat(500) } },
      { type: "result", id: "r0", ts: 3, sessionId: "s", stepId: "s0", result: { ok: true } },
      { type: "done", id: "d", ts: 4, sessionId: "s", answer: "a".repeat(2000), stopped: "done" },
    ]
    const summary = summarizeRound(events)
    expect(summary).toContain("…")
    expect(summary.length).toBeLessThan(1500)
  })

  test("marks interrupted rounds without a done event", () => {
    const summary = summarizeRound([
      { type: "turn", id: "t", ts: 1, sessionId: "s", goal: "g" },
      { type: "step", id: "s0", ts: 2, sessionId: "s", tool: "echo", args: {} },
    ])
    expect(summary).toContain("outcome: interrupted")
  })
})

describe("planCompaction", () => {
  test("plans nothing when history fits the threshold", () => {
    const events = [...round("r1", "g1", "a1", 1), ...round("r2", "g2", "a2", 100)]
    expect(planCompaction(events, 10_000, new Set())).toEqual([])
  })

  test("folds earliest complete rounds first and never the most recent", () => {
    const events = [
      ...round("r1", "first goal", "a".repeat(1500), 1),
      ...round("r2", "second goal", "b".repeat(1500), 100),
      ...round("r3", "third goal", "c".repeat(1500), 200),
    ]
    const plan = planCompaction(events, 1500, new Set())
    // Round 3 is the most recent and stays unfolded.
    expect(plan).toHaveLength(2)
    expect(plan[0]?.covers).toContain("r1-d")
    expect(plan[1]?.covers).toContain("r2-d")
    expect(plan.some((p) => p.covers.includes("r3-d"))).toBe(false)
    expect(plan[0]?.summary).toContain("first goal")
    expect(plan[1]?.summary).toContain("second goal")
  })

  test("skips rounds already covered by a trusted compact", () => {
    const first = round("r1", "first goal", "a".repeat(1500), 1)
    const compact: Event = {
      type: "compact",
      id: "c1",
      ts: 0,
      sessionId: "s",
      covers: first.map((e) => e.id),
      summary: "S1",
    }
    const events = [
      ...first,
      compact,
      ...round("r2", "second goal", "b".repeat(1500), 100),
      ...round("r3", "third goal", "c".repeat(1500), 200),
    ]
    const plan = planCompaction(events, 1500, new Set(["c1"]))
    // Round 1 is covered (not re-folded); round 3 is the most recent and
    // never folds; only round 2 is a candidate.
    expect(plan).toHaveLength(1)
    expect(plan[0]?.covers).toContain("r2-d")
  })
})

describe("reconstructHistory folding", () => {
  test("a trusted compact replaces its covered events with a summary", () => {
    const first = round("r1", "first goal", "long-lost-answer", 1)
    const second = round("r2", "second goal", "kept-answer", 100)
    const compact: Event = {
      type: "compact",
      id: "c1",
      ts: 0,
      sessionId: "s",
      covers: first.map((e) => e.id),
      summary: "summary of the first round",
    }
    const items = reconstructHistory([...first, ...second, compact], { trustedCompacts: new Set(["c1"]) })
    const text = items.map((i) => ("content" in i ? String(i.content) : "")).join("\n")
    expect(text).toContain("[earlier turns summarized]")
    expect(text).toContain("summary of the first round")
    expect(text).toContain("second goal")
    expect(text).not.toContain("long-lost-answer") // covered events expand nowhere
    expect(text).toContain("kept-answer")
    // The summary sits before the live round so the transcript stays
    // chronological.
    expect(items[0]).toMatchObject({ role: "assistant-text" })
    expect(String((items[0] as { content: string }).content)).toContain("earlier turns summarized")
  })

  test("an untrusted compact is ignored and its covered events expand", () => {
    const first = round("r1", "first goal", "expanded-answer", 1)
    const compact: Event = {
      type: "compact",
      id: "c1",
      ts: 0,
      sessionId: "s",
      covers: first.map((e) => e.id),
      summary: "S1",
    }
    const items = reconstructHistory([...first, compact], { trustedCompacts: new Set() })
    const text = items.map((i) => ("content" in i ? String(i.content) : "")).join("\n")
    expect(text).not.toContain("earlier turns summarized")
    expect(text).toContain("first goal")
    expect(text).toContain("expanded-answer")
  })
})

describe("agent compaction integration", () => {
  test("a session over the threshold folds earlier rounds into compact events", async () => {
    const dir = tmpDir()
    const seen: string[] = []
    const model: Model = {
      async decide(input) {
        seen.push(JSON.stringify(input.history))
        return [{ type: "done", answer: "done" }]
      },
    }
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model,
      compactThreshold: 800,
    })
    for (const e of [
      ...round("r1", "first goal", "a".repeat(1200), 1),
      ...round("r2", "second goal", "b".repeat(1200), 100),
    ]) {
      agent.log.append(e)
    }
    await agent.session("s").run("third goal")

    const compacts = agent.log.replaySession("s").filter((e) => e.type === "compact")
    expect(compacts).toHaveLength(1)
    const historyText = seen.join("\n")
    expect(historyText).toContain("earlier turns summarized")
    expect(historyText).toContain("first goal")
    // The folded round's full answer is gone; only its truncated summary
    // remains.
    expect(historyText).not.toContain("a".repeat(1200))
    // The most recent prior round stays unfolded, full answer included.
    expect(historyText).toContain("second goal")
    expect(historyText).toContain("b".repeat(1200))
    agent.dispose()
  })

  test("compactThreshold 0 disables compaction", async () => {
    const dir = tmpDir()
    const model: Model = {
      async decide() {
        return [{ type: "done", answer: "done" }]
      },
    }
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model,
      compactThreshold: 0,
    })
    for (const e of [
      ...round("r1", "first goal", "a".repeat(1200), 1),
      ...round("r2", "second goal", "b".repeat(1200), 100),
    ]) {
      agent.log.append(e)
    }
    await agent.session("s").run("third goal")
    expect(agent.log.replaySession("s").filter((e) => e.type === "compact")).toHaveLength(0)
    agent.dispose()
  })

  test("compactModel writes summaries with the model instead of the deterministic format", async () => {
    const dir = tmpDir()
    const model: Model = {
      async decide() {
        return [{ type: "done", answer: "done" }]
      },
      async summarizeRounds() {
        return "MODEL-WRITTEN SUMMARY"
      },
    }
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model,
      compactThreshold: 800,
      compactModel: true,
    })
    for (const e of [
      ...round("r1", "first goal", "a".repeat(1200), 1),
      ...round("r2", "second goal", "b".repeat(1200), 100),
    ]) {
      agent.log.append(e)
    }
    await agent.session("s").run("third goal")
    const compacts = agent.log.replaySession("s").filter((e) => e.type === "compact")
    expect(compacts).toHaveLength(1)
    expect((compacts[0] as { summary: string }).summary).toBe("MODEL-WRITTEN SUMMARY")
    agent.dispose()
  })

  test("a failing model summary falls back to the deterministic format", async () => {
    const dir = tmpDir()
    const model: Model = {
      async decide() {
        return [{ type: "done", answer: "done" }]
      },
      async summarizeRounds() {
        throw new Error("summarizer down")
      },
    }
    const agent = createAgent({
      dbPath: join(dir, "t.db"),
      workspace: dir,
      model,
      compactThreshold: 800,
      compactModel: true,
    })
    for (const e of [
      ...round("r1", "first goal", "a".repeat(1200), 1),
      ...round("r2", "second goal", "b".repeat(1200), 100),
    ]) {
      agent.log.append(e)
    }
    await agent.session("s").run("third goal")
    const compacts = agent.log.replaySession("s").filter((e) => e.type === "compact")
    expect(compacts).toHaveLength(1)
    expect((compacts[0] as { summary: string }).summary).toContain("[compacted turn] goal: first goal")
    agent.dispose()
  })
})
