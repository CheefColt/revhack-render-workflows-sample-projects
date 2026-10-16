import * as dns from 'node:dns/promises'
import * as net from 'node:net'
import * as tls from 'node:tls'
import { URL } from 'node:url'

export interface Diagnosis {
  url: string
  hostname: string
  stageFailed: 'dns' | 'tcp' | 'tls' | 'http' | 'url' | 'unknown'
  rootCause: string
  details: string
  actionableFix: string
  ips?: string[]
}

/** Triage and diagnose root cause of an endpoint failure */
export async function diagnoseFailure(rawUrl: string, originalError?: string): Promise<Diagnosis> {
  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch (err: any) {
    return {
      url: rawUrl,
      hostname: '',
      stageFailed: 'url',
      rootCause: 'MALFORMED_URL',
      details: err.message,
      actionableFix: 'Verify the URL contains a valid protocol (http/https) and domain name.',
    }
  }

  const hostname = parsed.hostname
  const isHttps = parsed.protocol === 'https:'
  const port = parsed.port ? Number(parsed.port) : isHttps ? 443 : 80

  // Stage 1: DNS Resolution Test
  let resolvedIps: string[] = []
  try {
    const lookup = await dns.lookup(hostname, { all: true })
    resolvedIps = lookup.map((l) => l.address)
    if (resolvedIps.length === 0) {
      return {
        url: rawUrl,
        hostname,
        stageFailed: 'dns',
        rootCause: 'DNS_NO_RECORDS',
        details: `No A or AAAA records found for ${hostname}`,
        actionableFix: 'Add A/AAAA records in your DNS management console.',
      }
    }
  } catch (err: any) {
    return {
      url: rawUrl,
      hostname,
      stageFailed: 'dns',
      rootCause: 'DNS_RESOLUTION_FAILED',
      details: `${err.code || 'ERROR'}: ${err.message}`,
      actionableFix: 'Check domain registration, DNS nameservers, or check for typos in the hostname.',
    }
  }

  // Stage 2: TCP Socket Connection Test
  const tcpResult = await new Promise<{ ok: boolean; error?: string; code?: string }>((resolve) => {
    let settled = false
    const socket = net.connect({ host: hostname, port, timeout: 3500 }, () => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok: true })
    })

    socket.on('timeout', () => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok: false, error: `Connection to ${hostname}:${port} timed out after 3.5s`, code: 'ETIMEDOUT' })
    })

    socket.on('error', (err: any) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ok: false, error: err.message, code: err.code })
    })
  })

  if (!tcpResult.ok) {
    const isRefused = tcpResult.code === 'ECONNREFUSED'
    return {
      url: rawUrl,
      hostname,
      stageFailed: 'tcp',
      rootCause: isRefused ? 'TCP_CONNECTION_REFUSED' : 'TCP_CONNECTION_TIMEOUT',
      details: tcpResult.error || 'Failed to establish raw TCP handshake',
      actionableFix: isRefused
        ? `Ensure a web service is actively listening on port ${port} and not blocked by a firewall.`
        : `Check network routing, cloud security groups, and ingress firewall rules on port ${port}.`,
      ips: resolvedIps,
    }
  }

  // Stage 3: TLS Handshake Test (if HTTPS)
  if (isHttps) {
    const tlsResult = await new Promise<{ ok: boolean; error?: string; code?: string }>((resolve) => {
      let settled = false
      const socket = tls.connect(
        {
          host: hostname,
          port,
          servername: hostname,
          rejectUnauthorized: true, // strict check to identify cert errors
          timeout: 4000,
        },
        () => {
          if (settled) return
          settled = true
          socket.destroy()
          resolve({ ok: true })
        },
      )

      socket.on('timeout', () => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve({ ok: false, error: 'TLS handshake timed out', code: 'ETIMEDOUT' })
      })

      socket.on('error', (err: any) => {
        if (settled) return
        settled = true
        socket.destroy()
        resolve({ ok: false, error: err.message, code: err.code })
      })
    })

    if (!tlsResult.ok) {
      let rootCause = 'TLS_HANDSHAKE_ERROR'
      let actionableFix = 'Check SSL certificate configuration and cipher suite compatibility.'

      if (tlsResult.code === 'CERT_HAS_EXPIRED') {
        rootCause = 'SSL_CERTIFICATE_EXPIRED'
        actionableFix = 'Renew the TLS/SSL certificate immediately with Let’s Encrypt or your certificate authority.'
      } else if (tlsResult.code === 'DEPTH_ZERO_SELF_SIGNED_CERT') {
        rootCause = 'SELF_SIGNED_CERTIFICATE'
        actionableFix = 'Replace self-signed certificates with a publicly-trusted CA certificate in production.'
      } else if (tlsResult.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
        rootCause = 'CERT_HOSTNAME_MISMATCH'
        actionableFix = `Ensure the certificate Subject Alternative Name (SAN) includes '${hostname}'.`
      }

      return {
        url: rawUrl,
        hostname,
        stageFailed: 'tls',
        rootCause,
        details: tlsResult.error || 'TLS negotiation failed',
        actionableFix,
        ips: resolvedIps,
      }
    }
  }

  // Stage 4: HTTP Protocol Layer Issue
  return {
    url: rawUrl,
    hostname,
    stageFailed: 'http',
    rootCause: 'HTTP_TRANSIENT_OR_APPLICATION_ERROR',
    details: originalError || 'Network layers succeeded, but HTTP endpoint failed or returned server error',
    actionableFix: 'Check backend application server logs, upstream reverse-proxy timeouts, or rate limits.',
    ips: resolvedIps,
  }
}
