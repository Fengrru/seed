import { type AgentFixture, measureWarmVsCold, type Verify } from "./runner.js"

export interface LearningScenario {
  name: string
  teach: string
  test: string
  verify: Verify
}

export interface ScenarioResult {
  name: string
  coldPassed: boolean
  warmPassed: boolean
  coldSteps: number
  warmSteps: number
  coldAnswer: string
  warmAnswer: string
  helped: boolean
  error?: string
}

export interface BenchmarkResult {
  scenarios: ScenarioResult[]
  coldPassRate: number
  warmPassRate: number
  helpedCount: number
  hurtCount: number
  total: number
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms)
    p.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      },
    )
  })
}

export async function runBenchmark(opts: {
  createAgent: () => AgentFixture
  scenarios: LearningScenario[]
  samples?: number
  // Wall-clock budget per cold+warm sample pair; a model call that hangs
  // must fail the scenario, not the whole benchmark.
  timeoutMs?: number
}): Promise<BenchmarkResult> {
  const samples = opts.samples ?? 1
  const timeoutMs = opts.timeoutMs ?? 120_000

  const results: ScenarioResult[] = []
  for (const s of opts.scenarios) {
    let coldPasses = 0
    let warmPasses = 0
    let coldSteps = 0
    let warmSteps = 0
    let coldAnswer = ""
    let warmAnswer = ""
    let error: string | undefined

    for (let i = 0; i < samples; i++) {
      try {
        const r = await withTimeout(
          measureWarmVsCold({
            createAgent: opts.createAgent,
            teach: s.teach,
            test: s.test,
            verify: s.verify,
          }),
          timeoutMs,
        )
        if (r.coldPassed) coldPasses++
        if (r.warmPassed) warmPasses++
        coldSteps += r.coldSteps
        warmSteps += r.warmSteps
        coldAnswer = r.coldAnswer
        warmAnswer = r.warmAnswer
      } catch (e) {
        error = e instanceof Error ? e.message : String(e)
      }
    }

    const coldPassed = coldPasses > samples / 2
    const warmPassed = warmPasses > samples / 2
    results.push({
      name: s.name,
      coldPassed,
      warmPassed,
      coldSteps: Math.round(coldSteps / samples),
      warmSteps: Math.round(warmSteps / samples),
      coldAnswer,
      warmAnswer,
      helped: warmPassed && !coldPassed,
      ...(error === undefined ? {} : { error }),
    })
  }

  const total = results.length
  const coldPassRate = total === 0 ? 0 : results.filter((r) => r.coldPassed).length / total
  const warmPassRate = total === 0 ? 0 : results.filter((r) => r.warmPassed).length / total

  return {
    scenarios: results,
    coldPassRate,
    warmPassRate,
    helpedCount: results.filter((r) => r.helped).length,
    hurtCount: results.filter((r) => r.coldPassed && !r.warmPassed).length,
    total,
  }
}
