/**
 * Tiny, dependency-free LLM helper (uses the `fetch` built into Node 18+).
 *
 * Picks a provider automatically:
 *   1. LLM_PROVIDER=gemini | anthropic | openai | mock   (explicit choice), else
 *   2. GEMINI_API_KEY present     -> Gemini
 *   3. ANTHROPIC_API_KEY present  -> Anthropic
 *   4. OPENAI_API_KEY present     -> OpenAI
 *   5. otherwise                  -> mock (deterministic, works offline, free)
 *
 * Why a mock? So the template runs on day one with zero keys, and so tests
 * never spend money. Set a real key and the same code uses a real model.
 *
 * Errors are thrown (not swallowed) on purpose: Render retries a failed task
 * automatically, so a flaky 429/5xx from the model API heals itself.
 */

export type Provider = 'gemini' | 'anthropic' | 'openai' | 'mock'

const DEFAULT_MODELS: Record<string, string> = {
  gemini: 'gemini-3.8-flash',
  anthropic: 'claude-haiku-5-5',
  openai: 'gpt-4o-mini',
}

/** Thrown when the model API fails. Render will retry the task. */
export class LLMError extends Error {}

export function provider(): Provider {
  const explicit = (process.env.LLM_PROVIDER ?? '').trim().toLowerCase()
  if (explicit === 'gemini' || explicit === 'anthropic' || explicit === 'openai' || explicit === 'mock') {
    return explicit
  }
  if (process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY) return 'gemini'
  if (process.env.ANTHROPIC_API_KEY) return 'anthropic'
  if (process.env.OPENAI_API_KEY) return 'openai'
  return 'mock'
}

function requireKey(name: string): string {
  let key = process.env[name]
  if (!key && name === 'GEMINI_API_KEY') {
    key = process.env.GOOGLE_API_KEY
  }
  if (!key) throw new LLMError(`${name} is not set`)
  return key
}

async function post(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = 60_000,
): Promise<any> {
  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    })
  } catch (e) {
    throw new LLMError(`could not reach model API: ${(e as Error).message}`)
  }
  if (!res.ok) {
    const detail = (await res.text()).slice(0, 300)
    throw new LLMError(`model API returned HTTP ${res.status}: ${detail}`)
  }
  return res.json()
}

/** Return the model's text reply for one system + user prompt. */
export async function complete(system: string, prompt: string, maxTokens = 700): Promise<string> {
  const p = provider()
  const model = process.env.LLM_MODEL || DEFAULT_MODELS[p] || 'mock'

  if (p === 'gemini') {
    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }
    if (system) {
      body.systemInstruction = { parts: [{ text: system }] }
    }
    const data = await post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      { 'x-goog-api-key': requireKey('GEMINI_API_KEY') },
      body,
    )
    const candidates = data.candidates ?? []
    if (!candidates.length) {
      throw new LLMError(`gemini returned no candidates: ${JSON.stringify(data)}`)
    }
    return (candidates[0].content?.parts ?? [])
      .map((b: { text?: string }) => b.text ?? '')
      .join('')
      .trim()
  }

  if (p === 'anthropic') {
    const data = await post(
      'https://api.anthropic.com/v1/messages',
      { 'x-api-key': requireKey('ANTHROPIC_API_KEY'), 'anthropic-version': '2023-06-01' },
      {
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }],
      },
    )
    return (data.content ?? [])
      .filter((b: { type: string }) => b.type === 'text')
      .map((b: { text?: string }) => b.text ?? '')
      .join('')
      .trim()
  }

  if (p === 'openai') {
    const data = await post(
      'https://api.openai.com/v1/chat/completions',
      { authorization: `Bearer ${requireKey('OPENAI_API_KEY')}` },
      {
        model,
        max_tokens: maxTokens,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      },
    )
    return String(data.choices[0].message.content).trim()
  }

  // mock: deterministic placeholder so everything runs offline
  const trimmed = prompt.trim()
  const first = trimmed ? trimmed.split('\n')[0].slice(0, 80) : ''
  return `[mock reply] ${system.split('.')[0].slice(0, 60)} :: ${first}`
}
