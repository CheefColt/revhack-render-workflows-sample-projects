---
name: render-workflows-advisor
description: Audit a project and decide which processes should become Render Workflows tasks instead of API request handlers or hand-built queues and workers. Use when the user asks whether, where or how to use Render Workflows, when planning or reviewing an app with slow, multi-step, parallel or flaky work (AI calls, scraping, file or document processing, pipelines), or when they say "move this to a background job". For setup, scaffolding, SDK syntax and deploying, use Render's own render-workflows skill.
---

# Render Workflows advisor

You decide **what belongs in a workflow**. You do not teach SDK syntax from memory.

## Facts you must not guess

Render Workflows is in public beta and your built-in knowledge of it is likely
outdated. Before stating a limit, price, option name or SDK signature, check
`references/` here, then Render's docs (https://render.com/docs/workflows) or the
installed SDK source. If you cannot verify something, say so.

Never claim any of these (none is documented):
- that a crashed run "resumes where it left off", or that a retried parent skips
  already-finished children. Render **retries the failed run**; assume the function
  runs again from the top.
- that tasks can stream output to a browser, receive inbound requests, or run on a
  built-in schedule (they cannot receive requests; scheduling needs a Render cron job).

## Step 1. Map where work starts

Find every place work begins: HTTP routes/handlers, CLI scripts, cron/scheduled
jobs, queue consumers, webhooks, file-upload handlers. List them with file paths.
Read the README and dependency files first, then the handlers.

## Step 2. Score each process with the four-question test

| Question | Points toward a workflow when... |
|---|---|
| How long does it take? | more than a few seconds (e.g. several AI calls) |
| How many steps, and can any run side by side? | 2+ steps, or many independent items |
| Does it call flaky outside services? | AI APIs, scraping, third-party APIs, anything that can 429/503 |
| Must the user get the answer instantly, or must it receive traffic? | **No** → workflow is fine. **Yes** → keep it in the API. |

Also look for **code smells** that signal hand-built plumbing (full list in
`references/decision-framework.md`): sleep-and-poll loops, thread pools or
`asyncio.gather` inside request handlers, retry decorators, Celery/RQ/BullMQ,
`BackgroundTasks`, status tables updated by workers.

## Step 3. Give each process one verdict

- **MOVE**: becomes a workflow. Slow, multi-step, parallel or flaky, and the user can wait for or poll a result.
- **KEEP**: stays in the API. Instant reads/writes, auth, streaming replies, anything that must answer in the same request.
- **SPLIT**: thin API front door that *starts* the task and returns a run ID; the slow work moves. Most MOVE verdicts that a user triggers are really SPLIT.
- **CRON + MOVE**: scheduled job. A Render cron job starts one orchestrator task that fans out.
- **SKIP**: a single quick step (send one email, resize one image). A workflow is more than needed; a simple background job is fine.

If the project is a single quick step, say plainly that no workflow is needed.

## Step 4. Design the task graph for each MOVE or SPLIT

Use the **orchestrator pattern**: one parent task owns the plan, children do the work.
- Children: one per independent item or step. Put retries here.
- Parent: calls children with `ctx.run`, in parallel for independent items, and **catches child failures** so one bad item does not lose the rest.
- Keep arguments small (4 MB total per run): pass links or IDs, not file contents.
- Start many items from **one** root run that fans out, not many root runs (root-run starts are rate limited, chained runs have a far higher limit).
- **Bound the fan-out** for large lists: run in batches (the starter templates use 20), so one run does not start hundreds of children at once, and so you stay inside concurrency and AI-provider rate limits.
- **Shared data:** every run executes on its own instance. A local file, SQLite database or in-memory cache on the API server is **not visible** to a task, and files a task writes will not appear on the API server. Check where each task reads and writes data; if it is local, propose a shared store (a database, object storage) or have the task return a small result for the caller to save. Also check for secrets: environment variables must be set on the workflow service itself.
- Anything with side effects (email, payment, writes) needs an **idempotency key** or a "did I already do this?" check, because retries run the function again.

For each task suggest `retry`, `timeout_seconds` and `plan` using `references/task-options.md`.
Default to `flex`. Retry transient failures, not permanent ones (bad input retried 4 times just wastes time and money).

## Step 5. Write the report

Use exactly this shape, concise, in the user's language:

```
## Workflow audit: <project name>

**Bottom line:** <one or two sentences: how many processes, which move, which stay>

| # | Process (file) | Verdict | Why (which signals) |
|---|---|---|---|

### Proposed tasks (for each MOVE / SPLIT / CRON + MOVE)
- Orchestrator: `<name>(args)` - what it does, children it calls, how it handles child failure
- Children: `<name>` - purpose, suggested retry / timeout / plan
- API change: what the endpoint starts and what the page polls
- Idempotency: what needs a key and what key to use
- Risks / unknowns: anything not verified

### Keep in the API
<list with one-line reasons>

### Next steps
1. <smallest first step>
2. For implementation, use Render's `render-workflows` skill.
```

## Rules

- Audit first. **Do not edit the user's code** unless they ask you to implement.
- Cite file paths for every claim about the project. Do not describe code you have not read.
- Prefer fewer, clearer tasks over many tiny ones. A task with milliseconds of work gains little from its own instance.
- Mark anything you inferred rather than verified as **(unverified)**.
- Money: the hackathon's $50 credit is **Render credit** (hosting and task compute). AI provider API calls need the user's own key and billing.
- Windows: the Python SDK's local task server needs Unix sockets, which Python on Windows may lack. If `render workflows dev -- python main.py` exits with status 1 on Windows, suggest the TypeScript version, WSL, or deploying directly.

## Where to look

- `references/decision-framework.md`: signals, code smells, worked examples
- `references/task-options.md`: `plan`, `retry`, `timeout_seconds`, `name`, with traps
- `references/patterns.md`: orchestrator, fan-out, start-and-poll, cron, with code
- `references/pitfalls-and-errors.md`: symptom to cause to fix
- `references/limits-and-pricing.md`: limits, rate limits, plans, cost examples
- Render's `render-workflows` skill (`npx skills add render-oss/skills`) for scaffolding, SDK use, local dev and deploy
