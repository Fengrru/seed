import type { SelfStore } from "../store/self.js"

export interface InvalidationResult {
  staled: string[]
}

// Marks the given knowledge entries stale, then walks the derivation edges
// (refs.knowledgeId) to stale everything that was derived from them. Stale
// entries are no longer injectable; a skill can revive itself by passing its
// verification command again.
export function invalidateKnowledge(self: SelfStore, rootIds: string[]): InvalidationResult {
  const staled: string[] = []
  const visited = new Set<string>()
  const queue = [...rootIds]

  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined || visited.has(id)) continue
    visited.add(id)

    const obj = self.findById(id)
    if (!obj || obj.state === "archived") continue
    self.setState(obj.kind, obj.name, "stale")
    self.setVerification(obj.kind, obj.name, "stale", Date.now())
    staled.push(id)

    for (const dep of self.dependentsOf(id)) queue.push(dep)
  }

  return { staled }
}
