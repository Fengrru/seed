export function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fff]+/)
    .filter((t) => t.length > 0)
}

type Vector = Map<string, number>

export class TfidfVectorizer {
  private readonly idf: Map<string, number>

  constructor(docs: string[]) {
    const n = docs.length
    const df = new Map<string, number>()
    for (const doc of docs) {
      const seen = new Set(tokenize(doc))
      for (const term of seen) df.set(term, (df.get(term) ?? 0) + 1)
    }
    this.idf = new Map()
    for (const [term, count] of df) {
      this.idf.set(term, Math.log((n + 1) / (count + 1)) + 1)
    }
  }

  vectorize(text: string): Vector {
    const tf = new Map<string, number>()
    for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1)
    const vec = new Map<string, number>()
    for (const [t, count] of tf) {
      const idf = this.idf.get(t)
      if (idf !== undefined) vec.set(t, count * idf)
    }
    return vec
  }
}

export function cosine(a: Vector, b: Vector): number {
  let dot = 0
  let na = 0
  let nb = 0
  for (const [t, w] of a) {
    na += w * w
    const bw = b.get(t)
    if (bw !== undefined) dot += w * bw
  }
  for (const [, w] of b) nb += w * w
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

export function cosineDense(a: number[], b: number[]): number {
  // A dimension mismatch means the provider changed under an un-migrated
  // corpus; the dot product would be silently asymmetric, so fail closed.
  if (a.length !== b.length) return 0
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    const av = a[i] ?? 0
    const bv = b[i] ?? 0
    dot += av * bv
    na += av * av
    nb += bv * bv
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}
