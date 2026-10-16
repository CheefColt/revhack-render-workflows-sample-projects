# Pitfalls and errors

Confidence: **Seen** (happened in this project), **Documented** (Render docs), **Inferred** (reasoned, verify).

| Symptom | Likely cause | Fix | Confidence |
|---|---|---|---|
| `exec: "--debug": executable file not found` | A CLI flag was placed after `--`; everything after `--` is the start command | `render workflows dev --port 8121 -- python main.py` (flags before `--`) | Seen |
| `failed to load tasks: start command exited before registering tasks: exit status 1` on **Windows with Python** | Python SDK needs Unix sockets; check `python -c "import socket; print(hasattr(socket,'AF_UNIX'))"`. `False` confirms it. | Use the TypeScript template, WSL, or deploy to Render directly. Offline tests still run. | Seen and confirmed on one machine |
| Same error on macOS/Linux | Packages missing in the venv, wrong folder, or an import error | `pip install -r requirements.txt`; run `render workflows dev --debug -- python main.py` to see the child's output | Inferred |
| `Expected ',' or ']' after array element in JSON` in Start Task | Payload is not a JSON array, e.g. `["url":"..."]` | `["https://example.com"]` | Seen |
| `list indices must be integers or slices, not str` | Wrong nesting of arguments | One document: `[{...}]`. A list of documents (as one argument): `[[{...},{...}]]` | Seen |
| Output looks like placeholder text | No model key in the **deployed** service's environment, so the mock model ran | Add the key under the workflow's Environment and redeploy. A local shell variable does not reach tasks on Render. | Documented / Seen |
| `page had no readable text` / HTTP error from a fetch task | JavaScript-rendered or bot-blocking site | Try a simpler public page | Inferred |
| `URL points to a private or internal address` | SSRF guard refused it (intended) | Use a public URL | Seen in tests |
| HTTP 429 when starting runs | Root-run rate limit (Hobby 50/min), not queued | One root run that fans out; or throttle | Documented |
| Tasks missing in the dashboard | Wrong Root Directory/build/start command; crash at import; TypeScript tasks not defined synchronously at top level | Check deploy logs | Inferred / Documented (TS rule) |
| Run fails after a long time | Timeout (default 2 h) retried up to 4 times | Set a realistic `timeout_seconds` | Documented |
| Out-of-memory failure | More than `flex`'s 4 GB | Bigger `plan` | Inferred |
| Duplicate emails/charges | Retry re-ran a non-idempotent side effect | Idempotency key or "already done?" check | Documented advice |
| Run "succeeded" but items are missing | Parent caught child errors and reported them in a `failed` list | Read the result's `failed` field | Seen (template design) |
| Task cannot see data the API has, or the API cannot see what a task wrote | Each run has its own instance, so local files, a local SQLite file or in-memory state are not shared between the API and tasks | Use a shared database or object storage; pass IDs, not data | Documented (own instance per run); consequence inferred |
| Whole run repeats work and cost | The orchestrator itself threw and was retried by default policy | Keep orchestrators from throwing late; consider fewer orchestrator retries | Documented behavior; our templates keep the default |
| Wrong backoff (x1.5 instead of x2) | Python `Retry` defaults `backoff_scaling` to 1.5 | Pass `backoff_scaling=2.0` | Seen in SDK source |

## Not documented (do not assert)

- Whether a retried parent re-runs children that already finished.
- Crash recovery beyond "failure triggers the retry policy".
- Whether a timeout applies per attempt or across attempts (assume per attempt).
- Whether the parent's timeout clock runs while waiting on children (assume yes).
- Whether `ctx.run` raises only after the child's retries are exhausted. It does raise `TaskRunError` when the child run fails (documented), and retries presumably happen first.

## Escalate to Render or the organizers

Anything that looks like a platform bug, account/plan questions, how the hackathon credit is applied, and whether Workflows are required for the hackathon.
