# Task options

Checked against Render's docs and the installed SDKs (`render` 1.2.0 for Python, `@renderinc/sdk` 1.2.0) on Oct 14, 2026.

| Option | Python | TypeScript | Default | Notes |
|---|---|---|---|---|
| name | `name="..."` (optional) | `name: '...'` (required) | function name (Python) | Task slug is `{workflow-slug}/{task-name}`. Renaming changes the slug (inferred). |
| retry | `retry=Retry(max_retries, wait_duration_ms, backoff_scaling)` | `retry: { maxRetries, waitDurationMs, backoffScaling }` | 3 retries (4 attempts), 1 s wait, doubling | Per task |
| timeout | `timeout_seconds=` | `timeoutSeconds:` | 7,200 s (2 h) | Range 30 s to 86,400 s (24 h). A timeout is a failure and is retried. |
| plan | `plan="..."` | `plan: '...'` | `flex` | See below |

Python also supports app-level defaults: `Workflows(default_retry=..., default_timeout=..., default_plan=...)`.
TypeScript has none; share a `DEFAULTS` object instead.

```python
from render import Workflows, Retry
app = Workflows(default_retry=Retry(max_retries=3, wait_duration_ms=1000, backoff_scaling=2.0))

@app.task(timeout_seconds=300, plan="flex")
async def probe_site(ctx, url): ...
```

```ts
import { task } from '@renderinc/sdk/workflows'
export const summarizeDoc = task(
  { name: 'summarizeDoc', timeoutSeconds: 300,
    retry: { maxRetries: 3, waitDurationMs: 1000, backoffScaling: 2 } },
  async function summarizeDoc(ctx, doc) { /* ... */ })
```

## retry

Timeline with defaults: attempt 1 fails, wait 1 s, attempt 2 fails, wait 2 s, attempt 3 fails, wait 4 s,
attempt 4 fails, run failed (7 s of waiting).

| Setting | Waits | Total |
|---|---|---|
| 3 retries, 1000 ms, x2 | 1, 2, 4 s | 7 s |
| 3 retries, 1000 ms, x1.5 | 1, 1.5, 2.25 s | 4.75 s |
| 5 retries, 1000 ms, x2 | 1, 2, 4, 8, 16 s | 31 s |
| 0 retries | none | one attempt |

- **Trap (Python):** the SDK's `Retry` class defaults `backoff_scaling` to **1.5**, but the platform's default policy (no `retry` given) doubles. Always pass `backoff_scaling=2.0` explicitly if you want doubling. The TypeScript `backoffScaling` is optional and its default was not found.
- Retry **transient** failures (429, 503, network). Do not retry **permanent** ones (invalid input, bad key): it fails identically 4 times and you pay for each attempt.
- A retry runs the function again. Side effects need idempotency.
- Not documented: any cap on the wait, or random jitter.

## timeout_seconds

Set to about 3-5x the normal duration. A timeout counts as a failure and is retried, so a task that always hangs
can take about 4 x timeout (plus waits) to fail finally. Not verified: whether a parent's clock keeps running while it
waits for children (assume yes). Make a parent's timeout comfortably longer than its children's expected total.

## plan (compute size per run)

| plan | CPU / RAM | Cost |
|---|---|---|
| `flex` (default) | up to 1 CPU / 4 GB | $0.20 per CPU-hour used + $0.05 per GB-hour used (minimum charge: 1 s at 0.1 CPU, 0.1 GB) |
| `2c-4g` (old: `pro`) | 2 / 4 GB | $0.40/h |
| `2c-8g` | 2 / 8 GB | $0.70/h |
| `4c-8g` (old: `pro_plus`) | 4 / 8 GB | $1.00/h |
| `4c-16g` (old: `pro_max`) | 4 / 16 GB | $1.50/h |
| `8c-32g` (old: `pro_ultra`) | 8 / 32 GB | $2.50/h |

- `starter` and `standard` are discontinued and run as `flex`. Some SDK comments and docstrings still mention them; trust the docs.
- Render's own skill says larger plans (`pro_plus` and up) may require requesting access. Hobby workspaces: pricing page says plans "up to Pro" (unverified).
- Stay on `flex` unless a task runs out of memory or is CPU-bound. AI-API tasks mostly wait, which uses almost no CPU on `flex`.
- Worked cost: a 10 s run averaging 0.5 CPU and 0.5 GB on `flex` is about $0.00035. The same 10 s on `2c-4g` is about $0.0011.

## Function shape

- First parameter is always the context (`ctx`). Without it a task cannot call others.
- Other arguments must be JSON-serializable, 4 MB total per run. Defaults allowed.
- Return values are stored with inputs for 30 days ($0.25 per GB-month), so return small results.
- Parents that `await ctx.run(...)` must be `async`.
