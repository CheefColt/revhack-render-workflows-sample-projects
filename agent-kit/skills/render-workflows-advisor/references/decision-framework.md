# Decision framework: workflow or API?

Facts checked against Render's docs on Oct 14, 2026 (public beta). Re-verify before relying on them.

## The one-line rule

**The API answers fast. The workflow does the slow, risky or parallel work.**
Your API stays: it receives requests, then *starts* a task and returns a run ID.

## Signals that point to a workflow (MOVE / SPLIT)

| Signal | Why it matters |
|---|---|
| Takes more than a few seconds | Long web requests hit browser, proxy or server timeouts |
| Calls an AI model, especially several times | Slow and flaky (429/503); retries help |
| Processes a list of N independent items | Fan out: the run takes about as long as the slowest item, not the sum |
| Multiple steps where later ones need earlier results | An orchestrator expresses this in plain code |
| Scrapes or calls third-party services | Flaky; per-item retries stop one failure losing everything |
| Needs more CPU/RAM than the API server has | Give that task a bigger `plan` |
| You are about to build a queue, worker, retry loop or status table | That is the plumbing Render provides |

## Signals to KEEP in the API

| Signal | Why |
|---|---|
| Must answer in the same request in well under a few seconds (login, simple reads, small writes) | A task adds start-up time and a poll |
| Streams output to the browser as it is generated | Tasks return a result when finished (unverified: no streaming to the browser is documented) |
| Must *receive* traffic (webhooks, callbacks) | Tasks cannot receive inbound requests |
| Holds user sessions or websockets | Not what tasks are for |

## Verdict cheat sheet

| Pattern in the project | Verdict |
|---|---|
| User clicks, then waits 20-60 s for several AI calls | SPLIT |
| Upload N files, process each, combine | SPLIT (fan-out) |
| Nightly refresh from many sources | CRON + MOVE |
| Show a list from the database | KEEP |
| One quick email after signup | SKIP (simple background job) |
| Chat reply streamed token by token | KEEP |

## Code smells (grep for these)

Python: `time.sleep`, `while True`, `threading`, `ThreadPoolExecutor`, `asyncio.gather` inside a route,
`celery`, `rq`, `dramatiq`, `tenacity`, `backoff`, `fastapi.BackgroundTasks`, `requests.post(... timeout=60+)`,
loops with a network call inside a request handler.

JavaScript/TypeScript: `setTimeout`/`setInterval` polling, `Promise.all` over many network calls in a route,
`bullmq`, `bull`, `agenda`, `node-cron`, `p-retry`, `p-limit`, long-running API routes,
a `status` or `jobs` table updated by a separate process.

Also: a route that takes `maxDuration`/long timeouts, a comment like "this can take a while",
"TODO: move to background", retry-with-sleep loops around API calls.

## Worked examples

**A. AI resume reviewer** (upload PDF, get a scored report): extract text, score 5 criteria with AI calls in
parallel, combine. 20-60 s, flaky AI calls, parallel parts. **SPLIT.** Orchestrator `review_resume(file_ref)`
calls `score_criterion` x5, catches failures, combines. API: accept upload, start task, return run ID; page polls.

**B. Campus events app:** show events from the database is **KEEP**. Refresh events from 30 club sites nightly is
**CRON + MOVE**: a cron job starts `refresh_events`, which fans out `scrape_club` (retry 2-3, tight timeout).
One broken site must not stop the rest.

**C. FAQ chatbot streaming one AI reply:** **KEEP** (streaming, instant feel). Indexing the FAQ documents is a
separate **MOVE** candidate.

**D. Welcome email after signup:** **SKIP.** One step, no fan-out.

## Check before moving anything: shared data

Tasks run on separate instances. If the process reads or writes a local file, a local SQLite file, or an in-memory cache
on the API server, moving it into a task breaks that. Plan a shared store (a database or object storage) first, and pass
IDs or links to tasks instead of data. This is often the real first step of the migration.

## Questions to ask the user when the code is not enough

1. How long does the slow step take today?
2. What does the user see while waiting?
3. What happens if one item in a batch fails?
4. Does anything send, charge or write externally?
5. Roughly how many items per run, and how many runs per minute at peak?
