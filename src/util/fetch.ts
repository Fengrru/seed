export async function fetchWithTimeout(
  input: string | URL | Request,
  init: RequestInit = {},
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    return await fetch(input, { ...init, signal: controller.signal })
  } catch (e) {
    if (controller.signal.aborted) {
      const target = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      throw new Error(`request timed out after ${timeoutMs}ms: ${target}`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
}
