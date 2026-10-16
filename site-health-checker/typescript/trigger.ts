/**
 * Trigger the Site Reliability & Health Suite workflow.
 *
 * Usage:
 *     npm run trigger -- sample/sites.json
 *
 * Local testing (with `render workflows dev -- npm start` running in another terminal):
 *     macOS / Linux:       RENDER_USE_LOCAL_DEV=true npm run trigger -- sample/sites.json
 *     Windows PowerShell:  $env:RENDER_USE_LOCAL_DEV="true"; npm run trigger -- sample/sites.json
 *
 * Deployed: set RENDER_API_KEY and WORKFLOW_SLUG (see README).
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { Render } from '@renderinc/sdk'

const slug = process.env.WORKFLOW_SLUG ?? 'site-health-checker'
const taskSlug = `${slug}/checkSites`

const filePath = process.argv[2] ?? 'sample/sites.json'

let urls: string[] = []
try {
  const content = readFileSync(filePath, 'utf-8')
  urls = JSON.parse(content)
  if (!Array.isArray(urls)) {
    throw new Error('sites file must be a JSON array of strings')
  }
} catch (err: any) {
  console.error(`Failed to read sites list from ${filePath}: ${err.message}`)
  process.exit(1)
}

// Generate idempotency key based on URL list and current 5-minute bucket
const bucket = Math.floor(Date.now() / (5 * 60 * 1000))
const idempotencyKey =
  'health-' +
  createHash('sha256')
    .update(JSON.stringify(urls) + bucket)
    .digest('hex')
    .slice(0, 24)

console.log(`Starting site health check workflow across ${urls.length} endpoints...`)
const render = new Render() // reads RENDER_API_KEY, or local dev if RENDER_USE_LOCAL_DEV=true
const run = await render.workflows.runTask(taskSlug, [urls], { idempotencyKey })

const result = run.results?.[0]
if (result && typeof result === 'object' && 'summaryMarkdown' in result) {
  console.log('\n' + (result as any).summaryMarkdown)
} else {
  console.log(JSON.stringify(result ?? {}, null, 2))
}
