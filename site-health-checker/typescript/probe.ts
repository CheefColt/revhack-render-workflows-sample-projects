import * as tls from 'node:tls'
import { URL } from 'node:url'

export interface SslInfo {
  valid: boolean
  issuer: string
  subject: string
  validFrom: string
  validTo: string
  daysRemaining: number
  isExpired: boolean
  expiringSoon: boolean
  error?: string
}

export interface SecurityScorecard {
  grade: 'A' | 'B' | 'C' | 'D' | 'F'
  hasHsts: boolean
  hasCsp: boolean
  hasXFrameOptions: boolean
  hasXContentTypeOptions: boolean
  missingHeaders: string[]
}

export type HealthStatus = 'UP' | 'SLOW' | 'DOWN' | 'BAD'

export interface SiteProbeResult {
  url: string
  status: HealthStatus
  httpCode?: number
  latencyMs: number
  ssl?: SslInfo
  security?: SecurityScorecard
  redirectHops: number
  finalUrl: string
  error?: string
  retryable?: boolean
}

export class TransientProbeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TransientProbeError'
  }
}

/** Check SSL/TLS certificate details directly via TLS socket */
export async function inspectSsl(hostname: string, port = 443, timeoutMs = 4000): Promise<SslInfo> {
  return new Promise((resolve) => {
    let settled = false
    const socket = tls.connect(
      {
        host: hostname,
        port,
        servername: hostname,
        rejectUnauthorized: false, // inspect even if expired or self-signed
        timeout: timeoutMs,
      },
      () => {
        if (settled) return
        settled = true
        try {
          const cert = socket.getPeerCertificate()
          if (!cert || !cert.valid_to) {
            socket.destroy()
            return resolve({
              valid: false,
              issuer: 'Unknown',
              subject: hostname,
              validFrom: '',
              validTo: '',
              daysRemaining: 0,
              isExpired: true,
              expiringSoon: false,
              error: 'No peer certificate presented',
            })
          }

          const validTo = new Date(cert.valid_to)
          const validFrom = new Date(cert.valid_from)
          const now = Date.now()
          const msRemaining = validTo.getTime() - now
          const daysRemaining = Math.floor(msRemaining / (1000 * 60 * 60 * 24))
          const isExpired = daysRemaining < 0
          const expiringSoon = daysRemaining >= 0 && daysRemaining <= 30
          const formatField = (val: string | string[] | undefined, fallback: string): string => {
            if (!val) return fallback
            return Array.isArray(val) ? val.join(', ') : val
          }
          const issuerName = cert.issuer ? formatField(cert.issuer.O || cert.issuer.CN, 'Unknown') : 'Unknown'
          const subjectName = cert.subject ? formatField(cert.subject.CN, hostname) : hostname

          socket.destroy()
          resolve({
            valid: !isExpired,
            issuer: issuerName,
            subject: subjectName,
            validFrom: validFrom.toISOString(),
            validTo: validTo.toISOString(),
            daysRemaining,
            isExpired,
            expiringSoon,
          })
        } catch (err: any) {
          socket.destroy()
          resolve({
            valid: false,
            issuer: 'Unknown',
            subject: hostname,
            validFrom: '',
            validTo: '',
            daysRemaining: 0,
            isExpired: true,
            expiringSoon: false,
            error: err.message,
          })
        }
      },
    )

    socket.on('timeout', () => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({
        valid: false,
        issuer: 'Unknown',
        subject: hostname,
        validFrom: '',
        validTo: '',
        daysRemaining: 0,
        isExpired: false,
        expiringSoon: false,
        error: 'TLS handshake timed out',
      })
    })

    socket.on('error', (err) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({
        valid: false,
        issuer: 'Unknown',
        subject: hostname,
        validFrom: '',
        validTo: '',
        daysRemaining: 0,
        isExpired: false,
        expiringSoon: false,
        error: err.message,
      })
    })
  })
}

/** Evaluate security headers against modern web defense standards */
export function evaluateSecurity(headers: Headers, isHttps: boolean): SecurityScorecard {
  const hasHsts = isHttps && headers.has('strict-transport-security')
  const hasCsp = headers.has('content-security-policy')
  const hasXFrameOptions = headers.has('x-frame-options')
  const hasXContentTypeOptions = (headers.get('x-content-type-options') || '').toLowerCase().includes('nosniff')

  const missing: string[] = []
  if (isHttps && !hasHsts) missing.push('Strict-Transport-Security')
  if (!hasCsp) missing.push('Content-Security-Policy')
  if (!hasXFrameOptions) missing.push('X-Frame-Options')
  if (!hasXContentTypeOptions) missing.push('X-Content-Type-Options: nosniff')

  let points = 0
  if (hasHsts) points++
  if (hasCsp) points++
  if (hasXFrameOptions) points++
  if (hasXContentTypeOptions) points++

  let grade: SecurityScorecard['grade'] = 'F'
  if (!isHttps) {
    grade = 'F'
  } else if (points >= 4) {
    grade = 'A'
  } else if (points === 3) {
    grade = 'B'
  } else if (points === 2) {
    grade = 'C'
  } else if (points === 1) {
    grade = 'D'
  }

  return {
    grade,
    hasHsts,
    hasCsp,
    hasXFrameOptions,
    hasXContentTypeOptions,
    missingHeaders: missing,
  }
}

/** Execute a full probe of one URL: HTTP check, latency, SSL cert & security scorecard */
export async function probe(
  rawUrl: string,
  options: { timeoutMs?: number; slowThresholdMs?: number } = {},
): Promise<SiteProbeResult> {
  const timeoutMs = options.timeoutMs ?? 7000
  const slowThresholdMs = options.slowThresholdMs ?? 1000

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return {
        url: rawUrl,
        status: 'BAD',
        latencyMs: 0,
        redirectHops: 0,
        finalUrl: rawUrl,
        error: `Unsupported protocol: ${parsed.protocol}`,
        retryable: false,
      }
    }
  } catch (err: any) {
    return {
      url: rawUrl,
      status: 'BAD',
      latencyMs: 0,
      redirectHops: 0,
      finalUrl: rawUrl,
      error: `Invalid URL format: ${err.message}`,
      retryable: false,
    }
  }

  const isHttps = parsed.protocol === 'https:'
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80

  // 1. SSL Inspection (concurrent if HTTPS)
  const sslPromise = isHttps ? inspectSsl(parsed.hostname, port, Math.min(timeoutMs, 4000)) : Promise.resolve(undefined)

  // 2. HTTP fetch with timeout and redirect tracking
  const start = performance.now()
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(parsed.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'RenderWorkflows-SiteHealth/1.0',
        'Accept': '*/*',
      },
      signal: controller.signal,
      redirect: 'follow',
    })
    clearTimeout(timer)
    const latencyMs = Math.round(performance.now() - start)
    const ssl = await sslPromise
    const security = evaluateSecurity(response.headers, isHttps)
    const httpCode = response.status

    // Check for 5xx server errors: these are transient, so we throw to let Render retry
    if (httpCode >= 500) {
      throw new TransientProbeError(`Server returned HTTP ${httpCode}`)
    }

    // 4xx client errors are deterministic: 404/403/400 won't change on retry
    if (httpCode >= 400) {
      return {
        url: rawUrl,
        status: 'BAD',
        httpCode,
        latencyMs,
        ssl,
        security,
        redirectHops: response.redirected ? 1 : 0,
        finalUrl: response.url || rawUrl,
        error: `HTTP ${httpCode} ${response.statusText}`,
        retryable: false,
      }
    }

    const isSlow = latencyMs >= slowThresholdMs
    return {
      url: rawUrl,
      status: isSlow ? 'SLOW' : 'UP',
      httpCode,
      latencyMs,
      ssl,
      security,
      redirectHops: response.redirected ? 1 : 0,
      finalUrl: response.url || rawUrl,
    }
  } catch (err: any) {
    clearTimeout(timer)
    const latencyMs = Math.round(performance.now() - start)

    // Check if this error is retryable (timeout, network reset, 5xx)
    const isAbort = err.name === 'AbortError'
    const isTransient =
      err instanceof TransientProbeError ||
      isAbort ||
      ['ECONNRESET', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'EAI_AGAIN'].includes(err.code)

    if (isTransient) {
      // Throwing allows Render Workflows to retry this task run
      throw new TransientProbeError(isAbort ? `Request timed out after ${timeoutMs}ms` : err.message)
    }

    // Non-retryable permanent failure (e.g., DNS ENOTFOUND or SSL cert mismatch)
    const ssl = await sslPromise
    return {
      url: rawUrl,
      status: 'DOWN',
      latencyMs,
      ssl,
      redirectHops: 0,
      finalUrl: rawUrl,
      error: err.message,
      retryable: false,
    }
  }
}
