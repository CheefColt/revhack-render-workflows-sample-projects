/**
 * Launch-pack generator: a Render Workflows template (TypeScript).
 *
 * You give it a link to your product. It reads the page, then writes a launch
 * pack (Reel script, WhatsApp message, X thread, cold email) IN PARALLEL, and
 * finally runs a quick fact-check so nothing claims more than the page says.
 *
 * Why this is a workflow and not one API endpoint:
 *   - It takes 10-60 seconds (page fetch + several model calls). A web request
 *     should not wait that long.
 *   - The four writers are independent, so they run at the same time, each on
 *     its own machine, each with its own retries.
 *   - Model APIs fail sometimes. A failed writer retries by itself without
 *     redoing the page fetch or the other writers.
 *
 * Shape of the run:
 *
 *     generateLaunchPack
 *         |-- fetchPage                      (1 step, retried on network errors)
 *         |-- [ reelScript | whatsappMessage | xThread | coldEmail ]   parallel
 *         '-- reviewPack                     (fact-check against the page)
 *
 * Run locally:   render workflows dev -- npm start
 *
 * Rules of the road for this SDK:
 *   - Define every task at the top level of the file, synchronously. The task
 *     server starts itself once they are registered. Tasks defined later (for
 *     example inside a dynamic import) are not available to run.
 *   - A task that calls ctx.run() must be async.
 */
import { lookup } from 'node:dns/promises'
import net from 'node:net'

import { task, type TaskContext } from '@renderinc/sdk/workflows'

import * as llm from './llm.js'

// Defaults mirror Render's own: 3 retries, 1s first wait, doubling each time.
const DEFAULTS = {
  retry: { maxRetries: 3, waitDurationMs: 1000, backoffScaling: 2 },
  timeoutSeconds: 300,
}

const MAX_PAGE_CHARS = 6000 // keep prompts small and arguments far below the 4 MB limit
const MAX_DOWNLOAD_BYTES = 1_000_000
const MAX_REDIRECTS = 5

export interface Page {
  url: string
  title: string
  text: string
}

export interface Draft {
  channel: string
  content: string
}

// ---------- helpers (plain functions, not tasks) ----------

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** Pull a title and the readable text out of an HTML string (no parser library). */
export function extractText(html: string): { title: string; text: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? decodeEntities(titleMatch[1]).replace(/\s+/g, ' ').trim() : ''
  const body = html
    .replace(/<title[^>]*>[\s\S]*?<\/title>/gi, ' ')
    .replace(/<(script|style|noscript)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
  const text = decodeEntities(body).replace(/\s+/g, ' ').trim()
  return { title, text }
}

function isBlockedIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number)
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) || // shared address space
      (a === 169 && b === 254) || // link-local, includes cloud metadata services
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) || // 192.0.0.0/24 and 192.0.2.0/24
      a >= 224 // multicast and reserved
    )
  }
  if (net.isIPv6(ip)) {
    const x = ip.toLowerCase()
    if (x === '::' || x === '::1') return true
    if (x.startsWith('::ffff:')) {
      const rest = x.slice(7)
      return net.isIPv4(rest) ? isBlockedIp(rest) : true
    }
    return /^f[cd]/.test(x) || /^fe[89ab]/.test(x) || x.startsWith('ff')
  }
  return true // not a valid IP at all: refuse
}

/**
 * Refuse non-http(s) and private/internal addresses.
 *
 * A task runs inside Render's private network. Without this check, a user
 * could submit http://some-internal-service and read it back (SSRF). We also
 * check every redirect hop. This does not defend against DNS rebinding; fine
 * for a template, use an egress proxy if you handle untrusted traffic at scale.
 */
export async function assertPublicUrl(rawUrl: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('URL must start with http:// or https://')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('URL must start with http:// or https://')
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, '')
  let addresses: { address: string }[]
  try {
    addresses = await lookup(host, { all: true })
  } catch {
    throw new Error(`could not resolve host '${host}'`)
  }
  if (addresses.some((a) => isBlockedIp(a.address))) {
    throw new Error('URL points to a private or internal address')
  }
}

async function readCapped(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (total < maxBytes) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    total += value.length
  }
  await reader.cancel().catch(() => {})
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, maxBytes))
}

async function readPage(startUrl: string): Promise<string> {
  let url = startUrl
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertPublicUrl(url)
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'User-Agent': 'revhack-launch-pack/1.0' },
      signal: AbortSignal.timeout(20_000),
    })
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location')
      if (!location) throw new Error('redirect without a Location header')
      url = new URL(location, url).toString()
      continue
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return readCapped(res, MAX_DOWNLOAD_BYTES)
  }
  throw new Error('too many redirects')
}

// ---------- tasks ----------

/** Download a page and return { url, title, text }. Retried on failure. */
export const fetchPage = task(
  { ...DEFAULTS, name: 'fetchPage', timeoutSeconds: 60 },
  async function fetchPage(_ctx: TaskContext, url: string): Promise<Page> {
    const html = await readPage(url)
    const { title, text } = extractText(html)
    if (!text) throw new Error('page had no readable text (is it rendered by JavaScript?)')
    return { url, title: title || url, text: text.slice(0, MAX_PAGE_CHARS) }
  },
)

const brief = (page: Page): string =>
  `Product page title: ${page.title}\nURL: ${page.url}\nPage text:\n${page.text}`

const RULES =
  'Only use facts that appear in the page text. Never invent features, ' +
  'prices, numbers or testimonials. Audience: college students in India. ' +
  'Tone: genuine, simple, no hype words. Keep it short.'

export const reelScript = task(
  { ...DEFAULTS, name: 'reelScript' },
  async function reelScript(_ctx: TaskContext, page: Page): Promise<Draft> {
    const content = await llm.complete(
      `You write short-form video scripts. ${RULES}`,
      'Write a 20-second Instagram Reel script (hook, 2-3 beats, call to action, ' +
        `with on-screen text lines) for this product.\n\n${brief(page)}`,
    )
    return { channel: 'reel_script', content }
  },
)

export const whatsappMessage = task(
  { ...DEFAULTS, name: 'whatsappMessage' },
  async function whatsappMessage(_ctx: TaskContext, page: Page): Promise<Draft> {
    const content = await llm.complete(
      `You write WhatsApp messages people actually tap. ${RULES}`,
      `Write a forwardable WhatsApp message (max 4 lines) ending with the link ${page.url}.\n\n${brief(page)}`,
    )
    return { channel: 'whatsapp_message', content }
  },
)

export const xThread = task(
  { ...DEFAULTS, name: 'xThread' },
  async function xThread(_ctx: TaskContext, page: Page): Promise<Draft> {
    const content = await llm.complete(
      `You write build-in-public threads. ${RULES}`,
      'Write a 4-post X thread: the problem, what was built, who it is for, ' +
        `link ${page.url}. Number each post.\n\n${brief(page)}`,
    )
    return { channel: 'x_thread', content }
  },
)

export const coldEmail = task(
  { ...DEFAULTS, name: 'coldEmail' },
  async function coldEmail(_ctx: TaskContext, page: Page): Promise<Draft> {
    const content = await llm.complete(
      `You write cold emails that get replies. ${RULES}`,
      'Write a cold email (subject line + under 90 words) asking a student club ' +
        `lead to try this and share feedback.\n\n${brief(page)}`,
    )
    return { channel: 'cold_email', content }
  },
)

/** Fact-check: flag anything the drafts claim that the page does not say. */
export const reviewPack = task(
  { ...DEFAULTS, name: 'reviewPack' },
  async function reviewPack(
    _ctx: TaskContext,
    page: Page,
    pack: Draft[],
  ): Promise<{ verdict: string; clean: boolean }> {
    const drafts = pack.map((p) => `## ${p.channel}\n${p.content}`).join('\n\n')
    const verdict = await llm.complete(
      'You are a strict fact-checker.',
      'List every claim in the drafts that is NOT supported by the page text, ' +
        'one per line. If all claims are supported reply exactly: No unsupported ' +
        `claims.\n\n${brief(page)}\n\nDRAFTS:\n${drafts}`,
      400,
    )
    return { verdict, clean: verdict.trim().toLowerCase().startsWith('no unsupported') }
  },
)

// ---------- the orchestrator (the task you trigger) ----------

export const WRITERS = [
  { channel: 'reel_script', task: reelScript },
  { channel: 'whatsapp_message', task: whatsappMessage },
  { channel: 'x_thread', task: xThread },
  { channel: 'cold_email', task: coldEmail },
]

export interface LaunchPackResult {
  source: { url: string; title: string }
  pack: Draft[]
  failed: { channel: string; error: string }[]
  review: { verdict: string; clean: boolean }
}

/**
 * Trigger this one: generateLaunchPack(url) -> full pack + fact-check.
 *
 * Functions that call ctx.run() must be async so they can await results.
 */
export const generateLaunchPack = task(
  { ...DEFAULTS, name: 'generateLaunchPack', timeoutSeconds: 600 },
  async function generateLaunchPack(ctx: TaskContext, url: string): Promise<LaunchPackResult> {
    const page = await ctx.run(fetchPage, url)

    // Fan out: all four writers at once. allSettled means one failed writer
    // (after its own retries) does not throw away the other three.
    const results = await Promise.allSettled(WRITERS.map((w) => ctx.run(w.task, page)))

    const pack: Draft[] = []
    const failed: { channel: string; error: string }[] = []
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') {
        pack.push(r.value)
      } else {
        const reason = r.reason instanceof Error ? r.reason.message : String(r.reason)
        failed.push({ channel: WRITERS[i].channel, error: reason.slice(0, 200) })
      }
    })

    if (pack.length === 0) {
      throw new Error(`all writers failed: ${JSON.stringify(failed)}`)
    }

    const review = await ctx.run(reviewPack, page, pack)
    return { source: { url: page.url, title: page.title }, pack, failed, review }
  },
)
