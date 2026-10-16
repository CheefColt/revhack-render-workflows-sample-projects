"""Diagnostic triage: isolates root causes across DNS, TCP, and TLS layers."""
import socket
import ssl
from urllib.parse import urlparse


def diagnose_failure(raw_url: str, original_error: str = None) -> dict:
    """Triage and diagnose root cause of an endpoint failure."""
    try:
        parsed = urlparse(raw_url)
        hostname = parsed.hostname or ""
        if not hostname:
            raise ValueError("No hostname found")
    except Exception as e:
        return {
            "url": raw_url,
            "hostname": "",
            "stageFailed": "url",
            "rootCause": "MALFORMED_URL",
            "details": str(e),
            "actionableFix": "Verify the URL contains a valid protocol (http/https) and domain name.",
        }

    is_https = parsed.scheme == "https"
    port = parsed.port or (443 if is_https else 80)

    # Stage 1: DNS Resolution Test
    resolved_ips = []
    try:
        addr_info = socket.getaddrinfo(hostname, port, proto=socket.IPPROTO_TCP)
        resolved_ips = list({entry[4][0] for entry in addr_info if entry[4]})
        if not resolved_ips:
            return {
                "url": raw_url,
                "hostname": hostname,
                "stageFailed": "dns",
                "rootCause": "DNS_NO_RECORDS",
                "details": f"No A or AAAA records found for {hostname}",
                "actionableFix": "Add A/AAAA records in your DNS management console.",
            }
    except socket.gaierror as e:
        return {
            "url": raw_url,
            "hostname": hostname,
            "stageFailed": "dns",
            "rootCause": "DNS_RESOLUTION_FAILED",
            "details": f"{e.strerror or 'GAI_ERROR'} ({e.errno}): {e}",
            "actionableFix": "Check domain registration, DNS nameservers, or check for typos in the hostname.",
        }

    # Stage 2: TCP Connection Test
    try:
        with socket.create_connection((hostname, port), timeout=3.5):
            pass
    except ConnectionRefusedError as e:
        return {
            "url": raw_url,
            "hostname": hostname,
            "stageFailed": "tcp",
            "rootCause": "TCP_CONNECTION_REFUSED",
            "details": str(e),
            "actionableFix": f"Ensure a web service is actively listening on port {port} and not blocked by a firewall.",
            "ips": resolved_ips,
        }
    except (socket.timeout, TimeoutError) as e:
        return {
            "url": raw_url,
            "hostname": hostname,
            "stageFailed": "tcp",
            "rootCause": "TCP_CONNECTION_TIMEOUT",
            "details": f"Connection to {hostname}:{port} timed out after 3.5s",
            "actionableFix": f"Check network routing, cloud security groups, and ingress firewall rules on port {port}.",
            "ips": resolved_ips,
        }
    except Exception as e:
        return {
            "url": raw_url,
            "hostname": hostname,
            "stageFailed": "tcp",
            "rootCause": "TCP_CONNECTION_FAILED",
            "details": str(e),
            "actionableFix": "Verify host availability and intermediate network routers.",
            "ips": resolved_ips,
        }

    # Stage 3: TLS Handshake Test (if HTTPS)
    if is_https:
        try:
            ctx = ssl.create_default_context()
            with socket.create_connection((hostname, port), timeout=4.0) as sock:
                with ctx.wrap_socket(sock, server_hostname=hostname):
                    pass
        except ssl.SSLCertVerificationError as e:
            err_str = str(e).lower()
            root_cause = "TLS_HANDSHAKE_ERROR"
            actionable_fix = "Check SSL certificate configuration and cipher suite compatibility."

            if "certificate has expired" in err_str:
                root_cause = "SSL_CERTIFICATE_EXPIRED"
                actionable_fix = "Renew the TLS/SSL certificate immediately with Let’s Encrypt or your certificate authority."
            elif "self-signed" in err_str:
                root_cause = "SELF_SIGNED_CERTIFICATE"
                actionable_fix = "Replace self-signed certificates with a publicly-trusted CA certificate in production."
            elif "hostname" in err_str:
                root_cause = "CERT_HOSTNAME_MISMATCH"
                actionable_fix = f"Ensure the certificate Subject Alternative Name (SAN) includes '{hostname}'."

            return {
                "url": raw_url,
                "hostname": hostname,
                "stageFailed": "tls",
                "rootCause": root_cause,
                "details": str(e),
                "actionableFix": actionable_fix,
                "ips": resolved_ips,
            }
        except Exception as e:
            return {
                "url": raw_url,
                "hostname": hostname,
                "stageFailed": "tls",
                "rootCause": "TLS_NEGOTIATION_FAILED",
                "details": str(e),
                "actionableFix": "Ensure server supports standard TLS 1.2/1.3 ciphers.",
                "ips": resolved_ips,
            }

    # Stage 4: HTTP Protocol Layer Issue
    return {
        "url": raw_url,
        "hostname": hostname,
        "stageFailed": "http",
        "rootCause": "HTTP_TRANSIENT_OR_APPLICATION_ERROR",
        "details": original_error or "Network layers succeeded, but HTTP endpoint failed or returned server error",
        "actionableFix": "Check backend application server logs, upstream reverse-proxy timeouts, or rate limits.",
        "ips": resolved_ips,
    }
