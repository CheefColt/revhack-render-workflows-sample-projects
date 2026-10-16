/**
 * Offline tests: no external network, no Render account, zero cost.
 *
 * Run:  npm test
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import type { TaskContext, TaskDefinition } from '@renderinc/sdk/workflows'

import { diagnoseFailure, type Diagnosis } from './diagnose.js'
import * as main from './main.js'
import { evaluateSecurity, type SiteProbeResult, TransientProbeError } from './probe.js'
import { generateHealthReport } from './reporter.js'

const SAMPLES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'sample')
const SAMPLE_URLS: string[] = JSON.parse(
  readFileSync(path.join(SAMPLES, 'sites.json'), 'utf-8'),
)

/** Stand-in for TaskContext that tracks execution and mimics Render retries */
class FakeCtx implements TaskContext {
  readonly metadata = {}
  maxParallel = 0
  callCount = new Map<string, number>()
  handlers = new Map<string, Function>()
  private active = 0

  async run<A extends unknown[], R>(t: TaskDefinition<A, R>, ...args: A): Promise<R> {
    const taskName = t.name
    this.callCount.set(taskName, (this.callCount.get(taskName) ?? 0) + 1)
    this.active++
    this.maxParallel = Math.max(this.maxParallel, this.active)

    try {
      await new Promise((resolve) => setImmediate(resolve))
      const customHandler = this.handlers.get(taskName)
      let lastError: unknown
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          if (customHandler) {
            return await customHandler(...args)
          }
          return await t.func(this, ...args)
        } catch (err) {
          lastError = err
        }
      }
      throw lastError
    } finally {
      this.active--
    }
  }
}

// ---------------------------------------------------------------------------
// 1. URL Validation & Cleaning
// ---------------------------------------------------------------------------

test('cleanUrls validates, deduplicates, and strips whitespace', () => {
  const input = [
    '  https://example.com  ',
    'https://example.com',
    'https://render.com',
    '   ',
    123 as any,
  ]
  const cleaned = main.cleanUrls(input)
  assert.deepEqual(cleaned, ['https://example.com', 'https://render.com'])
})

test('cleanUrls throws on empty or invalid inputs', () => {
  assert.throws(() => main.cleanUrls([]), /must be a non-empty array/)
  assert.throws(() => main.cleanUrls(null as any), /must be a non-empty array/)
  assert.throws(() => main.cleanUrls(['   ']), /no valid URL strings found/)
})

test('cleanUrls enforces MAX_SITES limit', () => {
  const tooMany = Array.from({ length: main.MAX_SITES + 1 }, (_, i) => `https://site${i}.example`)
  assert.throws(() => main.cleanUrls(tooMany), /too many URLs/)
})

// ---------------------------------------------------------------------------
// 2. Security Headers Scorecard
// ---------------------------------------------------------------------------

test('evaluateSecurity awards Grade A for all 4 defense-in-depth headers on HTTPS', () => {
  const headers = new Headers({
    'strict-transport-security': 'max-age=63072000; includeSubDomains; preload',
    'content-security-policy': "default-src 'self'",
    'x-frame-options': 'DENY',
    'x-content-type-options': 'nosniff',
  })
  const res = evaluateSecurity(headers, true)
  assert.equal(res.grade, 'A')
  assert.equal(res.hasHsts, true)
  assert.equal(res.hasCsp, true)
  assert.equal(res.hasXFrameOptions, true)
  assert.equal(res.hasXContentTypeOptions, true)
  assert.equal(res.missingHeaders.length, 0)
})

test('evaluateSecurity flags missing headers and gives Grade F for plain HTTP', () => {
  const headers = new Headers({
    'x-frame-options': 'SAMEORIGIN',
  })
  // Plain HTTP is always capped at Grade F
  const resHttp = evaluateSecurity(headers, false)
  assert.equal(resHttp.grade, 'F')

  // On HTTPS with only 1 header, grade is D
  const resHttps = evaluateSecurity(headers, true)
  assert.equal(resHttps.grade, 'D')
  assert.ok(resHttps.missingHeaders.includes('Strict-Transport-Security'))
  assert.ok(resHttps.missingHeaders.includes('Content-Security-Policy'))
  assert.ok(resHttps.missingHeaders.includes('X-Content-Type-Options: nosniff'))
})

// ---------------------------------------------------------------------------
// 3. Statistical Reporter & Fan-In Synthesis
// ---------------------------------------------------------------------------

test('generateHealthReport computes accurate percentiles, SLA, and markdown', () => {
  const mockProbes: SiteProbeResult[] = [
    {
      url: 'https://site1.example',
      status: 'UP',
      latencyMs: 100,
      httpCode: 200,
      redirectHops: 0,
      finalUrl: 'https://site1.example',
      security: {
        grade: 'A',
        hasHsts: true,
        hasCsp: true,
        hasXFrameOptions: true,
        hasXContentTypeOptions: true,
        missingHeaders: [],
      },
    },
    {
      url: 'https://site2.example',
      status: 'SLOW',
      latencyMs: 1200,
      httpCode: 200,
      redirectHops: 0,
      finalUrl: 'https://site2.example',
    },
    {
      url: 'https://site3.example',
      status: 'DOWN',
      latencyMs: 0,
      redirectHops: 0,
      finalUrl: 'https://site3.example',
      error: 'Connection timed out',
    },
    {
      url: 'https://site4.example',
      status: 'BAD',
      latencyMs: 150,
      httpCode: 404,
      redirectHops: 0,
      finalUrl: 'https://site4.example',
      error: 'HTTP 404 Not Found',
    },
  ]

  const mockDiagnoses: Diagnosis[] = [
    {
      url: 'https://site3.example',
      hostname: 'site3.example',
      stageFailed: 'tcp',
      rootCause: 'TCP_CONNECTION_TIMEOUT',
      details: 'Connection timed out after 3.5s',
      actionableFix: 'Check firewall ingress rules on port 443',
    },
  ]

  const report = generateHealthReport(mockProbes, mockDiagnoses)

  assert.equal(report.total, 4)
  assert.equal(report.up, 1)
  assert.equal(report.slow, 1)
  assert.equal(report.down, 1)
  assert.equal(report.bad, 1)
  assert.equal(report.uptimePercentage, 50.0) // 2 out of 4 healthy

  // Latency metrics check (100, 150, 1200)
  assert.equal(report.latency.minMs, 100)
  assert.equal(report.latency.medianMs, 150)
  assert.equal(report.latency.maxMs, 1200)

  // Incident triage check
  assert.equal(report.incidents.length, 2)
  const site3Incident = report.incidents.find((i) => i.url === 'https://site3.example')
  assert.ok(site3Incident)
  assert.equal(site3Incident?.stageFailed, 'tcp')
  assert.equal(site3Incident?.rootCause, 'TCP_CONNECTION_TIMEOUT')

  // Markdown validation
  assert.ok(report.summaryMarkdown.includes('Fleet Status Overview'))
  assert.ok(report.summaryMarkdown.includes('Active Incidents & Root-Cause Triage'))
  assert.ok(report.summaryMarkdown.includes('TCP_CONNECTION_TIMEOUT'))
})

// ---------------------------------------------------------------------------
// 4. End-to-End Orchestrator Workflow with FakeCtx
// ---------------------------------------------------------------------------

test('checkSites orchestrator coordinates fan-out, conditional triage, and fan-in', async () => {
  const ctx = new FakeCtx()

  const testUrls = [
    'https://healthy.example',
    'https://slow.example',
    'https://broken.example',
  ]

  let diagCalledFor = ''

  ctx.handlers.set('probeSite', async (url: string) => {
    if (url.includes('healthy')) {
      return {
        url,
        status: 'UP',
        latencyMs: 120,
        httpCode: 200,
        redirectHops: 0,
        finalUrl: url,
      } as SiteProbeResult
    }
    if (url.includes('slow')) {
      return {
        url,
        status: 'SLOW',
        latencyMs: 1800,
        httpCode: 200,
        redirectHops: 0,
        finalUrl: url,
      } as SiteProbeResult
    }
    return {
      url,
      status: 'DOWN',
      latencyMs: 0,
      redirectHops: 0,
      finalUrl: url,
      error: 'getaddrinfo ENOTFOUND broken.example',
    } as SiteProbeResult
  })

  ctx.handlers.set('diagnoseFailure', async (url: string, err?: string) => {
    diagCalledFor = url
    return {
      url,
      hostname: 'broken.example',
      stageFailed: 'dns',
      rootCause: 'DNS_RESOLUTION_FAILED',
      details: err || 'ENOTFOUND',
      actionableFix: 'Configure DNS A records',
    } as Diagnosis
  })

  const report = await main.checkSites.func(ctx, testUrls)

  assert.equal(report.total, 3)
  assert.equal(report.up, 1)
  assert.equal(report.slow, 1)
  assert.equal(report.down, 1)

  // Bounded parallelism checked
  assert.ok(ctx.maxParallel <= main.BATCH_SIZE)

  // Conditional fan-out verification: diagnose was ONLY called for the broken URL!
  assert.equal(diagCalledFor, 'https://broken.example')
  assert.equal(ctx.callCount.get('diagnoseFailure'), 1)

  // Fan-in synthesis verified
  assert.equal(ctx.callCount.get('generateReport'), 1)
  assert.ok(report.summaryMarkdown.includes('DNS_RESOLUTION_FAILED'))
})
