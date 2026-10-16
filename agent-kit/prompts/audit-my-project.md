# Copy-paste prompts

## 1. Audit my project

```
Use the render-workflows-advisor skill to audit this project. Find every place work starts
(routes, cron jobs, upload handlers, queue consumers), then tell me which processes should become
Render Workflows tasks, which should stay in the API, and why. Use file paths. Don't change any code yet.
```

## 2. I only have an idea (no code yet)

```
My project idea: <one or two sentences>. Use the render-workflows-advisor skill. What should be a
workflow and what should stay in the API? Propose the tasks (orchestrator and children) and what the
API should do.
```

## 3. Implement what you proposed

```
Implement the first workflow from your audit. Use Render's render-workflows skill for scaffolding and SDK
syntax, check the installed SDK before writing code, and add a test for the failure case (one child fails,
the rest still return).
```

## 4. Review my workflow code

```
Review my Render Workflows tasks for: side effects without idempotency, retries on permanent errors,
orchestrators that throw late, large arguments (4 MB cap), tasks defined somewhere other than module top level
(TypeScript), and missing error handling around child runs.
```
