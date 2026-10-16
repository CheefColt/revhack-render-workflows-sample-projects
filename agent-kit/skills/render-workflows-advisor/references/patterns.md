# Patterns

Short shapes to propose in an audit. For full, current SDK syntax use Render's `render-workflows` skill
and the starter kit templates (`launch-pack`, `site-health-checker`).

## 1. Start and poll (the API front door)

```
Browser  -> POST /api/review            API starts the task, returns { runId }  (instant)
Browser  -> GET  /api/review/:runId     API asks Render for the run, returns status/result
(task)   -> runs for 20-60 s on its own instance, retries on failure
```

Python client: `Render().workflows.start_task(slug, args)` then `get_task_run(run_id)`;
or `run_task(slug, args)` to wait. TypeScript: `new Render().workflows.startTask(...)` / `runTask(...)`.
Needs `RENDER_API_KEY` and the workflow slug in the API's environment. Pass an idempotency key
when starting so a double-click does not create two runs.

## 2. Orchestrator with fan-out (the workhorse)

```
check_sites(urls)                           parent: owns the plan
   validate and clean URLs first (cheap, no retries wasted)
   run probe_site for each URL, in batches   children: retries live here
   catch failures, trigger diagnose_failure only for failed sites
   run generate_report(results)              final synthesis step
   return { summary, results, report }
```

Python: `await asyncio.gather(*(ctx.run(probe_site, url) for url in batch), return_exceptions=True)`.
TypeScript: `await Promise.allSettled(urls.map(u => ctx.run(probeSite, u)))`.
Bound the fan-out in batches (the templates use 10–20) so one run does not start thousands at once.
Chained runs may only call tasks in the **same workflow service**.

## 3. Sequential steps

Plain `await`s in order: `page = await ctx.run(fetch_page, url)`, then fan out writers with that result,
then `await ctx.run(review_pack, page, pack)`.

## 4. Scheduled work

No native scheduling. A Render **cron job** runs a tiny script that starts the orchestrator task via the SDK.

## 5. Idempotent side effects

Key every external effect by something stable (order ID, document hash). Check or record before acting:
"already emailed order 42?" Write results by key (overwrite) rather than appending.

## 6. Many starts from the outside

Root-run starts are limited (Hobby: 50 per minute, over the limit returns 429 and is not queued). Start **one** root run that fans out
chained runs (limit 1,000 per minute) instead of 100 root runs from a frontend.

## What does not fit

Streaming a reply to a browser, receiving webhooks or any inbound request, long-lived connections,
anything that must answer within the same HTTP request.
