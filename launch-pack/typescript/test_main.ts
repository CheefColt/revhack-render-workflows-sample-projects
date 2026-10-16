/**
 * Offline tests: no network, no Render, no API key, no cost.
 *
 * Render's SDK lets you test a task by calling its `.func` with a stand-in
 * context. FakeCtx runs "chained" tasks in-process so we can test the whole
 * orchestrator the same way.
 *
 * Run:  npm test
 */
import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

import type { TaskContext, TaskDefinition } from '@renderinc/sdk/workflows'

process.env.LLM_PROVIDER = 'mock' // never call a real model in tests

import * as llm from './llm.js'
import * as main from './main.js'

const PAGE: main.Page = { url: 'https://example.com', title: 'Example', text: 'A tool for students.' }

/** Stand-in for TaskContext: ctx.run(task, ...args) runs the task directly. */
class FakeCtx implements TaskContext {
  readonly metadata = {}
  calls: string[] = []
  constructor(private fail: Set<string> = new Set()) {}

  async run<A extends unknown[], R>(t: TaskDefinition<A, R>, ...args: A): Promise<R> {
    this.calls.push(t.name)
    if (this.fail.has(t.name)) throw new Error(`${t.name} exploded`)
    return await t.func(this, ...args)
  }
}

/** A public IP literal, so the URL check needs no DNS lookup. */
const PAGE_URL = 'http://93.184.216.34/'

/**
 * Fake the network underneath fetchPage (a task's `func` itself is read-only in
 * this SDK, so we stub the layer below it). Returns a restore function.
 */
function stubNetwork(): () => void {
  const m = mock.method(
    globalThis,
    'fetch',
    async () => new Response('<title>Example</title><p>A tool for students.</p>', { status: 200 }),
  )
  return () => m.mock.restore()
}

test('writers return channel and content', async () => {
  for (const w of main.WRITERS) {
    const out = await w.task.func(new FakeCtx(), PAGE)
    assert.equal(out.channel, w.channel)
    assert.ok(out.content)
  }
})

test('orchestrator runs all steps in order', async () => {
  const restore = stubNetwork()
  try {
    const ctx = new FakeCtx()
    const result = await main.generateLaunchPack.func(ctx, PAGE_URL)
    assert.equal(ctx.calls[0], 'fetchPage')
    assert.equal(ctx.calls[ctx.calls.length - 1], 'reviewPack')
    assert.deepEqual(
      new Set(result.pack.map((p) => p.channel)),
      new Set(main.WRITERS.map((w) => w.channel)),
    )
    assert.deepEqual(result.failed, [])
  } finally {
    restore()
  }
})

test('one failed writer does not lose the others', async () => {
  const restore = stubNetwork()
  try {
    const ctx = new FakeCtx(new Set(['xThread']))
    const result = await main.generateLaunchPack.func(ctx, PAGE_URL)
    assert.deepEqual(result.failed.map((f) => f.channel), ['x_thread'])
    assert.equal(result.pack.length, 3)
  } finally {
    restore()
  }
})

test('all writers failing fails the run', async () => {
  const restore = stubNetwork()
  try {
    const ctx = new FakeCtx(new Set(main.WRITERS.map((w) => w.task.name)))
    await assert.rejects(async () => main.generateLaunchPack.func(ctx, PAGE_URL), /all writers failed/)
  } finally {
    restore()
  }
})

for (const url of [
  'ftp://example.com',
  'http://127.0.0.1/admin',
  'http://localhost:8080',
  'http://10.0.0.5',
  'http://[::1]/',
  'http://169.254.169.254/latest/meta-data',
]) {
  test(`private or non-http URL is refused: ${url}`, async () => {
    await assert.rejects(main.assertPublicUrl(url))
  })
}

test('a public IP literal is allowed (no DNS needed)', async () => {
  await assert.doesNotReject(main.assertPublicUrl('http://93.184.216.34/'))
})

test('a redirect to a private address is refused', async () => {
  const m = mock.method(globalThis, 'fetch', async () =>
    new Response(null, { status: 302, headers: { location: 'http://10.0.0.1/admin' } }),
  )
  try {
    await assert.rejects(
      async () => main.fetchPage.func(new FakeCtx(), PAGE_URL),
      /private or internal/,
    )
  } finally {
    m.mock.restore()
  }
})

test('mock provider is the default without keys', () => {
  const saved = { ...process.env }
  delete process.env.LLM_PROVIDER
  delete process.env.GEMINI_API_KEY
  delete process.env.GOOGLE_API_KEY
  delete process.env.ANTHROPIC_API_KEY
  delete process.env.OPENAI_API_KEY
  try {
    assert.equal(llm.provider(), 'mock')
  } finally {
    process.env.LLM_PROVIDER = saved.LLM_PROVIDER
  }
})

test('gemini request shape and parsing', async () => {
  process.env.LLM_PROVIDER = 'gemini'
  process.env.GEMINI_API_KEY = 'test-key'
  let seen: { url: string; init: RequestInit } | undefined
  const m = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    seen = { url, init }
    return new Response(
      JSON.stringify({
        candidates: [{ content: { parts: [{ text: ' hello from gemini ' }] } }],
      }),
      { status: 200 },
    )
  })
  try {
    assert.equal(await llm.complete('sys', 'user prompt'), 'hello from gemini')
    assert.equal(
      seen?.url,
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent',
    )
    const headers = seen?.init.headers as Record<string, string>
    assert.equal(headers['x-goog-api-key'], 'test-key')
    const body = JSON.parse(String(seen?.init.body))
    assert.equal(body.contents[0].parts[0].text, 'user prompt')
    assert.equal(body.systemInstruction.parts[0].text, 'sys')
  } finally {
    m.mock.restore()
    delete process.env.GEMINI_API_KEY
    process.env.LLM_PROVIDER = 'mock'
  }
})

test('html extraction skips scripts and reads the title', () => {
  const { title, text } = main.extractText(
    '<html><head><title>Hi</title><script>var x=1;</script></head>' +
      '<body><h1>Build</h1><style>p{}</style><p>Ship it</p></body></html>',
  )
  assert.equal(title, 'Hi')
  assert.equal(text, 'Build Ship it')
})

test('anthropic request shape and parsing', async () => {
  process.env.LLM_PROVIDER = 'anthropic'
  process.env.ANTHROPIC_API_KEY = 'sk-test'
  let seen: { url: string; init: RequestInit } | undefined
  const m = mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    seen = { url, init }
    return new Response(JSON.stringify({ content: [{ type: 'text', text: ' hello ' }] }), { status: 200 })
  })
  try {
    assert.equal(await llm.complete('sys', 'user prompt'), 'hello')
    assert.equal(seen?.url, 'https://api.anthropic.com/v1/messages')
    const headers = seen?.init.headers as Record<string, string>
    assert.equal(headers['x-api-key'], 'sk-test')
    const body = JSON.parse(String(seen?.init.body))
    assert.equal(body.messages[0].content, 'user prompt')
    assert.equal(body.system, 'sys')
  } finally {
    m.mock.restore()
    delete process.env.ANTHROPIC_API_KEY
    process.env.LLM_PROVIDER = 'mock'
  }
})

test('openai request shape and parsing', async () => {
  process.env.LLM_PROVIDER = 'openai'
  process.env.OPENAI_API_KEY = 'sk-test'
  const m = mock.method(globalThis, 'fetch', async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: ' yo ' } }] }), { status: 200 }),
  )
  try {
    assert.equal(await llm.complete('sys', 'p'), 'yo')
  } finally {
    m.mock.restore()
    delete process.env.OPENAI_API_KEY
    process.env.LLM_PROVIDER = 'mock'
  }
})

test('a real provider without its key gives a clear error', async () => {
  process.env.LLM_PROVIDER = 'anthropic'
  delete process.env.ANTHROPIC_API_KEY
  try {
    await assert.rejects(llm.complete('s', 'p'), /ANTHROPIC_API_KEY is not set/)
  } finally {
    process.env.LLM_PROVIDER = 'mock'
  }
})
