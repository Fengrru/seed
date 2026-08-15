import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createAgent } from "../agent.js"
import { createOpenAIModel } from "../model/openai.js"
import { type LearningScenario, runBenchmark } from "./benchmark.js"

const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com/v1"
const apiKey = process.env.OPENAI_API_KEY ?? ""
const model = process.env.SEED_MODEL ?? "deepseek-chat"

if (!apiKey) {
  console.error("OPENAI_API_KEY is required.")
  process.exit(1)
}

const root = mkdtempSync(join(tmpdir(), "seed-bench-"))
let n = 0

function makeAgent() {
  const dir = join(root, `run-${n++}`)
  mkdirSync(dir)
  return {
    workspace: dir,
    agent: createAgent({
      dbPath: join(root, `agent-${n}.db`),
      workspace: dir,
      // The warm run must exercise the system's own memory mechanism, not
      // the model's willingness to obey the teach prompt.
      autoHarvest: true,
      model: createOpenAIModel({ baseUrl, apiKey, model }),
    }),
  }
}

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

function fileContents(workspace: string): string {
  return listWorkspaceFiles(workspace)
    .map((f) => readFileSync(f, "utf8"))
    .join("\n")
}

const scenarios: LearningScenario[] = [
  {
    name: "copyright-header",
    teach: "remember: every Python file I create must start with the comment `# (c) zeta-org-2026`",
    test: "create a Python file with a helper function",
    verify: ({ workspace }) => {
      const py = listWorkspaceFiles(workspace).filter((f) => f.endsWith(".py"))
      return py.some((f) => readFileSync(f, "utf8").includes("zeta-org-2026"))
    },
  },
  {
    name: "default-port",
    teach: "remember: my dev server always runs on port 9090, never 8080",
    test: "write a config file for my dev server and report the port",
    verify: ({ workspace }) => fileContents(workspace).includes("9090"),
  },
  {
    name: "naming-prefix",
    teach: "remember: all data files I create must have the prefix `raw_`",
    test: "create a data file for my dataset",
    verify: ({ workspace }) => listWorkspaceFiles(workspace).some((f) => f.split(/[\\/]/).at(-1)?.startsWith("raw_")),
  },
]

try {
  const result = await runBenchmark({
    createAgent: makeAgent,
    scenarios,
    samples: Number(process.env.SEED_BENCH_SAMPLES ?? 1),
  })

  console.log("=== benchmark results ===")
  for (const s of result.scenarios) {
    const mark = s.error ? "ERROR" : s.helped ? "HELPED" : s.warmPassed === s.coldPassed ? "---" : "HURT"
    console.log(
      `  ${s.name.padEnd(18)} cold=${s.coldPassed ? "pass" : "FAIL"}(${s.coldSteps}s) warm=${s.warmPassed ? "pass" : "FAIL"}(${s.warmSteps}s) ${mark}`,
    )
    if (s.error) console.log(`    error: ${s.error}`)
    if (!s.coldPassed) console.log(`    cold answer: ${JSON.stringify(s.coldAnswer).slice(0, 200)}`)
    if (!s.warmPassed) console.log(`    warm answer: ${JSON.stringify(s.warmAnswer).slice(0, 200)}`)
  }
  console.log(`  cold pass rate: ${result.coldPassRate.toFixed(2)}`)
  console.log(`  warm pass rate: ${result.warmPassRate.toFixed(2)}`)
  console.log(`  helped: ${result.helpedCount}/${result.total}, hurt: ${result.hurtCount}/${result.total}`)
} finally {
  rmSync(root, { recursive: true, force: true })
}
