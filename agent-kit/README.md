# Agent kit: let your coding agent decide what should be a workflow

Your agent reads your project and tells you **which processes belong in Render Workflows and which should stay in your API**,
with reasons and a proposed task design. It audits first and changes nothing until you ask.

```
agent-kit/
  skills/render-workflows-advisor/   the skill (SKILL.md + references/)
  AGENTS.md                          for Codex and other agents that read AGENTS.md
  .cursor/rules/render-workflows.mdc for Cursor
  CLAUDE.md                          snippet for Claude Code
  prompts/audit-my-project.md        copy-paste prompts
```

## Install

Copy the folders you need into **your own project**. These install steps come from general knowledge of each tool and have not been tested by us; check the tool's current docs if something does not load.

| Agent | What to copy | Where |
|---|---|---|
| **Claude Code** | `skills/render-workflows-advisor/` | `.claude/skills/render-workflows-advisor/` (project) or `~/.claude/skills/` (all projects). Optionally paste `CLAUDE.md` into your project's `CLAUDE.md`. |
| **Claude (web/desktop)** | zip the `render-workflows-advisor` folder | Settings, then Skills, upload (check the current UI) |
| **Cursor** | `.cursor/rules/render-workflows.mdc` and the `skills/` folder | Your project root, keeping both paths |
| **Codex / others** | `AGENTS.md` and the `skills/` folder | Your project root |

Also install **Render's own skill** for scaffolding, SDK syntax, local dev and deployment:
`npx skills add render-oss/skills` (or `render skills install`). Our skill decides *what* to build; Render's explains *how*.

## Use

Open your agent in your project and paste a prompt from `prompts/audit-my-project.md`, for example:

> Use the render-workflows-advisor skill to audit this project. Which processes should become Render Workflows tasks, and which should stay in the API?

No code yet? Describe your idea in one or two sentences (prompt 2).

## What the skill knows (and is careful about)

- A four-question test, and five verdicts: MOVE, KEEP, SPLIT, CRON + MOVE, SKIP
- Orchestrator and fan-out design, retries, timeouts and compute plans
- Common errors and fixes, limits and prices (checked Oct 14, 2026, Render Workflows is in public beta)
- It will not claim things Render does not document (for example, that a crashed run resumes mid-function)

## Limits of this kit

An agent's answer is advice, not proof. Check its reasoning against the Render docs,
and tell the organizers if something here is wrong.
