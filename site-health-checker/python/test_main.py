"""Offline tests for Site Reliability & Health Suite (Python).

Run:  pytest -q
"""
import asyncio
import json
import pathlib
import pytest

import diagnose
import main
import probe
import reporter

SAMPLES = pathlib.Path(__file__).parent / "sample"
SAMPLE_URLS = json.loads((SAMPLES / "sites.json").read_text(encoding="utf-8"))


class FakeCtx:
    """Stand-in for TaskContext that tracks execution and mimics Render retries."""

    def __init__(self):
        self.metadata = {}
        self.max_parallel = 0
        self.call_count = {}
        self.handlers = {}
        self._active = 0

    async def run(self, task, *args):
        task_name = getattr(task, "name", getattr(task, "__name__", str(task)))
        self.call_count[task_name] = self.call_count.get(task_name, 0) + 1
        self._active += 1
        self.max_parallel = max(self.max_parallel, self._active)

        try:
            await asyncio.sleep(0)  # cooperative yield
            custom_handler = self.handlers.get(task_name)
            last_err = None
            for _ in range(4):
                try:
                    if custom_handler:
                        out = custom_handler(*args)
                        return await out if asyncio.iscoroutine(out) else out
                    func = getattr(task, "func", task)
                    out = func(self, *args)
                    return await out if asyncio.iscoroutine(out) else out
                except Exception as e:
                    last_err = e
            if last_err is not None:
                raise last_err
        finally:
            self._active -= 1


# ---------------------------------------------------------------------------
# 1. URL Validation & Cleaning
# ---------------------------------------------------------------------------

def test_clean_urls_validates_and_deduplicates():
    raw = [
        "  https://example.com  ",
        "https://example.com",
        "https://render.com",
        "   ",
        123,
    ]
    cleaned = main.clean_urls(raw)
    assert cleaned == ["https://example.com", "https://render.com"]


def test_clean_urls_rejects_empty():
    with pytest.raises(ValueError, match="must be a non-empty array"):
        main.clean_urls([])

    with pytest.raises(ValueError, match="no valid URL strings found"):
        main.clean_urls(["   "])


def test_clean_urls_enforces_limit():
    too_many = [f"https://site{i}.example" for i in range(main.MAX_SITES + 1)]
    with pytest.raises(ValueError, match="too many URLs"):
        main.clean_urls(too_many)


# ---------------------------------------------------------------------------
# 2. Security Scorecard
# ---------------------------------------------------------------------------

def test_evaluate_security_grade_a():
    headers = {
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
        "Content-Security-Policy": "default-src 'self'",
        "X-Frame-Options": "DENY",
        "X-Content-Type-Options": "nosniff",
    }
    res = probe.evaluate_security(headers, True)
    assert res["grade"] == "A"
    assert res["hasHsts"] is True
    assert res["hasCsp"] is True
    assert res["hasXFrameOptions"] is True
    assert res["hasXContentTypeOptions"] is True
    assert len(res["missingHeaders"]) == 0


def test_evaluate_security_grade_f_for_http():
    headers = {"X-Frame-Options": "SAMEORIGIN"}
    res_http = probe.evaluate_security(headers, False)
    assert res_http["grade"] == "F"

    res_https = probe.evaluate_security(headers, True)
    assert res_https["grade"] == "D"
    assert "Strict-Transport-Security" in res_https["missingHeaders"]


# ---------------------------------------------------------------------------
# 3. Statistical Reporter
# ---------------------------------------------------------------------------

def test_generate_health_report():
    mock_probes = [
        {
            "url": "https://site1.example",
            "status": "UP",
            "latencyMs": 100,
            "httpCode": 200,
            "redirectHops": 0,
            "finalUrl": "https://site1.example",
            "security": {
                "grade": "A",
                "hasHsts": True,
                "hasCsp": True,
                "hasXFrameOptions": True,
                "hasXContentTypeOptions": True,
                "missingHeaders": [],
            },
        },
        {
            "url": "https://site2.example",
            "status": "SLOW",
            "latencyMs": 1200,
            "httpCode": 200,
            "redirectHops": 0,
            "finalUrl": "https://site2.example",
        },
        {
            "url": "https://site3.example",
            "status": "DOWN",
            "latencyMs": 0,
            "redirectHops": 0,
            "finalUrl": "https://site3.example",
            "error": "Connection timed out",
        },
        {
            "url": "https://site4.example",
            "status": "BAD",
            "latencyMs": 150,
            "httpCode": 404,
            "redirectHops": 0,
            "finalUrl": "https://site4.example",
            "error": "HTTP 404 Not Found",
        },
    ]

    mock_diagnoses = [
        {
            "url": "https://site3.example",
            "hostname": "site3.example",
            "stageFailed": "tcp",
            "rootCause": "TCP_CONNECTION_TIMEOUT",
            "details": "Connection timed out after 3.5s",
            "actionableFix": "Check firewall ingress rules on port 443",
        }
    ]

    report = reporter.generate_health_report(mock_probes, mock_diagnoses)

    assert report["total"] == 4
    assert report["up"] == 1
    assert report["slow"] == 1
    assert report["down"] == 1
    assert report["bad"] == 1
    assert report["uptimePercentage"] == 50.0

    assert report["latency"]["minMs"] == 100
    assert report["latency"]["medianMs"] == 150
    assert report["latency"]["maxMs"] == 1200

    assert len(report["incidents"]) == 2
    site3_inc = next(i for i in report["incidents"] if i["url"] == "https://site3.example")
    assert site3_inc["stageFailed"] == "tcp"
    assert site3_inc["rootCause"] == "TCP_CONNECTION_TIMEOUT"

    assert "Fleet Status Overview" in report["summaryMarkdown"]
    assert "Active Incidents & Root-Cause Triage" in report["summaryMarkdown"]
    assert "TCP_CONNECTION_TIMEOUT" in report["summaryMarkdown"]


# ---------------------------------------------------------------------------
# 4. Orchestrator Workflow Execution
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_check_sites_orchestrator():
    ctx = FakeCtx()
    test_urls = [
        "https://healthy.example",
        "https://slow.example",
        "https://broken.example",
    ]

    diag_called_for = []

    async def mock_probe(url, config=None):
        if "healthy" in url:
            return {"url": url, "status": "UP", "latencyMs": 120, "httpCode": 200, "finalUrl": url}
        if "slow" in url:
            return {"url": url, "status": "SLOW", "latencyMs": 1800, "httpCode": 200, "finalUrl": url}
        return {"url": url, "status": "DOWN", "latencyMs": 0, "finalUrl": url, "error": "ENOTFOUND"}

    async def mock_diag(url, err=None):
        diag_called_for.append(url)
        return {
            "url": url,
            "hostname": "broken.example",
            "stageFailed": "dns",
            "rootCause": "DNS_RESOLUTION_FAILED",
            "details": err or "ENOTFOUND",
            "actionableFix": "Configure DNS A records",
        }

    ctx.handlers["probe_site"] = mock_probe
    ctx.handlers["diagnose_failure"] = mock_diag

    func = getattr(main.check_sites, "func", main.check_sites)
    report = await func(ctx, test_urls)

    assert report["total"] == 3
    assert report["up"] == 1
    assert report["slow"] == 1
    assert report["down"] == 1

    assert ctx.max_parallel <= main.BATCH_SIZE
    assert diag_called_for == ["https://broken.example"]
    assert ctx.call_count.get("diagnose_failure") == 1
    assert ctx.call_count.get("generate_report") == 1
    assert "DNS_RESOLUTION_FAILED" in report["summaryMarkdown"]
