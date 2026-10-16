"""Executive report synthesizer: statistical percentiles, SLA calculations, and markdown brief."""
from datetime import datetime, timezone
import math


def percentile(sorted_list: list, p: float) -> int:
    """Calculate p-th percentile from sorted list."""
    if not sorted_list:
        return 0
    idx = math.ceil((p / 100.0) * len(sorted_list)) - 1
    return sorted_list[max(0, min(idx, len(sorted_list) - 1))]


def generate_health_report(probe_results: list, diagnoses: list = None) -> dict:
    """Synthesize probe results and diagnoses into an executive health report."""
    diagnoses = diagnoses or []
    total = len(probe_results)
    up = 0
    slow = 0
    down = 0
    bad = 0

    latencies = []
    security_grades = {"A": 0, "B": 0, "C": 0, "D": 0, "F": 0}
    expiring_certs = []

    diag_map = {d.get("url"): d for d in diagnoses if isinstance(d, dict)}

    for r in probe_results:
        status = r.get("status")
        if status == "UP":
            up += 1
        elif status == "SLOW":
            slow += 1
        elif status == "DOWN":
            down += 1
        elif status == "BAD":
            bad += 1

        lat = r.get("latencyMs", 0)
        if lat > 0 and status != "DOWN":
            latencies.append(lat)

        sec = r.get("security")
        if sec and isinstance(sec, dict) and "grade" in sec:
            g = sec["grade"]
            security_grades[g] = security_grades.get(g, 0) + 1

        ssl_info = r.get("ssl")
        if ssl_info and isinstance(ssl_info, dict) and (ssl_info.get("expiringSoon") or ssl_info.get("isExpired")):
            expiring_certs.append({
                "url": r.get("url"),
                "daysRemaining": ssl_info.get("daysRemaining", 0),
                "issuer": ssl_info.get("issuer", "Unknown"),
                "validTo": ssl_info.get("validTo", ""),
                "isExpired": ssl_info.get("isExpired", False),
            })

    latencies.sort()
    latency_stats = {
        "minMs": latencies[0] if latencies else 0,
        "medianMs": percentile(latencies, 50),
        "p95Ms": percentile(latencies, 95),
        "maxMs": latencies[-1] if latencies else 0,
        "avgMs": round(sum(latencies) / len(latencies)) if latencies else 0,
    }

    uptime_percentage = round(((up + slow) / total) * 100, 1) if total > 0 else 0.0

    healthy_sites = [r for r in probe_results if r.get("status") in ("UP", "SLOW")]
    healthy_sites.sort(key=lambda x: x.get("latencyMs", 0), reverse=True)
    slowest_sites = [
        {"url": r.get("url"), "latencyMs": r.get("latencyMs", 0), "httpCode": r.get("httpCode")}
        for r in healthy_sites[:5]
    ]

    incidents = []
    for r in probe_results:
        status = r.get("status")
        if status in ("DOWN", "BAD"):
            url = r.get("url", "")
            diag = diag_map.get(url)
            incidents.append({
                "url": url,
                "status": status,
                "stageFailed": diag.get("stageFailed", "probe") if diag else "probe",
                "rootCause": diag.get("rootCause", "CLIENT_ERROR" if status == "BAD" else "UNKNOWN_OUTAGE") if diag else "UNKNOWN",
                "details": diag.get("details", r.get("error", "Endpoint failed health check")) if diag else r.get("error", ""),
                "actionableFix": diag.get("actionableFix", "Verify service status.") if diag else "Verify service status.",
            })

    timestamp = datetime.now(timezone.utc).isoformat()
    lines = [
        "# 🌐 Site Fleet Reliability Report",
        f"> Generated at **{timestamp}** across **{total}** endpoints.",
        "",
        "### 📊 Fleet Status Overview",
        "| Total | 🟢 UP | 🟡 SLOW | 🔴 DOWN | ⚪ BAD (4xx) | Uptime % |",
        "|:---:|:---:|:---:|:---:|:---:|:---:|",
        f"| **{total}** | **{up}** | **{slow}** | **{down}** | **{bad}** | **{uptime_percentage}%** |",
        "",
        "### ⚡ Latency Profile (Healthy Endpoints)",
        "| Min | Median (p50) | p95 | Max | Average |",
        "|:---:|:---:|:---:|:---:|:---:|",
        f"| {latency_stats['minMs']}ms | {latency_stats['medianMs']}ms | **{latency_stats['p95Ms']}ms** | {latency_stats['maxMs']}ms | {latency_stats['avgMs']}ms |",
        "",
        "### 🛡️ Security Header Posture",
        "| Grade A | Grade B | Grade C | Grade D | Grade F |",
        "|:---:|:---:|:---:|:---:|:---:|",
        f"| **{security_grades['A']}** | **{security_grades['B']}** | **{security_grades['C']}** | **{security_grades['D']}** | **{security_grades['F']}** |",
        "",
    ]

    if incidents:
        lines.append("### 🚨 Active Incidents & Root-Cause Triage")
        lines.append("| Status | Target URL | Failure Stage | Root Cause & Diagnosis | Recommended Action |")
        lines.append("|:---:|:---|:---:|:---|:---|")
        for inc in incidents:
            icon = "🔴 DOWN" if inc["status"] == "DOWN" else "⚪ CLIENT"
            lines.append(
                f"| {icon} | `{inc['url']}` | **{inc['stageFailed'].upper()}** | `{inc['rootCause']}`<br><small>{inc['details']}</small> | {inc['actionableFix']} |"
            )
        lines.append("")

    if expiring_certs:
        lines.append("### ⚠️ SSL / TLS Certificates of Concern")
        lines.append("| Target URL | Days Left | Status | Issuer | Expiry Date |")
        lines.append("|:---|:---:|:---:|:---|:---|")
        for cert in expiring_certs:
            tag = "🚨 EXPIRED" if cert["isExpired"] else "⚠️ EXPIRING SOON"
            lines.append(
                f"| `{cert['url']}` | **{cert['daysRemaining']}** | {tag} | {cert['issuer']} | `{cert['validTo'][:10]}` |"
            )
        lines.append("")

    if slowest_sites:
        lines.append("### ⏱️ Slowest Responding Endpoints")
        lines.append("| Target URL | Response Time | HTTP Status |")
        lines.append("|:---|:---:|:---:|")
        for s in slowest_sites:
            lines.append(f"| `{s['url']}` | **{s['latencyMs']}ms** | HTTP {s.get('httpCode') or 200} |")
        lines.append("")

    summary_markdown = "\n".join(lines)

    return {
        "timestamp": timestamp,
        "total": total,
        "up": up,
        "slow": slow,
        "down": down,
        "bad": bad,
        "uptimePercentage": uptime_percentage,
        "latency": latency_stats,
        "securityGrades": security_grades,
        "slowestSites": slowest_sites,
        "expiringCerts": expiring_certs,
        "incidents": incidents,
        "summaryMarkdown": summary_markdown,
        "results": probe_results,
    }
