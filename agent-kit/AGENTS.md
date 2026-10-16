# Render Workflows guidance for coding agents

Use this when the user asks whether, where or how to use Render Workflows, or when a project
has slow, multi-step, parallel or flaky work (AI calls, scraping, document processing).

Full instructions: `skills/render-workflows-advisor/SKILL.md` (read it, then the files in its `references/` as needed).

## The short version

1. **Map entry points** (routes, cron jobs, queue consumers, upload handlers) with file paths.
2. **Four-question test** for each process: slow (more than a few seconds)? multi-step or many independent items? flaky outside calls? must it answer instantly or receive traffic?
3. **One verdict each:** MOVE, KEEP, SPLIT (thin API starts the task, page polls), CRON + MOVE, or SKIP (single quick step).
4. **Design:** one orchestrator task calls child tasks (`ctx.run`) in parallel, catches child failures, keeps arguments small, puts retries on children.
5. **Report** in a table with reasons; do not edit code unless asked.

## Rules that prevent wrong answers

- Render retries a failed **run**. Do not claim runs "resume" mid-function, or that retried parents skip finished children (undocumented). Make side effects idempotent.
- Tasks cannot receive inbound requests, stream to a browser, or run on a built-in schedule (use a Render cron job).
- Root runs from outside are rate limited (Hobby 50 per minute, not queued). Start one root run that fans out.
- Defaults: `flex` plan, 3 retries (4 attempts), 1 s wait doubling, 2 h timeout. Python `Retry` defaults `backoff_scaling` to 1.5, so pass `2.0` explicitly if you want doubling.
- Your knowledge of the Render Workflows SDK may be outdated. Check the docs (https://render.com/docs/workflows) or installed SDK source before writing SDK code, and use Render's `render-workflows` skill for implementation (`npx skills add render-oss/skills`).
- The hackathon's $50 credit is Render credit; AI provider calls need the user's own key.
- On Windows, the Python SDK's local task server may not work (needs Unix sockets). Suggest TypeScript, WSL, or deploying directly.
- Mark anything unverified as unverified.
