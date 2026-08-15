import { createAgent } from "./agent.js"
import { cliConfigFromEnv } from "./cli-config.js"
import { createHttpSearchProvider } from "./connection/search.js"
import { createOpenAIEmbeddingProvider } from "./memory/embedding-provider.js"
import { createOpenAIModel } from "./model/openai.js"
import type { Event } from "./schema/event.js"

const baseUrl = process.env.OPENAI_BASE_URL ?? "https://api.deepseek.com/v1"
const apiKey = process.env.OPENAI_API_KEY
const model = process.env.SEED_MODEL ?? "deepseek-chat"

if (!apiKey) {
  console.error("OPENAI_API_KEY is required.")
  process.exit(1)
}

const workspace = process.env.SEED_WORKSPACE ?? process.cwd()
const dbPath = process.env.SEED_DB ?? `${process.cwd()}/seed.db`
const sessionId = process.env.SEED_SESSION ?? "default"

// Unset variables must not override the agent defaults (autoHarvest/autoMeta
// are ON by default; "1"/"0" opt in/out explicitly).
function flag(name: string): boolean | undefined {
  const value = process.env[name]
  if (value === undefined || value === "") return undefined
  return value === "1"
}

const autoHarvest = flag("SEED_AUTO_HARVEST")
const autoVerifySkills = flag("SEED_AUTO_VERIFY_SKILLS")
const autoMeta = flag("SEED_AUTO_META")

function numberFlag(name: string): number | undefined {
  const value = process.env[name]
  if (value === undefined || value === "") return undefined
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : undefined
}

const compactThreshold = numberFlag("SEED_COMPACT_THRESHOLD")
const compactModel = flag("SEED_COMPACT_MODEL")
const logRetentionDays = numberFlag("SEED_LOG_RETENTION_DAYS")

const cliConfig = cliConfigFromEnv(process.env)

const agent = createAgent({
  dbPath,
  workspace,
  model: createOpenAIModel({ baseUrl, apiKey, model }),
  ...(autoHarvest === undefined ? {} : { autoHarvest }),
  ...(autoVerifySkills === undefined ? {} : { autoVerifySkills }),
  ...(autoMeta === undefined ? {} : { autoMeta }),
  ...(compactThreshold === undefined ? {} : { compactThreshold }),
  ...(compactModel === undefined ? {} : { compactModel }),
  ...(logRetentionDays === undefined ? {} : { logRetentionDays }),
  ...(cliConfig.search === undefined ? {} : { searchProvider: createHttpSearchProvider(cliConfig.search) }),
  ...(cliConfig.embeddingModel === undefined
    ? {}
    : { embeddingProvider: createOpenAIEmbeddingProvider({ baseUrl, apiKey, model: cliConfig.embeddingModel }) }),
  // SEED_CONFIRM=1 asks before every reviewed-or-lower tool call (bash,
  // search, MCP). Fails closed when stdin is not interactive.
  ...(process.env.SEED_CONFIRM === "1"
    ? {
        // The gate triggers strictly below this level, so "trusted" is what
        // makes reviewed tools (bash, search, MCP) ask for confirmation.
        confirmBelowTrust: "trusted" as const,
        approveCall: async (conn, args) => {
          const answer = prompt(`[confirm] run ${conn.id} ${JSON.stringify(args).slice(0, 120)}? [y/N] `)
          return (answer ?? "").trim().toLowerCase() === "y"
        },
      }
    : {}),
})

if (cliConfig.mcpServers.length > 0) {
  try {
    const tools = await agent.connectMcp(cliConfig.mcpServers)
    console.log(`MCP: ${tools.length} tool(s) from ${cliConfig.mcpServers.length} stdio server(s)`)
  } catch (e) {
    console.error(`(MCP connect failed: ${e instanceof Error ? e.message : String(e)})`)
  }
}
if (cliConfig.mcpHttpServers.length > 0) {
  try {
    const tools = await agent.connectMcpHttp(cliConfig.mcpHttpServers)
    console.log(`MCP: ${tools.length} tool(s) from ${cliConfig.mcpHttpServers.length} HTTP server(s)`)
  } catch (e) {
    console.error(`(MCP HTTP connect failed: ${e instanceof Error ? e.message : String(e)})`)
  }
}

let session = agent.session(sessionId)

function printStep(e: Event): void {
  if (e.type === "step") console.log(`  \u2514 ${e.tool} ${JSON.stringify(e.args).slice(0, 120)}`)
}

// One-shot mode: `bun run run "goal"` runs a single goal and exits instead
// of entering the REPL. The session persists, so repeated one-shots resume.
const goal = process.argv.slice(2).join(" ").trim()
if (goal) {
  try {
    const { answer } = await session.run(goal, printStep)
    console.log(answer)
  } catch (e) {
    console.error(`\n(run failed: ${e instanceof Error ? e.message : String(e)})`)
    process.exitCode = 1
  }
  agent.dispose()
  process.exit(process.exitCode ?? 0)
}

console.log(`Seed — session "${sessionId}"`)
console.log("Type your message. Commands: /quit, /new")
process.stdout.write("> ")

for await (const line of console) {
  const input = line.trim()
  if (input === "/quit" || input === "/exit") break
  if (input === "/new") {
    session = agent.session()
    console.log(`(new session ${session.id})`)
    process.stdout.write("> ")
    continue
  }
  if (!input) continue

  try {
    const { answer } = await session.run(input, printStep)
    console.log(answer)
  } catch (e) {
    console.error(`\n(run failed: ${e instanceof Error ? e.message : String(e)})`)
  }
  process.stdout.write("\n> ")
}

agent.dispose()
