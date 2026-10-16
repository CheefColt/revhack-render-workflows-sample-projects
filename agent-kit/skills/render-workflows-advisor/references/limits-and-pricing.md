# Limits and pricing

Source: Render docs (render.com/docs/workflows-limits, render.com/pricing), Render's `render-workflows` skill, and
the SDKs. Public beta, checked Oct 14, 2026. **Re-verify before quoting numbers.**

## Two different "plans"

| Layer | Values | Controls |
|---|---|---|
| Workspace plan (account) | Hobby ($0/mo), Pro ($25/mo), Scale ($499/mo), Enterprise (custom); plus compute | Rate limits, concurrent runs, seats, log retention |
| Task compute `plan` (per task) | `flex`, `2c-4g`, `2c-8g`, `4c-8g`, `4c-16g`, `8c-32g` | Machine size and billing for one run |

## Per-workspace limits

| | Hobby | Pro | Scale |
|---|---|---|---|
| Root-run starts per minute | 50 | 1,500 | not found |
| Concurrent task runs (base) | 20 | 50 (+50 for $10/mo) | 100 |
| New compute per minute | 16 CPU / 64 GB | 32 CPU / 128 GB | 32 CPU / 128 GB (Pro or higher) |
| Log retention | 7 days | 14 days | 30 days |
| Seats | 1 | unlimited | unlimited |

- Over the root-run rate limit: HTTP **429, not queued**.
- Chained runs (`ctx.run`): 1,000 per minute; over the limit the call fails, not queued.
- Over compute limits: runs are **queued** and start as resources free up.
- Docs pages disagreed on concurrency wording; Render's skill says base concurrency is 20-100 depending on plan.
  Test before promising a number.

## Per-run and per-service limits

- Arguments: 4 MB total per run
- Timeout: 30 s to 24 h, default 2 h
- Task definitions: 500 per workflow service
- Task inputs and results are retained 30 days at $0.25 per GB-month
- Start-up: each run gets its own instance, "within seconds"

## Compute pricing

See `task-options.md` for the plan table. `flex` bills actual CPU and RAM use per second; fixed plans bill the
whole run at a flat hourly rate. Outbound traffic counts against workspace bandwidth.

## Not supported / not found

- Native scheduling (use a cron job)
- Blueprints (render.yaml) for Workflows (per Render's skill: create via the Dashboard)
- Docker workflows cannot use the local task server
- No free tier was found for workflow compute; the hackathon credit is **Render credit** and does not pay for AI provider APIs
