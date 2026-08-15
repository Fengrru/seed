import type { Database } from "bun:sqlite"
import {
  contentHash,
  type KnowledgeKind,
  type KnowledgeObject,
  KnowledgeObjectSchema,
  type KnowledgeState,
  type NewKnowledgeObject,
  type VerificationStatus,
} from "../schema/knowledge.js"

export interface SelfStore {
  add(name: string, obj: NewKnowledgeObject): KnowledgeObject
  get(kind: KnowledgeKind, name: string): KnowledgeObject | null
  findById(id: string): KnowledgeObject | null
  history(kind: KnowledgeKind, name: string): KnowledgeObject[]
  all(): KnowledgeObject[]
  latest(): KnowledgeObject[]
  touch(kind: KnowledgeKind, name: string): void
  recordOutcome(kind: KnowledgeKind, name: string, ok: boolean): void
  setVerification(kind: KnowledgeKind, name: string, status: VerificationStatus, lastVerifiedAt: number): void
  setState(kind: KnowledgeKind, name: string, state: KnowledgeState): void
  // Knowledge ids that declare a derivation edge to the given upstream id.
  dependentsOf(upstreamId: string): string[]
}

// A persisted row that fails schema validation is surfaced loudly instead of
// being silently cast into memory where it can corrupt downstream decisions.
export class DataCorruptionError extends Error {
  readonly rowId: string

  constructor(rowId: string, detail: string) {
    super(`knowledge row ${rowId} is corrupt: ${detail}`)
    this.rowId = rowId
  }
}

interface Row {
  id: string
  name: string
  kind: string
  version: number
  parent_id: string | null
  content: string
  source: string
  refs: string
  evidence: string
  verification_status: string
  verification_check: string | null
  last_verified_at: number | null
  ttl: number | null
  state: string
  uses: number
  successes: number
  last_used_at: number | null
  created: number
}

function rowToObject(r: Row): KnowledgeObject {
  const parsed = KnowledgeObjectSchema.safeParse({
    id: r.id,
    name: r.name,
    kind: r.kind,
    version: r.version,
    parentId: r.parent_id,
    content: JSON.parse(r.content),
    provenance: {
      source: r.source,
      refs: JSON.parse(r.refs),
      created: r.created,
    },
    evidence: JSON.parse(r.evidence),
    verification: {
      status: r.verification_status,
      check: r.verification_check ? JSON.parse(r.verification_check) : null,
      lastVerifiedAt: r.last_verified_at,
    },
    ttl: r.ttl,
    state: r.state,
    metrics: {
      uses: r.uses,
      successes: r.successes,
      lastUsedAt: r.last_used_at,
    },
  })
  if (!parsed.success) {
    throw new DataCorruptionError(r.id, parsed.error.message)
  }
  return parsed.data
}

export class SqliteSelfStore implements SelfStore {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
    db.run(`
      CREATE TABLE IF NOT EXISTS knowledge (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        version INTEGER NOT NULL,
        parent_id TEXT,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        refs TEXT NOT NULL,
        evidence TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        verification_check TEXT,
        last_verified_at INTEGER,
        ttl INTEGER,
        state TEXT NOT NULL,
        uses INTEGER NOT NULL DEFAULT 0,
        successes INTEGER NOT NULL DEFAULT 0,
        last_used_at INTEGER,
        created INTEGER NOT NULL
      )
    `)
    db.run(`CREATE INDEX IF NOT EXISTS knowledge_name_version ON knowledge(kind, name, version DESC)`)
    // Derivation edges (refs.knowledgeId) stored denormalized for cascade
    // invalidation lookups.
    db.run(`
      CREATE TABLE IF NOT EXISTS knowledge_deps (
        dependent_id TEXT NOT NULL,
        upstream_id TEXT NOT NULL,
        PRIMARY KEY (dependent_id, upstream_id)
      )
    `)
    // Guards the version chain against concurrent writers. On databases with
    // pre-existing duplicate rows this creation fails; that is a corruption
    // signal worth surfacing, not a reason to crash startup.
    try {
      db.run(`CREATE UNIQUE INDEX IF NOT EXISTS knowledge_kind_name_version ON knowledge(kind, name, version)`)
    } catch (e) {
      console.warn(`(knowledge store: could not create unique index: ${e instanceof Error ? e.message : String(e)})`)
    }
  }

  add(name: string, obj: NewKnowledgeObject): KnowledgeObject {
    const id = contentHash({ name, kind: obj.kind, content: obj.content })
    const insert = this.db.transaction((record: KnowledgeObject) => {
      const current = this.get(record.kind, record.name)

      // Idempotent: re-adding identical content is a no-op (git semantics —
      // no empty version bump, no duplicate row).
      if (current && current.id === record.id) return current

      const version = current ? current.version + 1 : 1
      const parentId = current ? current.id : null
      const withVersion = { ...record, version, parentId }

      this.db
        .query(
          `INSERT INTO knowledge (
            id, name, kind, version, parent_id, content, source, refs, evidence,
            verification_status, verification_check, last_verified_at, ttl, state,
            uses, successes, last_used_at, created
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          withVersion.id,
          withVersion.name,
          withVersion.kind,
          withVersion.version,
          withVersion.parentId,
          JSON.stringify(withVersion.content),
          withVersion.provenance.source,
          JSON.stringify(withVersion.provenance.refs),
          JSON.stringify(withVersion.evidence),
          withVersion.verification.status,
          withVersion.verification.check ? JSON.stringify(withVersion.verification.check) : null,
          withVersion.verification.lastVerifiedAt,
          withVersion.ttl,
          withVersion.state,
          withVersion.metrics.uses,
          withVersion.metrics.successes,
          withVersion.metrics.lastUsedAt,
          withVersion.provenance.created,
        )

      // Derivation edges belong to the version that declares them: when a new
      // version supersedes the current one, the old version's edges must not
      // cascade-invalidate content that no longer depends on the upstream.
      if (current) this.db.query("DELETE FROM knowledge_deps WHERE dependent_id = ?").run(current.id)

      for (const ref of record.provenance.refs) {
        if (ref.knowledgeId === undefined) continue
        this.db
          .query("INSERT OR REPLACE INTO knowledge_deps (dependent_id, upstream_id) VALUES (?, ?)")
          .run(withVersion.id, ref.knowledgeId)
      }

      return withVersion
    })

    return insert({ ...obj, id, name, version: 0, parentId: null })
  }

  get(kind: KnowledgeKind, name: string): KnowledgeObject | null {
    const row = this.db
      .query("SELECT * FROM knowledge WHERE kind = ? AND name = ? ORDER BY version DESC LIMIT 1")
      .get(kind, name) as Row | undefined
    return row ? rowToObject(row) : null
  }

  findById(id: string): KnowledgeObject | null {
    const row = this.db.query("SELECT * FROM knowledge WHERE id = ?").get(id) as Row | undefined
    return row ? rowToObject(row) : null
  }

  dependentsOf(upstreamId: string): string[] {
    const rows = this.db
      .query("SELECT dependent_id FROM knowledge_deps WHERE upstream_id = ?")
      .all(upstreamId) as Array<{
      dependent_id: string
    }>
    return rows.map((r) => r.dependent_id)
  }

  history(kind: KnowledgeKind, name: string): KnowledgeObject[] {
    const rows = this.db
      .query("SELECT * FROM knowledge WHERE kind = ? AND name = ? ORDER BY version DESC")
      .all(kind, name) as Row[]
    return rows.map(rowToObject)
  }

  all(): KnowledgeObject[] {
    const rows = this.db.query("SELECT * FROM knowledge ORDER BY kind ASC, name ASC, version DESC").all() as Row[]
    return rows.map(rowToObject)
  }

  latest(): KnowledgeObject[] {
    const rows = this.db
      .query(
        "SELECT * FROM knowledge WHERE version = (SELECT MAX(version) FROM knowledge k2 WHERE k2.kind = knowledge.kind AND k2.name = knowledge.name) ORDER BY kind ASC, name ASC",
      )
      .all() as Row[]
    return rows.map(rowToObject)
  }

  touch(kind: KnowledgeKind, name: string): void {
    this.db
      .query(
        "UPDATE knowledge SET uses = uses + 1, last_used_at = ? WHERE kind = ? AND name = ? AND version = (SELECT MAX(version) FROM knowledge WHERE kind = ? AND name = ?)",
      )
      .run(Date.now(), kind, name, kind, name)
  }

  recordOutcome(kind: KnowledgeKind, name: string, ok: boolean): void {
    const current = this.get(kind, name)
    if (!current) return
    this.db
      .query("UPDATE knowledge SET uses = uses + 1, successes = successes + ?, last_used_at = ? WHERE id = ?")
      .run(ok ? 1 : 0, Date.now(), current.id)
  }

  setVerification(kind: KnowledgeKind, name: string, status: VerificationStatus, lastVerifiedAt: number): void {
    const current = this.get(kind, name)
    if (!current) return
    this.db
      .query("UPDATE knowledge SET verification_status = ?, last_verified_at = ? WHERE id = ?")
      .run(status, lastVerifiedAt, current.id)
  }

  setState(kind: KnowledgeKind, name: string, state: KnowledgeState): void {
    const current = this.get(kind, name)
    if (!current) return
    this.db.query("UPDATE knowledge SET state = ? WHERE id = ?").run(state, current.id)
  }
}
