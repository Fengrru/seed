import type { Database } from "bun:sqlite"
import { type Event, EventSchema } from "../schema/event.js"
import { contentHash } from "../schema/knowledge.js"

export interface EvidenceCheck {
  ok: boolean
  invalid: string[]
}

export interface Log {
  append(event: Event): void
  replay(): Event[]
  replaySince(ts: number): Event[]
  replaySession(sessionId: string): Event[]
  // The most recent events in ascending order, bounded for statistics that
  // must stay cheap as the log grows (guidance, meta-cognition).
  replayRecent(maxEvents: number): Event[]
  // Retention: everything strictly older than ts, for archiving, and the
  // matching deletion. Pruning breaks evidence citations into the pruned
  // range (they fail verification from then on).
  eventsBefore(ts: number): Event[]
  pruneBefore(ts: number): number
  // Content-addressed evidence: every appended event is stored with the hash
  // of its canonical JSON. Knowledge cites events by id; this verifies that
  // each cited event still exists and has not been tampered with.
  verifyEvidence(ids: string[]): EvidenceCheck
}

// Filters evidence ids down to the ones that verify, so a write never records
// citations that point nowhere (or at altered history).
export function validEvidenceIds(log: Log, ids: string[]): string[] {
  if (ids.length === 0) return []
  const { invalid } = log.verifyEvidence(ids)
  return ids.filter((id) => !invalid.includes(id))
}

export class SqliteLog implements Log {
  private readonly db: Database

  constructor(db: Database) {
    this.db = db
    db.run(`
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        ts INTEGER NOT NULL,
        type TEXT NOT NULL,
        session_id TEXT NOT NULL,
        data TEXT NOT NULL,
        content_hash TEXT
      )
    `)
    // Pre-existing databases lack the column; ALTER is a no-op failure on
    // fresh ones. Rows without a hash stay verifiable-by-missing (legacy).
    try {
      db.run(`ALTER TABLE events ADD COLUMN content_hash TEXT`)
    } catch {
      // column already exists
    }
    db.run(`CREATE INDEX IF NOT EXISTS events_ts ON events(ts)`)
    db.run(`CREATE INDEX IF NOT EXISTS events_session ON events(session_id, ts)`)
    db.run(`CREATE INDEX IF NOT EXISTS events_hash ON events(content_hash)`)
  }

  append(event: Event): void {
    this.db
      .query("INSERT INTO events (id, ts, type, session_id, data, content_hash) VALUES (?, ?, ?, ?, ?, ?)")
      .run(event.id, event.ts, event.type, event.sessionId, JSON.stringify(event), contentHash(event))
  }

  replay(): Event[] {
    return this.replaySince(0)
  }

  replaySince(ts: number): Event[] {
    const rows = this.db.query("SELECT data FROM events WHERE ts > ? ORDER BY ts ASC, rowid ASC").all(ts) as Array<{
      data: string
    }>
    return this.parseRows(rows)
  }

  replaySession(sessionId: string): Event[] {
    const rows = this.db
      .query("SELECT data FROM events WHERE session_id = ? ORDER BY ts ASC, rowid ASC")
      .all(sessionId) as Array<{ data: string }>
    return this.parseRows(rows)
  }

  replayRecent(maxEvents: number): Event[] {
    const rows = this.db.query("SELECT data FROM events ORDER BY ts DESC, rowid DESC LIMIT ?").all(maxEvents) as Array<{
      data: string
    }>
    rows.reverse()
    return this.parseRows(rows)
  }

  eventsBefore(ts: number): Event[] {
    const rows = this.db.query("SELECT data FROM events WHERE ts < ? ORDER BY ts ASC, rowid ASC").all(ts) as Array<{
      data: string
    }>
    return this.parseRows(rows)
  }

  pruneBefore(ts: number): number {
    const result = this.db.query("DELETE FROM events WHERE ts < ?").run(ts) as unknown as { changes: number }
    return result.changes
  }

  verifyEvidence(ids: string[]): EvidenceCheck {
    const invalid: string[] = []
    for (const id of new Set(ids)) {
      const row = this.db.query("SELECT data, content_hash FROM events WHERE id = ?").get(id) as
        | { data: string; content_hash: string | null }
        | undefined
      if (!row) {
        invalid.push(id)
        continue
      }
      try {
        if (row.content_hash === null || contentHash(JSON.parse(row.data)) !== row.content_hash) {
          invalid.push(id)
        }
      } catch {
        invalid.push(id)
      }
    }
    return { ok: invalid.length === 0, invalid }
  }

  // Corrupt rows must not silently masquerade as typed events; skip them so
  // history reconstruction survives, but say so.
  private parseRows(rows: Array<{ data: string }>): Event[] {
    const events: Event[] = []
    let skipped = 0
    for (const row of rows) {
      try {
        const parsed = EventSchema.safeParse(JSON.parse(row.data))
        if (parsed.success) events.push(parsed.data)
        else skipped += 1
      } catch {
        skipped += 1
      }
    }
    if (skipped > 0) console.warn(`(event log: skipped ${skipped} unparseable row(s))`)
    return events
  }
}
