import { Database } from "bun:sqlite"
import { AsyncLocalStorage } from "node:async_hooks"
import { appendFileSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createBashConnection, createReadConnection, createWriteConnection } from "./connection/builtin.js"
import { createDelegateConnection } from "./connection/delegate.js"
import { createMcpConnections } from "./connection/mcp.js"
import { type McpServerConfig, McpStdioClient, type McpTool } from "./connection/mcp-client.js"
import { McpHttpClient, type McpHttpConfig } from "./connection/mcp-http.js"
import { createMemoryConnection } from "./connection/memory.js"
import { createSearchConnection, type SearchProvider } from "./connection/search.js"
import { createSkillConnection } from "./connection/skill.js"
import { createTaskConnection } from "./connection/task.js"
import { consolidate } from "./kernel/consolidate.js"
import { harvestInto } from "./kernel/harvest.js"
import { run } from "./kernel/loop.js"
import { buildGuidance, GUIDANCE_WINDOW_EVENTS, metacognize } from "./kernel/meta.js"
import { verifyDraftSkills } from "./kernel/skill-verify.js"
import { assembleContext } from "./kernel/working-set.js"
import type { EmbeddingProvider } from "./memory/embedding-provider.js"
import { createEmbeddingRetriever } from "./memory/embedding-retriever.js"
import { createRetriever, type Retriever } from "./memory/retriever.js"
import type { Model } from "./model/model.js"
import type { Connection, Trust } from "./schema/connection.js"
import type { Event } from "./schema/event.js"
import { DEFAULT_COMPACT_THRESHOLD, planCompaction } from "./session/compact.js"
import { reconstructHistory, renderTranscript } from "./session/history.js"
import { SqliteLog, validEvidenceIds } from "./store/log.js"
import { SqliteSelfStore } from "./store/self.js"

export interface AgentOptions {
  dbPath: string
  workspace: string
  model: Model
  contextBudgetTokens?: number
  autoHarvest?: boolean
  autoVerifySkills?: boolean
  autoMeta?: boolean
  // Independent judge verdict after each run drives the feedback loop.
  // Only effective when the model implements judge; disabled by default in
  // tests via fake models, which simply do not implement it.
  goalVerify?: boolean
  searchProvider?: SearchProvider
  embeddingProvider?: EmbeddingProvider
  maxDelegateDepth?: number
  // How many runs between consolidation passes (loop D); 0 disables it.
  consolidateEvery?: number
  // Fold completed earlier rounds of a session into compact events once the
  // reconstructed history exceeds this many characters; 0 disables. See
  // docs/history-compaction-design.md.
  compactThreshold?: number
  // Phase 2 of history compaction: write fold summaries with the model
  // instead of the deterministic format (falls back on failure).
  compactModel?: boolean
  // Archive and prune event-log rows older than this many days. Off by
  // default; pruning breaks evidence citations into the pruned range.
  logRetentionDays?: number
  // Trust gate: connections with trust below confirmBelowTrust must be
  // approved by approveCall before they run. Without approveCall such calls
  // fail with "approval_required" instead of executing.
  approveCall?: (connection: Connection, args: unknown) => Promise<boolean>
  confirmBelowTrust?: Trust
}

export interface RunOutcome {
  answer: string
  steps: number
  stopped: "done" | "max_steps" | "error"
  // Whether the goal was judged achieved (falls back to stopped === "done"
  // when no judge is available or the judge fails).
  goalAchieved: boolean
}

export interface Session {
  readonly id: string
  run(goal: string, onStep?: (event: Event) => void): Promise<RunOutcome>
}

export interface Agent {
  session(sessionId?: string): Session
  connectMcp(servers: McpServerConfig[]): Promise<McpTool[]>
  connectMcpHttp(servers: McpHttpConfig[]): Promise<McpTool[]>
  log: SqliteLog
  self: SqliteSelfStore
  // Releases every resource the agent owns (database, MCP subprocesses,
  // delegate worktrees). The agent must not be used afterwards.
  dispose(): void
}

export function createAgent(options: AgentOptions): Agent {
  const db = new Database(options.dbPath)
  db.run("PRAGMA journal_mode = WAL")
  db.run("PRAGMA foreign_keys = ON")

  const log = new SqliteLog(db)
  const self = new SqliteSelfStore(db)
  const retriever: Retriever = options.embeddingProvider
    ? createEmbeddingRetriever(self, options.embeddingProvider)
    : createRetriever(self)
  const budget = options.contextBudgetTokens ?? 8000
  // The evolution loop is the point of the system: learning and reflection
  // default on. Skill verification stays opt-in because it runs arbitrary
  // shell commands (see README security model).
  const autoHarvest = options.autoHarvest ?? true
  const autoVerifySkills = options.autoVerifySkills ?? false
  const autoMeta = options.autoMeta ?? true
  const goalVerify = options.goalVerify ?? true
  // Consolidation runs every N sessions (loop D): deterministic, amortized,
  // no background timers.
  const consolidateEvery = options.consolidateEvery ?? 8
  const compactThreshold = options.compactThreshold ?? DEFAULT_COMPACT_THRESHOLD
  const compactModel = options.compactModel ?? false
  const logRetentionDays = options.logRetentionDays ?? 0
  let runsSinceConsolidate = 0

  const maxDelegateDepth = options.maxDelegateDepth ?? 3
  const delegateDepth = new AsyncLocalStorage<number>()
  const delegateWorktrees = new Set<string>()
  let delegate!: Connection

  function buildConnections(dir: string): Map<string, Connection> {
    const m = new Map<string, Connection>()
    const read = createReadConnection(dir)
    const write = createWriteConnection(dir)
    const bash = createBashConnection(dir)
    m.set(read.id, read)
    m.set(write.id, write)
    m.set(bash.id, bash)
    m.set("memory", createMemoryConnection(self, log))
    m.set("skill", createSkillConnection(self, dir, log))
    m.set("task", createTaskConnection(log))
    if (options.searchProvider) {
      const search = createSearchConnection(options.searchProvider, self, log)
      m.set(search.id, search)
    }
    m.set(delegate.id, delegate)
    return m
  }

  async function runDelegate(goal: string, dir: string): Promise<{ answer: string; steps: number; worktree: string }> {
    const depth = delegateDepth.getStore() ?? 0
    if (depth >= maxDelegateDepth) {
      throw new Error(`delegation depth limit (${maxDelegateDepth}) reached`)
    }
    const sessionId = crypto.randomUUID()
    const result = await delegateDepth.run(depth + 1, () =>
      run({ sessionId, goal, context: "", history: [], model: options.model, connections: buildConnections(dir), log }),
    )
    return { answer: result.answer, steps: result.steps, worktree: dir }
  }

  delegate = createDelegateConnection({
    runOne: (goal) => runDelegate(goal, options.workspace),
    runMany: (goals) =>
      Promise.all(
        goals.map((g) => {
          const dir = mkdtempSync(join(tmpdir(), "seed-worktree-"))
          delegateWorktrees.add(dir)
          return runDelegate(g, dir).finally(() => {
            delegateWorktrees.delete(dir)
            rmSync(dir, { recursive: true, force: true })
          })
        }),
      ),
  })

  const connections = buildConnections(options.workspace)

  const mcpClients: McpStdioClient[] = []
  const mcpHttpClients: McpHttpClient[] = []
  // Serializes run() calls per session so two concurrent turns cannot
  // interleave their events in the log.
  const sessionLocks = new Map<string, Promise<unknown>>()

  function runSession(id: string, goal: string, onStep?: (event: Event) => void): Promise<RunOutcome> {
    return (async () => {
      const priorEvents = log.replaySession(id)
      // Compact events only fold their covers when those citations verify
      // against the log; untrusted compacts degrade to full history replay.
      const trustedCompacts = new Set<string>()
      for (const e of priorEvents) {
        if (e.type === "compact" && log.verifyEvidence(e.covers).ok) trustedCompacts.add(e.id)
      }
      let history = reconstructHistory(priorEvents, { trustedCompacts })
      if (compactThreshold > 0) {
        const plan = planCompaction(priorEvents, compactThreshold, trustedCompacts)
        for (const fold of plan) {
          const covers = validEvidenceIds(log, fold.covers)
          if (covers.length === 0) continue
          let summary = fold.summary
          if (compactModel && options.model.summarizeRounds) {
            try {
              // Model-written summaries are nicer but optional: on failure
              // the deterministic summary stands.
              summary =
                (await options.model.summarizeRounds(renderTranscript(fold.events))).slice(0, 800) || fold.summary
            } catch (e) {
              console.warn(
                `(compact summary failed, using deterministic summary: ${e instanceof Error ? e.message : String(e)})`,
              )
            }
          }
          const compactId = crypto.randomUUID()
          log.append({ type: "compact", id: compactId, ts: Date.now(), sessionId: id, covers, summary })
          trustedCompacts.add(compactId)
        }
        if (plan.length > 0) history = reconstructHistory(log.replaySession(id), { trustedCompacts })
      }
      // An embedding outage must not take down the whole agent: fall back to
      // the local TF-IDF retriever so runs still get their knowledge context.
      const entries = await retriever.retrieve(goal, 10).catch((e) => {
        console.warn(`(retriever failed, using TF-IDF fallback: ${e instanceof Error ? e.message : String(e)})`)
        return createRetriever(self).retrieve(goal, 10)
      })
      const { context, included } = assembleContext(entries, budget)
      // Guidance aggregates across sessions: the more the agent has done,
      // the better its own failure statistics become. Bounded to the most
      // recent events so its cost does not grow with the append-only log.
      const guidance = buildGuidance(log.replayRecent(GUIDANCE_WINDOW_EVENTS))
      const fullContext = guidance ? `${guidance}\n\n${context}` : context
      const result = await run({
        sessionId: id,
        goal,
        context: fullContext,
        history,
        model: options.model,
        connections,
        log,
        ...(onStep === undefined ? {} : { onStep }),
        ...(options.approveCall === undefined ? {} : { approve: options.approveCall }),
        ...(options.confirmBelowTrust === undefined ? {} : { confirmBelow: options.confirmBelowTrust }),
        // Production verdicts: judge the tool-level outcome rather than
        // leaving every verdict at "unverified".
        verify: (_step, outcome) => {
          const r = outcome as { ok?: unknown; error?: { code?: string } } | null
          if (r && typeof r === "object" && r.ok === false) {
            return Promise.resolve({ ok: false, detail: r.error?.code ?? "failed" })
          }
          return Promise.resolve({ ok: true, detail: "completed" })
        },
      })

      const sessionEvents = log.replaySession(id)

      // Goal verification: "finished" must not be mistaken for "succeeded".
      // An independent judge verdict drives the feedback loop; on any judge
      // failure we fall back to the run outcome (fail-open).
      let goalAchieved = result.stopped === "done"
      if (goalAchieved && goalVerify && options.model.judge) {
        try {
          goalAchieved = await options.model.judge(goal, result.answer, renderTranscript(sessionEvents).slice(-8000))
        } catch (e) {
          console.warn(`(goal judge failed, using run outcome: ${e instanceof Error ? e.message : String(e)})`)
        }
      }

      // I8: the verdict that drives the feedback loop is itself an auditable
      // event, so a later metrics bump can always be traced to its cause.
      log.append({
        type: "verdict",
        id: crypto.randomUUID(),
        ts: Date.now(),
        sessionId: id,
        ok: goalAchieved,
        detail: `goal ${goalAchieved ? "achieved" : "not achieved"}`,
      })

      // Usage feedback (loop A): every entry that was injected into this
      // run's context gets an outcome recorded — this is the signal that
      // makes retrieval ranking converge toward knowledge that works.
      for (const { kind, name } of included) {
        self.recordOutcome(kind, name, goalAchieved)
      }

      if (autoHarvest && options.model.harvest && result.stopped === "done" && result.steps > 0) {
        try {
          // Memories distilled from a session with failed tool calls or an
          // unachieved goal are proposals, not facts (loop B: source quality
          // gate).
          const failedCount = sessionEvents.filter(
            (e) => e.type === "result" && (e.result as { ok?: boolean } | null)?.ok === false,
          ).length
          const output = await options.model.harvest(renderTranscript(sessionEvents))
          const harvested = await harvestInto(self, output, {
            sessionId: id,
            // I7: unverifiable citations are dropped at write time, same as
            // the memory/skill/search connections do.
            evidenceIds: validEvidenceIds(log, sessionEvents.map((e) => e.id).slice(-50)),
            sourceQuality: goalAchieved && failedCount === 0 ? "good" : "poor",
          })
          log.append({
            type: "harvest",
            id: crypto.randomUUID(),
            ts: Date.now(),
            sessionId: id,
            data: harvested,
          })
          // Close the skill loop: any distilled skill with a verification
          // command is verified and promoted to active (adopt) on pass.
          // This runs arbitrary shell commands, so it stays off unless
          // explicitly enabled.
          if (autoVerifySkills) {
            await verifyDraftSkills(self, options.workspace, log, id)
          }
        } catch (e) {
          // Harvest is best-effort: the run already produced an answer
          // and failing to distill it must not throw that answer away.
          console.warn(`(harvest failed: ${e instanceof Error ? e.message : String(e)})`)
        }
      }

      if (autoMeta) {
        // Cross-session: failure patterns accumulate across everything the
        // agent has recently done, not just the current conversation. The
        // window keeps the per-run cost bounded as the log grows.
        metacognize(log.replayRecent(GUIDANCE_WINDOW_EVENTS), self)
      }

      runsSinceConsolidate += 1
      if (consolidateEvery > 0 && runsSinceConsolidate >= consolidateEvery) {
        runsSinceConsolidate = 0
        const result = consolidate(self)
        log.append({
          type: "consolidate",
          id: crypto.randomUUID(),
          ts: Date.now(),
          sessionId: id,
          data: result,
        })
      }

      if (logRetentionDays > 0) {
        // Retention is opt-in: the log is the audit source, and pruning
        // breaks evidence citations into the pruned range. Archived rows go
        // to a JSONL sidecar next to the database first.
        const cutoff = Date.now() - logRetentionDays * 24 * 3600_000
        const old = log.eventsBefore(cutoff)
        if (old.length > 0) {
          const archivePath = `${options.dbPath}.archive.jsonl`
          appendFileSync(archivePath, `${old.map((e) => JSON.stringify(e)).join("\n")}\n`)
          log.pruneBefore(cutoff)
          log.append({
            type: "prune",
            id: crypto.randomUUID(),
            ts: Date.now(),
            sessionId: id,
            before: cutoff,
            archived: old.length,
          })
        }
      }

      return { answer: result.answer, steps: result.steps, stopped: result.stopped, goalAchieved }
    })()
  }

  return {
    log,
    self,
    async connectMcp(servers: McpServerConfig[]): Promise<McpTool[]> {
      const addedClients: McpStdioClient[] = []
      const addedIds: string[] = []
      try {
        const added: McpTool[] = []
        for (const config of servers) {
          const client = new McpStdioClient(config)
          await client.connect()
          addedClients.push(client)
          for (const conn of createMcpConnections(client)) {
            if (connections.has(conn.id)) {
              throw new Error(`tool conflict: ${conn.id} is already registered`)
            }
            connections.set(conn.id, conn)
            addedIds.push(conn.id)
            added.push(conn.schema as unknown as McpTool)
          }
        }
        mcpClients.push(...addedClients)
        return added
      } catch (e) {
        // Roll back a partially-registered batch so a failed connect leaves
        // the connection table exactly as it was.
        for (const connId of addedIds) connections.delete(connId)
        for (const client of addedClients) client.close()
        throw e
      }
    },
    async connectMcpHttp(servers: McpHttpConfig[]): Promise<McpTool[]> {
      const addedClients: McpHttpClient[] = []
      const addedIds: string[] = []
      try {
        const added: McpTool[] = []
        for (const config of servers) {
          const client = new McpHttpClient(config)
          await client.connect()
          addedClients.push(client)
          for (const conn of createMcpConnections(client)) {
            if (connections.has(conn.id)) {
              throw new Error(`tool conflict: ${conn.id} is already registered`)
            }
            connections.set(conn.id, conn)
            addedIds.push(conn.id)
            added.push(conn.schema as unknown as McpTool)
          }
        }
        mcpHttpClients.push(...addedClients)
        return added
      } catch (e) {
        for (const connId of addedIds) connections.delete(connId)
        for (const client of addedClients) client.close()
        throw e
      }
    },
    session(sessionId?: string): Session {
      const id = sessionId ?? crypto.randomUUID()
      return {
        id,
        run(goal: string, onStep?: (event: Event) => void): Promise<RunOutcome> {
          const previous = sessionLocks.get(id) ?? Promise.resolve()
          const task = previous.catch(() => {}).then(() => runSession(id, goal, onStep))
          sessionLocks.set(id, task)
          return task.finally(() => {
            if (sessionLocks.get(id) === task) sessionLocks.delete(id)
          })
        },
      }
    },
    dispose(): void {
      for (const client of mcpClients) client.close()
      mcpClients.length = 0
      for (const client of mcpHttpClients) client.close()
      mcpHttpClients.length = 0
      for (const dir of delegateWorktrees) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // best-effort cleanup
        }
      }
      delegateWorktrees.clear()
      db.close()
    },
  }
}
