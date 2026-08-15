import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgent } from "../agent.js"
import { createOpenAIModel } from "../model/openai.js"
import { measureEvolution } from "./evolution.js"
import type { VerifyContext } from "./runner.js"

const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com/v1"
const apiKey = process.env.OPENAI_API_KEY ?? ""
const model = process.env.SEED_MODEL ?? "deepseek-chat"

if (!apiKey) {
  console.error("OPENAI_API_KEY is required.")
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), "seed-evol-"))

function listWorkspaceFiles(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...listWorkspaceFiles(full))
    } else {
      out.push(full)
    }
  }
  return out
}

// The preference is taught in a dedicated teach run and NEVER restated in the
// test goal: a test run can only comply by retrieving the knowledge the
// evolution loop distilled. The test goal deliberately looks generic.
const teachGoal =
  "Remember this project rule: every python file I create must start with the exact comment line `# (c) zeta-org-2026`."
const testGoal =
  'Create a python file named "helper.py" that defines a function called double(x). Report the file path when done.'

function verify({ workspace, events }: VerifyContext): boolean {
  // The run itself must have written the file — a leftover from an earlier
  // attempt must not count.
  const wroteIt = events.some(
    (e) =>
      e.type === "step" &&
      e.tool === "fs_write" &&
      String((e.args as { path?: string })?.path ?? "").endsWith("helper.py"),
  )
  if (!wroteIt) return false
  const py = listWorkspaceFiles(workspace).find((f) => f.endsWith("helper.py"))
  if (!py) return false
  const content = readFileSync(py, "utf8")
  return content.includes("# (c) zeta-org-2026") && content.includes("def double")
}

const testRuns = Number(process.env.SEED_EVOL_RUNS ?? 3)
const dir = join(root, "workspace")
mkdirSync(dir)

try {
  const agent = createAgent({
    dbPath: join(root, "evolution.db"),
    workspace: dir,
    model: createOpenAIModel({ baseUrl, apiKey, model }),
  })

  // Teach phase: the rule enters the self (memory write or harvest), never
  // the test goal.
  const teach = await agent.session("teach").run(teachGoal)
  const ruleMemories = agent.self
    .latest()
    .filter((o) => o.kind === "memory" && JSON.stringify(o.content).includes("zeta-org-2026"))
  const learned = ruleMemories.length > 0

  // Test phase: repeated attempts against the evolving self.
  const result = await measureEvolution({
    createAgent: () => ({ workspace: dir, agent }),
    goal: testGoal,
    verify,
    runs: testRuns,
    // Each attempt starts from a clean slate so later runs cannot pass by
    // finding an earlier run's file.
    beforeRun: () => {
      rmSync(join(dir, "helper.py"), { force: true })
    },
  })

  console.log("=== evolution benchmark ===")
  console.log(`  teach: "${teachGoal}"`)
  console.log(`  teach outcome: ${teach.stopped}, judged achieved: ${teach.goalAchieved}`)
  console.log(`  rule distilled into memory: ${learned ? "yes" : "no"}`)
  for (const m of ruleMemories.slice(0, 3)) {
    console.log(
      `    - "${m.name}" (${m.state}, ver=${m.verification.status}, uses=${m.metrics.uses}, ok=${m.metrics.successes})`,
    )
  }
  console.log(`  test goal: "${testGoal}"`)
  for (const r of result.runs) {
    console.log(
      `  run ${r.run}: ${r.passed ? "pass" : "FAIL"} (${r.steps} steps) answer: ${JSON.stringify(r.answer).slice(0, 100)}`,
    )
  }
  console.log(`  steps trend: ${result.stepsTrend.join(" -> ")}`)
  if (learned && result.lastPassed) {
    console.log("  ✅ the evolution loop worked: the rule was learned and applied without being restated")
  } else if (learned) {
    console.log("  ⚠️ the rule was learned but later runs did not apply it")
  } else {
    console.log("  ❌ the rule was never distilled into memory")
  }
  if (result.improved) console.log("  ✅ improvement: first test failed, last test passed")
} finally {
  rmSync(root, { recursive: true, force: true })
}
