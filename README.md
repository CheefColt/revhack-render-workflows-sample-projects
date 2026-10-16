# Render Workflows starter kit (RevHack)

Two small, working templates, each in **Python** and **TypeScript**, that show
**when and how to move slow or fragile work out of your API and into Render Workflows**.

| Template | What it does | Pattern it teaches |
|---|---|---|
| [`launch-pack/`](launch-pack) | Paste a product link, get a Reel script, WhatsApp message, X thread and cold email, fact-checked against your page | **Fan-out** (4 writers at once), retries, a judge step |
| [`site-health-checker/`](site-health-checker) | Check a list of website URLs for uptime, speed, and SSL health; automatically investigates broken sites with deep DNS/TCP/TLS diagnostics. **No AI needed.** | **Parallel batching**, smart retries vs. fast fails, conditional deep diagnosis, and summary reporting |

Pick a template, then a language. Each folder is self-contained (own
dependencies, own tests, own sample data) and the two languages behave identically.

```
launch-pack/python          launch-pack/typescript
site-health-checker/python  site-health-checker/typescript
agent-kit/                  skill + rules for Claude, Cursor and Codex: audits your project
                            and tells you which processes belong in a workflow
```

**Using an AI coding agent?** Start with [`agent-kit/`](agent-kit). It reads your project and
tells you what should be a workflow and what should stay in your API.

> Render Workflows is in **public beta** (Python and TypeScript SDKs). Details can change.
> Check the [official docs](https://render.com/docs/workflows) when in doubt.

---

## 1. The idea in 60 seconds

A **task** is one unit of work, written as a normal function. Render runs each
task run on its own machine, **retries it if it fails**, runs independent ones
**in parallel**, and bills per second of compute (nothing when idle).

Your **API still exists**. It is the front door that receives requests. What
changes is that it *starts* a task and returns immediately, instead of doing
the slow work itself.

**Move it to a workflow when it:** takes more than a few seconds, has several
steps, can be split into independent pieces, calls flaky outside services, or
you are tempted to build your own queue, worker or retry loop.

**Keep it in your API when it:** must answer instantly (login, simple reads),
does almost no work, or needs to *receive* traffic.

---

## 2. Quick start (offline, no keys, no cost)

You can run the tests on any OS without a Render account or API key. The
templates use a built-in **mock model** unless you provide a real key.
Open a template's language folder first, for example `cd launch-pack/python`.

### Python (3.10 or newer)

**macOS / Linux**
```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt pytest
pytest -q
```

**Windows (PowerShell)**
```powershell
py -m venv .venv
.venv\Scripts\Activate.ps1
pip install -r requirements.txt pytest
pytest -q
```
If PowerShell blocks the activate script, run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, then try again.

### TypeScript (Node 20 or newer)

The same commands work on macOS, Linux and Windows:
```bash
npm install
npm test
npm run typecheck
```

---

## 3. Run it for real

You need two things: a Render account, and your code in a **GitHub / GitLab / Bitbucket** repo.

### Use a real AI model (optional, launch-pack only)

`site-health-checker` needs **no AI at all** (and no API keys).

Set **one** key in the terminal where you run `render workflows dev` (and later
as an environment variable on your deployed workflow service):

- `GEMINI_API_KEY=...` (default model `gemini-3.8-flash`), or
- `ANTHROPIC_API_KEY=...` (default model `claude-haiku-5-5`), or
- `OPENAI_API_KEY=...` (default model `gpt-4o-mini`)

`LLM_MODEL` overrides the model name. `LLM_PROVIDER=mock` forces the free mock.

### Zero setup for site-health-checker

`site-health-checker` requires **no external API keys or credentials**. It performs standard outbound HTTP, DNS, and TLS checks directly against the URLs you give it.

> **The $50 hackathon credit is Render credit.** It pays for Render hosting and
> task compute. It does **not** pay for Gemini/Claude/OpenAI API calls, which need
> your own key and billing with that provider. Never put keys in your repo.

### Deploy

1. Push your project to GitHub, GitLab or Bitbucket (uncommitted changes are never deployed).
2. Render Dashboard > **New > Workflow**, connect the repo.
3. Set **Root Directory** to the language folder you chose, for example `launch-pack/typescript`, then:

   | | Language | Build Command | Start Command |
   |---|---|---|---|
   | Python | Python 3 | `pip install -r requirements.txt` | `python main.py` |
   | TypeScript | Node | `npm install` | `npm start` |

4. Add your model key under **Environment**. Click **Deploy Workflow**.
5. Open the workflow's **Tasks** page. You should see the tasks listed
   (launch-pack: 7, site-health-checker: 4). Use **Start Task** with a JSON array,
   for example `["https://your-product.example"]` for launch-pack, or
   `[["https://github.com", "https://render.com"]]` for site-health-checker.
6. From your own code: create an API key (Account Settings > API Keys), set
   `RENDER_API_KEY` and `WORKFLOW_SLUG` (your workflow's slug), then run the trigger script.

Choose the Python or Node runtime. **Docker workflows cannot use the local task server.**

### Task names

Python uses snake_case and TypeScript uses camelCase, as is usual in each
language. A task's slug is `{workflow-slug}/{task-name}`.

| Template | Task you trigger | Other tasks |
|---|---|---|
| launch-pack | `generate_launch_pack` / `generateLaunchPack` | `fetch_page`/`fetchPage`, `reel_script`/`reelScript`, `whatsapp_message`/`whatsappMessage`, `x_thread`/`xThread`, `cold_email`/`coldEmail`, `review_pack`/`reviewPack` |
| site-health-checker | `check_sites` / `checkSites` | `probe_site`/`probeSite`, `diagnose_failure`/`diagnoseFailure`, `generate_report`/`generateReport` |

The JSON you get back has identical keys and values in both languages.

---

## 4. Python vs TypeScript: the differences that matter

| | Python | TypeScript |
|---|---|---|
| Define a task | `@app.task` on a function | `task({ name, retry }, fn)` |
| Start the task server | you call `app.start()` | starts itself once tasks are registered |
| Where tasks go | anywhere before `app.start()` | **top level of the file, synchronously** (a task registered later, for example in a dynamic import, will not be available to run) |
| Run tasks in parallel | `asyncio.gather` | `Promise.all` / `Promise.allSettled` |
| Keep going if one fails | `gather(..., return_exceptions=True)` | `Promise.allSettled` |
| Tasks that call `ctx.run` | `async def` | `async function` |
| Test a task | call `task.func(ctx, ...)` with a stand-in context; you may replace `task.func` | same, but `task.func` is **read-only**, so fake the network layer underneath instead |

---

## 5. Limits and gotchas worth knowing

- **Rate limit:** the Hobby plan allows **50 new top-level runs per minute**.
  Extra requests get HTTP 429 and are **not queued**. Add your own throttling
  for demos.
- **4 MB cap** on the combined arguments of one run. Pass links or IDs, not big files.
- **Retries repeat work.** A task can run more than once, so anything with side
  effects (sending email, charging money) needs an **idempotency key** or a
  "did I already do this?" check. Both `launch-pack` and `site-health-checker` do
  safe, repeatable read/probe operations. If your custom tasks perform side effects,
  always pass an idempotency key.
- **Retry the flaky, not the hopeless.** Render retries any task that throws.
  `site-health-checker` automatically retries transient hiccups (timeouts, 5xx server errors)
  with exponential backoff, while permanent client errors (HTTP 404 Not Found) complete immediately
  without wasting retries.
- **Trigger-side idempotency:** passing an idempotency key to `run_task` /
  `runTask` makes a repeated trigger return the existing run for 24 hours. The
  trigger scripts use it.
- **One failing subtask throws an error to its parent** unless you catch it.
  Both templates catch it so one bad item does not lose the rest.
- **No built-in scheduling.** To run on a schedule, use a Render cron job that calls the task.
- **Tasks cannot receive inbound requests.** Keep a small web service as your front door.
- **Chained tasks must live in the same workflow service.**
- **Fetching user-supplied links is a security risk.** The launch-pack template
  refuses private and internal addresses, including ones reached by a redirect.
  Keep that check if you adapt it.
- Cost is per second of compute plus storage of inputs and results for 30 days.
  Check the [pricing page](https://render.com/docs/workflows-limits) for current numbers.

---

