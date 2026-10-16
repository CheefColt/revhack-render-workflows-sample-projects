import type { Diagnosis } from './diagnose.js'
import type { SiteProbeResult } from './probe.js'

export interface LatencyStats {
  minMs: number
  medianMs: number
  p95Ms: number
  maxMs: number
  avgMs: number
}

export interface ExpiringCert {
  url: string
  daysRemaining: number
  issuer: string
  validTo: string
  isExpired: boolean
}

export interface Incident {
  url: string
  status: string
  stageFailed: string
  rootCause: string
  details: string
  actionableFix: string
}

export interface HealthReport {
  timestamp: string
  total: number
  up: number
  slow: number
  down: number
  bad: number
  uptimePercentage: number
  latency: LatencyStats
  securityGrades: Record<'A' | 'B' | 'C' | 'D' | 'F', number>
  slowestSites: Array<{ url: string; latencyMs: number; httpCode?: number }>
  expiringCerts: ExpiringCert[]
  incidents: Incident[]
  summaryMarkdown: string
  results: SiteProbeResult[]
}

/** Calculate p-th percentile from sorted numeric array */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0
  const index = Math.ceil((p / 100) * sorted.length) - 1
  return sorted[Math.max(0, Math.min(index, sorted.length - 1))]
}

/** Synthesize probe results and diagnoses into an executive health report */
export function generateHealthReport(
  probeResults: SiteProbeResult[],
  diagnoses: Diagnosis[] = [],
): HealthReport {
  const total = probeResults.length
  let up = 0
  let slow = 0
  let down = 0
  let bad = 0

  const latencies: number[] = []
  const securityGrades: Record<'A' | 'B' | 'C' | 'D' | 'F', number> = { A: 0, B: 0, C: 0, D: 0, F: 0 }
  const expiringCerts: ExpiringCert[] = []

  const diagMap = new Map<string, Diagnosis>()
  for (const d of diagnoses) {
    diagMap.set(d.url, d)
  }

  for (const r of probeResults) {
    if (r.status === 'UP') up++
    else if (r.status === 'SLOW') slow++
    else if (r.status === 'DOWN') down++
    else if (r.status === 'BAD') bad++

    if (r.latencyMs > 0 && r.status !== 'DOWN') {
      latencies.push(r.latencyMs)
    }

    if (r.security) {
      securityGrades[r.security.grade] = (securityGrades[r.security.grade] || 0) + 1
    }

    if (r.ssl && (r.ssl.expiringSoon || r.ssl.isExpired)) {
      expiringCerts.push({
        url: r.url,
        daysRemaining: r.ssl.daysRemaining,
        issuer: r.ssl.issuer,
        validTo: r.ssl.validTo,
        isExpired: r.ssl.isExpired,
      })
    }
  }

  latencies.sort((a, b) => a - b)
  const sum = latencies.reduce((acc, val) => acc + val, 0)
  const latencyStats: LatencyStats = {
    minMs: latencies.length > 0 ? latencies[0] : 0,
    medianMs: percentile(latencies, 50),
    p95Ms: percentile(latencies, 95),
    maxMs: latencies.length > 0 ? latencies[latencies.length - 1] : 0,
    avgMs: latencies.length > 0 ? Math.round(sum / latencies.length) : 0,
  }

  const uptimePercentage = total > 0 ? Math.round(((up + slow) / total) * 1000) / 10 : 0

  const slowestSites = [...probeResults]
    .filter((r) => r.status === 'UP' || r.status === 'SLOW')
    .sort((a, b) => b.latencyMs - a.latencyMs)
    .slice(0, 5)
    .map((r) => ({ url: r.url, latencyMs: r.latencyMs, httpCode: r.httpCode }))

  // Pair failed endpoints with their diagnoses
  const incidents: Incident[] = []
  for (const r of probeResults) {
    if (r.status === 'DOWN' || r.status === 'BAD') {
      const diag = diagMap.get(r.url)
      incidents.push({
        url: r.url,
        status: r.status,
        stageFailed: diag?.stageFailed || 'probe',
        rootCause: diag?.rootCause || (r.status === 'BAD' ? 'CLIENT_ERROR' : 'UNKNOWN_OUTAGE'),
        details: diag?.details || r.error || 'Endpoint failed health check',
        actionableFix: diag?.actionableFix || 'Verify service status and endpoint availability.',
      })
    }
  }

  // Generate Executive Markdown Brief
  const timestamp = new Date().toISOString()
  const lines: string[] = [
    `# 🌐 Site Fleet Reliability Report`,
    `> Generated at **${timestamp}** across **${total}** endpoints.`,
    ``,
    `### 📊 Fleet Status Overview`,
    `| Total | 🟢 UP | 🟡 SLOW | 🔴 DOWN | ⚪ BAD (4xx) | Uptime % |`,
    `|:---:|:---:|:---:|:---:|:---:|:---:|`,
    `| **${total}** | **${up}** | **${slow}** | **${down}** | **${bad}** | **${uptimePercentage}%** |`,
    ``,
    `### ⚡ Latency Profile (Healthy Endpoints)`,
    `| Min | Median (p50) | p95 | Max | Average |`,
    `|:---:|:---:|:---:|:---:|:---:|`,
    `| ${latencyStats.minMs}ms | ${latencyStats.medianMs}ms | **${latencyStats.p95Ms}ms** | ${latencyStats.maxMs}ms | ${latencyStats.avgMs}ms |`,
    ``,
    `### 🛡️ Security Header Posture`,
    `| Grade A | Grade B | Grade C | Grade D | Grade F |`,
    `|:---:|:---:|:---:|:---:|:---:|`,
    `| **${securityGrades.A}** | **${securityGrades.B}** | **${securityGrades.C}** | **${securityGrades.D}** | **${securityGrades.F}** |`,
    ``,
  ]

  if (incidents.length > 0) {
    lines.push(`### 🚨 Active Incidents & Root-Cause Triage`)
    lines.push(`| Status | Target URL | Failure Stage | Root Cause & Diagnosis | Recommended Action |`)
    lines.push(`|:---:|:---|:---:|:---|:---|`)
    for (const inc of incidents) {
      const icon = inc.status === 'DOWN' ? '🔴 DOWN' : '⚪ CLIENT'
      lines.push(
        `| ${icon} | \`${inc.url}\` | **${inc.stageFailed.toUpperCase()}** | \`${inc.rootCause}\`<br><small>${inc.details}</small> | ${inc.actionableFix} |`,
      )
    }
    lines.push(``)
  }

  if (expiringCerts.length > 0) {
    lines.push(`### ⚠️ SSL / TLS Certificates of Concern`)
    lines.push(`| Target URL | Days Left | Status | Issuer | Expiry Date |`)
    lines.push(`|:---|:---:|:---:|:---|:---|`)
    for (const cert of expiringCerts) {
      const tag = cert.isExpired ? '🚨 EXPIRED' : '⚠️ EXPIRING SOON'
      lines.push(
        `| \`${cert.url}\` | **${cert.daysRemaining}** | ${tag} | ${cert.issuer} | \`${cert.validTo.slice(0, 10)}\` |`,
      )
    }
    lines.push(``)
  }

  if (slowestSites.length > 0) {
    lines.push(`### ⏱️ Slowest Responding Endpoints`)
    lines.push(`| Target URL | Response Time | HTTP Status |`)
    lines.push(`|:---|:---:|:---:|`)
    for (const s of slowestSites) {
      lines.push(`| \`${s.url}\` | **${s.latencyMs}ms** | HTTP ${s.httpCode ?? 200} |`)
    }
    lines.push(``)
  }

  const summaryMarkdown = lines.join('\n')

  return {
    timestamp,
    total,
    up,
    slow,
    down,
    bad,
    uptimePercentage,
    latency: latencyStats,
    securityGrades,
    slowestSites,
    expiringCerts,
    incidents,
    summaryMarkdown,
    results: probeResults,
  }
}
