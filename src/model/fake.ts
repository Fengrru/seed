import type { DecideInput, HarvestOutput, Model, Step } from "./model.js"

// A scripted model for deterministic tests. Each entry is one decide call: a
// plain Step means "return exactly this step", an array means "return this
// batch of steps at once" (multi-tool-call responses). The last entry repeats
// once the script is exhausted.
export function createFakeModel(steps: Array<Step | Step[]>, harvestOutput?: HarvestOutput): Model {
  let i = 0
  return {
    async decide(_input: DecideInput): Promise<Step[]> {
      const scripted = steps[i]
      i = Math.min(i + 1, steps.length - 1)
      if (scripted === undefined) return [{ type: "done", answer: "done" }]
      return Array.isArray(scripted) ? scripted : [scripted]
    },
    async harvest(_transcript: string): Promise<HarvestOutput> {
      return harvestOutput ?? { memories: [], skills: [] }
    },
  }
}
