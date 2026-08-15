import type { Agent } from "../agent.js"
import type { Event } from "../schema/event.js"

// Verification must be able to judge what actually happened in the workspace
// and the event log — not just whether the final answer repeats a keyword.
export interface VerifyContext {
  workspace: string
  events: Event[]
  answer: string
}

export type Verify = (ctx: VerifyContext) => boolean | Promise<boolean>

export interface EvalCase {
  name: string
  goal: string
  verify: Verify
}

export interface EvalResult {
  name: string
  passed: boolean
  answer: string
  steps: number
}

export async function runEvalCase(
  agent: Agent,
  sessionId: string | undefined,
  c: EvalCase,
  workspace: string,
): Promise<EvalResult> {
  const session = agent.session(sessionId)
  const { answer, steps } = await session.run(c.goal)
  const events = agent.log.replaySession(session.id)
  return { name: c.name, passed: await c.verify({ workspace, events, answer }), answer, steps }
}

export interface SuiteResult {
  passed: number
  total: number
  results: EvalResult[]
}

export async function runSuite(agent: Agent, cases: EvalCase[], workspace: string): Promise<SuiteResult> {
  const results: EvalResult[] = []
  for (const c of cases) {
    results.push(await runEvalCase(agent, undefined, c, workspace))
  }
  return { passed: results.filter((r) => r.passed).length, total: results.length, results }
}

export interface AgentFixture {
  agent: Agent
  workspace: string
}

export interface WarmColdResult {
  coldPassed: boolean
  warmPassed: boolean
  coldSteps: number
  warmSteps: number
  coldAnswer: string
  warmAnswer: string
}

export async function measureWarmVsCold(opts: {
  createAgent: () => AgentFixture
  teach: string
  test: string
  verify: Verify
}): Promise<WarmColdResult> {
  const coldFixture = opts.createAgent()
  try {
    const coldSession = coldFixture.agent.session()
    const coldOutcome = await coldSession.run(opts.test)
    const coldPassed = await opts.verify({
      workspace: coldFixture.workspace,
      events: coldFixture.agent.log.replaySession(coldSession.id),
      answer: coldOutcome.answer,
    })

    const warmFixture = opts.createAgent()
    const warm = warmFixture.agent
    try {
      await warm.session("teach").run(opts.teach)
      const testSession = warm.session("test")
      const warmOutcome = await testSession.run(opts.test)
      const warmPassed = await opts.verify({
        workspace: warmFixture.workspace,
        events: warm.log.replaySession("test"),
        answer: warmOutcome.answer,
      })

      return {
        coldPassed,
        warmPassed,
        coldSteps: coldOutcome.steps,
        warmSteps: warmOutcome.steps,
        coldAnswer: coldOutcome.answer,
        warmAnswer: warmOutcome.answer,
      }
    } finally {
      warm.dispose()
    }
  } finally {
    coldFixture.agent.dispose()
  }
}
