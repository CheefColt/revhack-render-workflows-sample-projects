/**
 * Start a launch-pack run and print the result.
 *
 * Usage:
 *     npm run trigger -- https://your-product.example
 *
 * Local testing (with `render workflows dev -- npm start` running in another
 * terminal), set RENDER_USE_LOCAL_DEV=true in this terminal first:
 *     macOS / Linux:       RENDER_USE_LOCAL_DEV=true npm run trigger -- https://your-product.example
 *     Windows PowerShell:  $env:RENDER_USE_LOCAL_DEV="true"; npm run trigger -- https://your-product.example
 *
 * Deployed: set RENDER_API_KEY (Render Dashboard > Account Settings > API Keys)
 * and WORKFLOW_SLUG (the slug shown on your workflow's page).
 *
 * In a real app this call lives inside your API route: the route starts the
 * run and returns right away, and the page checks on it later. See README.
 */
import { createHash } from 'node:crypto'

import { Render } from '@renderinc/sdk'

const slug = process.env.WORKFLOW_SLUG ?? 'launch-pack'
const taskSlug = `${slug}/generateLaunchPack`

const url = process.argv[2]
if (process.argv.length !== 3 || !url) {
  console.error('usage: npm run trigger -- <product-url>')
  process.exit(1)
}

// Same URL => same key => Render returns the existing run instead of starting
// a second one (safe to double-click or retry). Keys last 24 hours.
const idempotencyKey = 'pack-' + createHash('sha256').update(url).digest('hex').slice(0, 24)

const render = new Render() // reads RENDER_API_KEY, or uses the local server if RENDER_USE_LOCAL_DEV=true
const run = await render.workflows.runTask(taskSlug, [url], { idempotencyKey })

console.log(JSON.stringify(run.results?.[0] ?? {}, null, 2))
