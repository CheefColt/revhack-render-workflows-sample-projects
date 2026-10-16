/**
 * Site Reliability & Health Suite: a Render Workflows template (TypeScript).
 *
 * A list of URLs in -> checks them in parallel -> conditional deep triage for failures
 * -> executive statistical summary & markdown incident report.
 *
 * Zero setup: needs no API keys, no domain verification, no third-party accounts.
 *
 * Why this is a workflow and not one API endpoint:
 *   - 50 URLs checked sequentially would block an API request for 30-60+ seconds.
 *   - Each site is independent, so they are probed side-by-side in parallel.
 *   - Real sites answer at different speeds; some time out or drop packets.
 *   - Render retries transient failures (timeouts, 5xx) with exponential backoff,
 *     while deterministic outcomes (404, bad URL) complete immediately without wasting runs.
 *   - One dead or hanging site does not stop the other 49.
 *   - Failing sites conditionally trigger a deep diagnostic triage (DNS, TCP, TLS).
 *   - A final fan-in judge synthesizes SLA %, p95 latency, security grades, and active incidents.
 *
 * Shape of the run:
 *
 *     checkSites (Orchestrator)
 *         |-- [ probeSite x N ] in bounded parallel batches
 *         |-- [ diagnoseFailure x M ] conditionally for failing sites only
 *         '-- generateReport (Fan-in judge synthesizing metrics & markdown)
 *
 * Run locally:   render workflows dev -- npm start
 */
import { task, type TaskContext } from '@renderinc/sdk/workflows'

import { diagnoseFailure, type Diagnosis } from './diagnose.js'
import {
  probe,
  type HealthStatus,
  type SiteProbeResult,
  TransientProbeError,
} from './probe.js'
import { generateHealthReport, type HealthReport } from './reporter.js'

export const MAX_SITES = 200 // keeps run reviewable and under memory limits
export const BATCH_SIZE = 10 // bounded parallelism to avoid socket exhaustion

// Render Workflows standard defaults: 3 retries, 1s first wait, doubling each time
const DEFAULTS = {
  retry: { maxRetries: 3, waitDurationMs: 1000, backoffScaling: 2 },
  timeoutSeconds: 120,
}

export interface HealthCheckConfig {
  timeoutMs?: number
  slowThresholdMs?: number
}

/** Sanitize, deduplicate, and validate input URLs */
export function cleanUrls(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('urls must be a non-empty array of URL strings')
  }
  if (raw.length > MAX_SITES) {
    throw new Error(`too many URLs (${raw.length}); max is ${MAX_SITES} per run`)
  }

  const seen = new Set<string>()
  const cleaned: string[] = []

  for (const item of raw) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (!trimmed) continue
    if (!seen.has(trimmed)) {
      seen.add(trimmed)
      cleaned.push(trimmed)
    }
  }

  if (cleaned.length === 0) {
    throw new Error('no valid URL strings found in input')
  }

  return cleaned
}

/** Worker Task: Probe one URL (HTTP, latency, SSL validity, security headers) */
export const probeSite = task(
  { ...DEFAULTS, name: 'probeSite', timeoutSeconds: 30 },
  async function probeSite(
    _ctx: TaskContext,
    url: string,
    config?: HealthCheckConfig,
  ): Promise<SiteProbeResult> {
    return probe(url, config)
  },
)

/** Worker Task (Conditional Branch): Deep diagnostic triage for failing targets */
export const diagnoseFailureTask = task(
  { ...DEFAULTS, name: 'diagnoseFailure', timeoutSeconds: 30 },
  async function diagnoseFailureTask(
    _ctx: TaskContext,
    url: string,
    error?: string,
  ): Promise<Diagnosis> {
    return diagnoseFailure(url, error)
  },
)

/** Worker Task (Fan-In Judge): Synthesize statistical report and Markdown brief */
export const generateReportTask = task(
  { ...DEFAULTS, name: 'generateReport', timeoutSeconds: 30 },
  async function generateReportTask(
    _ctx: TaskContext,
    probeResults: SiteProbeResult[],
    diagnoses: Diagnosis[],
  ): Promise<HealthReport> {
    return generateHealthReport(probeResults, diagnoses)
  },
)

/** Orchestrator Task: Trigger this one with a list of URLs */
export const checkSites = task(
  { ...DEFAULTS, name: 'checkSites', timeoutSeconds: 600 },
  async function checkSites(
    ctx: TaskContext,
    urls: string[],
    config: HealthCheckConfig = {},
  ): Promise<HealthReport> {
    const targets = cleanUrls(urls)
    const probeResults: SiteProbeResult[] = []
    const failingUrls: Array<{ url: string; error?: string }> = []

    // 1. Fan-out probes in bounded parallel batches
    for (let start = 0; start < targets.length; start += BATCH_SIZE) {
      const batch = targets.slice(start, start + BATCH_SIZE)
      const settled = await Promise.allSettled(
        batch.map((url) => ctx.run(probeSite, url, config)),
      )

      settled.forEach((res, i) => {
        const url = batch[i]
        if (res.status === 'fulfilled') {
          const result = res.value
          probeResults.push(result)
          if (result.status === 'DOWN') {
            failingUrls.push({ url, error: result.error })
          }
        } else {
          // Task still threw after all 3 retries (persistent timeout or outage)
          const errMessage =
            res.reason instanceof Error ? res.reason.message : String(res.reason)
          const downResult: SiteProbeResult = {
            url,
            status: 'DOWN',
            latencyMs: 0,
            redirectHops: 0,
            finalUrl: url,
            error: errMessage,
          }
          probeResults.push(downResult)
          failingUrls.push({ url, error: errMessage })
        }
      })
    }

    // 2. Conditional Fan-Out: Only run deep triage for targets that failed
    const diagnoses: Diagnosis[] = []
    if (failingUrls.length > 0) {
      const diagSettled = await Promise.allSettled(
        failingUrls.map(({ url, error }) =>
          ctx.run(diagnoseFailureTask, url, error),
        ),
      )

      diagSettled.forEach((res, i) => {
        if (res.status === 'fulfilled') {
          diagnoses.push(res.value)
        } else {
          diagnoses.push({
            url: failingUrls[i].url,
            hostname: '',
            stageFailed: 'unknown',
            rootCause: 'TRIAGE_EXECUTION_ERROR',
            details: String(res.reason),
            actionableFix: 'Check network routing and retry diagnosis.',
          })
        }
      })
    }

    // 3. Fan-In Judge: Synthesize complete executive report and markdown brief
    return ctx.run(generateReportTask, probeResults, diagnoses)
  },
)
