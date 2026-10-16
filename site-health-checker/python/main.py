"""Site Reliability & Health Suite: a Render Workflows template (Python).

A list of URLs in -> checks them in parallel -> conditional deep triage for failures
-> executive statistical summary & markdown incident report.

Zero setup: needs no API keys, no domain verification, no third-party accounts.

Why this is a workflow and not one API endpoint:
  - 50 URLs checked sequentially would block an API request for 30-60+ seconds.
  - Each site is independent, so they are probed side-by-side in parallel.
  - Real sites answer at different speeds; some time out or drop packets.
  - Render retries transient failures (timeouts, 5xx) with exponential backoff,
    while deterministic outcomes (404, bad URL) complete immediately without wasting runs.
  - One dead or hanging site does not stop the other 49.
  - Failing sites conditionally trigger a deep diagnostic triage (DNS, TCP, TLS).
  - A final fan-in judge synthesizes SLA %, p95 latency, security grades, and active incidents.

Shape of the run:

    check_sites (Orchestrator)
        |-- [ probe_site x N ] in bounded parallel batches
        |-- [ diagnose_failure x M ] conditionally for failing sites only
        '-- generate_report (Fan-in judge synthesizing metrics & markdown)

Run locally:   render workflows dev -- python main.py
"""
import asyncio
from render import Retry, TaskContext, Workflows

import diagnose
import probe
import reporter

MAX_SITES = 200
BATCH_SIZE = 10

app = Workflows(
    default_retry=Retry(max_retries=3, wait_duration_ms=1000, backoff_scaling=2.0),
    default_timeout=120,
)


def clean_urls(raw) -> list[str]:
    """Sanitize, deduplicate, and validate input URLs."""
    if not isinstance(raw, list) or len(raw) == 0:
        raise ValueError("urls must be a non-empty array of URL strings")
    if len(raw) > MAX_SITES:
        raise ValueError(f"too many URLs ({len(raw)}); max is {MAX_SITES} per run")

    seen = set()
    cleaned = []
    for item in raw:
        if not isinstance(item, str):
            continue
        trimmed = item.strip()
        if not trimmed:
            continue
        if trimmed not in seen:
            seen.add(trimmed)
            cleaned.append(trimmed)

    if not cleaned:
        raise ValueError("no valid URL strings found in input")

    return cleaned


@app.task(name="probe_site", timeout_seconds=30)
async def probe_site(_ctx: TaskContext, url: str, config: dict = None) -> dict:
    """Worker Task: Probe one URL (HTTP, latency, SSL validity, security headers)."""
    return await probe.probe(url, config)


@app.task(name="diagnose_failure", timeout_seconds=30)
async def diagnose_failure_task(_ctx: TaskContext, url: str, error: str = None) -> dict:
    """Worker Task (Conditional Branch): Deep diagnostic triage for failing targets."""
    return diagnose.diagnose_failure(url, error)


@app.task(name="generate_report", timeout_seconds=30)
async def generate_report_task(_ctx: TaskContext, probe_results: list, diagnoses: list) -> dict:
    """Worker Task (Fan-In Judge): Synthesize statistical report and Markdown brief."""
    return reporter.generate_health_report(probe_results, diagnoses)


@app.task(name="check_sites", timeout_seconds=600)
async def check_sites(ctx: TaskContext, urls: list, config: dict = None) -> dict:
    """Orchestrator Task: Trigger this one with a list of URLs."""
    config = config or {}
    targets = clean_urls(urls)
    probe_results = []
    failing_urls = []

    # 1. Fan-out probes in bounded parallel batches
    for start in range(0, len(targets), BATCH_SIZE):
        batch = targets[start:start + BATCH_SIZE]
        results = await asyncio.gather(
            *(ctx.run(probe_site, url, config) for url in batch),
            return_exceptions=True,
        )

        for url, res in zip(batch, results):
            if isinstance(res, BaseException):
                # Task threw after all retries (persistent timeout or outage)
                down_res = {
                    "url": url,
                    "status": "DOWN",
                    "latencyMs": 0,
                    "redirectHops": 0,
                    "finalUrl": url,
                    "error": str(res),
                }
                probe_results.append(down_res)
                failing_urls.append({"url": url, "error": str(res)})
            else:
                probe_results.append(res)
                if res.get("status") == "DOWN":
                    failing_urls.append({"url": url, "error": res.get("error")})

    # 2. Conditional Fan-Out: Only run deep triage for targets that failed
    diagnoses = []
    if failing_urls:
        diag_results = await asyncio.gather(
            *(ctx.run(diagnose_failure_task, item["url"], item.get("error")) for item in failing_urls),
            return_exceptions=True,
        )
        for item, res in zip(failing_urls, diag_results):
            if isinstance(res, BaseException):
                diagnoses.append({
                    "url": item["url"],
                    "hostname": "",
                    "stageFailed": "unknown",
                    "rootCause": "TRIAGE_EXECUTION_ERROR",
                    "details": str(res),
                    "actionableFix": "Check network routing and retry diagnosis.",
                })
            else:
                diagnoses.append(res)

    # 3. Fan-In Judge: Synthesize complete executive report and markdown brief
    return await ctx.run(generate_report_task, probe_results, diagnoses)


if __name__ == "__main__":
    app.start()
