"""Site probe worker: HTTP inspection, SSL certificate checks, and security scorecard."""
from datetime import datetime, timezone
import socket
import ssl
import time
from urllib.parse import urlparse
import httpx


class TransientProbeError(Exception):
    """Raised for retryable errors (timeouts, network drops, 5xx server errors)."""
    pass


def inspect_ssl(hostname: str, port: int = 443, timeout_sec: float = 4.0) -> dict:
    """Inspect peer SSL/TLS certificate details."""
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((hostname, port), timeout=timeout_sec) as sock:
            with ctx.wrap_socket(sock, server_hostname=hostname) as ssock:
                cert = ssock.getpeercert()
                if not cert:
                    return {
                        "valid": False,
                        "issuer": "Unknown",
                        "subject": hostname,
                        "validFrom": "",
                        "validTo": "",
                        "daysRemaining": 0,
                        "isExpired": True,
                        "expiringSoon": False,
                        "error": "No peer certificate presented",
                    }

                not_after_str = cert.get("notAfter", "")
                not_before_str = cert.get("notBefore", "")

                # Format e.g. 'Nov 29 23:59:59 2026 GMT'
                valid_to = datetime.strptime(not_after_str, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)
                valid_from = datetime.strptime(not_before_str, "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)

                now = datetime.now(timezone.utc)
                days_remaining = (valid_to - now).days
                is_expired = days_remaining < 0
                expiring_soon = 0 <= days_remaining <= 30

                issuer_parts = [val for sub in cert.get("issuer", ()) for key, val in sub if key in ("organizationName", "commonName")]
                issuer_name = issuer_parts[0] if issuer_parts else "Unknown"

                subject_parts = [val for sub in cert.get("subject", ()) for key, val in sub if key == "commonName"]
                subject_name = subject_parts[0] if subject_parts else hostname

                return {
                    "valid": not is_expired,
                    "issuer": issuer_name,
                    "subject": subject_name,
                    "validFrom": valid_from.isoformat(),
                    "validTo": valid_to.isoformat(),
                    "daysRemaining": days_remaining,
                    "isExpired": is_expired,
                    "expiringSoon": expiring_soon,
                }
    except ssl.SSLCertVerificationError as e:
        is_expired = "certificate has expired" in str(e).lower()
        return {
            "valid": False,
            "issuer": "Unknown",
            "subject": hostname,
            "validFrom": "",
            "validTo": "",
            "daysRemaining": 0 if is_expired else 999,
            "isExpired": is_expired,
            "expiringSoon": False,
            "error": str(e),
        }
    except Exception as e:
        return {
            "valid": False,
            "issuer": "Unknown",
            "subject": hostname,
            "validFrom": "",
            "validTo": "",
            "daysRemaining": 0,
            "isExpired": False,
            "expiringSoon": False,
            "error": str(e),
        }


def evaluate_security(headers: dict, is_https: bool) -> dict:
    """Evaluate defense-in-depth headers."""
    # Normalize headers to lowercase keys
    norm = {k.lower(): v for k, v in headers.items()}

    has_hsts = is_https and "strict-transport-security" in norm
    has_csp = "content-security-policy" in norm
    has_xfo = "x-frame-options" in norm
    has_xcto = "nosniff" in norm.get("x-content-type-options", "").lower()

    missing = []
    if is_https and not has_hsts:
        missing.append("Strict-Transport-Security")
    if not has_csp:
        missing.append("Content-Security-Policy")
    if not has_xfo:
        missing.append("X-Frame-Options")
    if not has_xcto:
        missing.append("X-Content-Type-Options: nosniff")

    points = sum([has_hsts, has_csp, has_xfo, has_xcto])
    grade = "F"
    if not is_https:
        grade = "F"
    elif points >= 4:
        grade = "A"
    elif points == 3:
        grade = "B"
    elif points == 2:
        grade = "C"
    elif points == 1:
        grade = "D"

    return {
        "grade": grade,
        "hasHsts": has_hsts,
        "hasCsp": has_csp,
        "hasXFrameOptions": has_xfo,
        "hasXContentTypeOptions": has_xcto,
        "missingHeaders": missing,
    }


async def probe(raw_url: str, options: dict = None) -> dict:
    """Execute a full probe of one URL: HTTP check, latency, SSL cert & security scorecard."""
    options = options or {}
    timeout_sec = options.get("timeoutMs", 7000) / 1000.0
    slow_threshold_ms = options.get("slowThresholdMs", 1000)

    try:
        parsed = urlparse(raw_url)
        if parsed.scheme not in ("http", "https"):
            return {
                "url": raw_url,
                "status": "BAD",
                "latencyMs": 0,
                "redirectHops": 0,
                "finalUrl": raw_url,
                "error": f"Unsupported protocol: {parsed.scheme}",
                "retryable": False,
            }
    except Exception as e:
        return {
            "url": raw_url,
            "status": "BAD",
            "latencyMs": 0,
            "redirectHops": 0,
            "finalUrl": raw_url,
            "error": f"Invalid URL format: {e}",
            "retryable": False,
        }

    is_https = parsed.scheme == "https"
    port = parsed.port or (443 if is_https else 80)
    hostname = parsed.hostname or ""

    ssl_info = inspect_ssl(hostname, port, min(timeout_sec, 4.0)) if is_https else None

    start = time.perf_counter()
    try:
        async with httpx.AsyncClient(
            follow_redirects=True,
            timeout=timeout_sec,
            headers={"User-Agent": "RenderWorkflows-SiteHealth/1.0", "Accept": "*/*"},
            verify=False,
        ) as client:
            resp = await client.get(raw_url)

        latency_ms = int((time.perf_counter() - start) * 1000)
        security = evaluate_security(dict(resp.headers), is_https)
        http_code = resp.status_code

        # 5xx server errors are transient: throw so Render retries
        if http_code >= 500:
            raise TransientProbeError(f"Server returned HTTP {http_code}")

        # 4xx client errors are deterministic: not retryable
        if http_code >= 400:
            return {
                "url": raw_url,
                "status": "BAD",
                "httpCode": http_code,
                "latencyMs": latency_ms,
                "ssl": ssl_info,
                "security": security,
                "redirectHops": len(resp.history),
                "finalUrl": str(resp.url),
                "error": f"HTTP {http_code} {resp.reason_phrase}",
                "retryable": False,
            }

        is_slow = latency_ms >= slow_threshold_ms
        return {
            "url": raw_url,
            "status": "SLOW" if is_slow else "UP",
            "httpCode": http_code,
            "latencyMs": latency_ms,
            "ssl": ssl_info,
            "security": security,
            "redirectHops": len(resp.history),
            "finalUrl": str(resp.url),
        }
    except TransientProbeError:
        raise
    except (httpx.TimeoutException, httpx.ConnectTimeout, httpx.ReadTimeout) as e:
        raise TransientProbeError(f"Request timed out: {e}") from e
    except (httpx.NetworkError, httpx.RemoteProtocolError) as e:
        raise TransientProbeError(f"Network error: {e}") from e
    except Exception as e:
        latency_ms = int((time.perf_counter() - start) * 1000)
        return {
            "url": raw_url,
            "status": "DOWN",
            "latencyMs": latency_ms,
            "ssl": ssl_info,
            "redirectHops": 0,
            "finalUrl": raw_url,
            "error": str(e),
            "retryable": False,
        }
