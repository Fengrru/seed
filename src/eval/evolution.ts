import type { AgentFixture, Verify } from "./runner.js"

export interface EvolutionRunResult {
  run: number
  passed: boolean
  steps: number
  answer: string
}

export interface EvolutionResult {
  goal: string
  runs: EvolutionRunResult[]
  improved: boolean
  firstPassed: boolean
  lastPassed: boolean
  stepsTrend: number[]
}

// The claim this project makes is "gets smarter with use". This measures it:
// one agent, one goal repeated across fresh sessions of the same self —
// harvest, consolidation, and usage feedback run between attempts, so a
// passing later run that failed earlier is evidence the loop works.
// beforeRun lets the harness reset task artifacts between attempts so a later
// run cannot pass by finding a previous run's leftovers.
export async function measureEvolution(opts: {
  createAgent: () => AgentFixture
  goal: string
  verify: Verify
  runs?: number
  beforeRun?: (run: number) => Promise<void> | void
}): Promise<EvolutionResult> {
  const runs = opts.runs ?? 3
  const fixture = opts.createAgent()
  const results: EvolutionRunResult[] = []
  try {
    for (let i = 0; i < runs; i++) {
      await opts.beforeRun?.(i + 1)
      const session = fixture.agent.session()
      const { answer, steps } = await session.run(opts.goal)
      const events = fixture.agent.log.replaySession(session.id)
      const passed = await opts.verify({ workspace: fixture.workspace, events, answer })
      results.push({ run: i + 1, passed, steps, answer })
    }
  } finally {
    fixture.agent.dispose()
  }

  return {
    goal: opts.goal,
    runs: results,
    improved: results.at(-1)?.passed === true && results[0]?.passed === false,
    firstPassed: results[0]?.passed ?? false,
    lastPassed: results.at(-1)?.passed ?? false,
    stepsTrend: results.map((r) => r.steps),
  }
}
