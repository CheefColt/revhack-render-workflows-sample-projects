"""Start a launch-pack run and print the result.

Usage:
    python trigger.py https://your-product.example

Local testing (with `render workflows dev -- python main.py` running in another terminal):
    macOS / Linux:       RENDER_USE_LOCAL_DEV=true python trigger.py https://your-product.example
    Windows PowerShell:  $env:RENDER_USE_LOCAL_DEV="true"; python trigger.py https://your-product.example

Deployed: set RENDER_API_KEY (Render Dashboard > Account Settings > API Keys)
and WORKFLOW_SLUG (the slug shown on your workflow's page).

In a real app this call lives inside your API route: the route starts the run
and returns right away, and the page checks on it later. See README.
"""
import hashlib
import json
import os
import sys

from render import Render

slug = os.environ.get("WORKFLOW_SLUG", "launch-pack")
task = f"{slug}/generate_launch_pack"

if len(sys.argv) != 2:
    sys.exit("usage: python trigger.py <product-url>")
url = sys.argv[1]

# Same URL => same key => Render returns the existing run instead of starting
# a second one (safe to double-click or retry). Keys last 24 hours.
key = "pack-" + hashlib.sha256(url.encode()).hexdigest()[:24]

render = Render()  # reads RENDER_API_KEY, or uses the local server if RENDER_USE_LOCAL_DEV=true
run = render.workflows.run_task(task, [url], idempotency_key=key)

result = run.results[0] if run.results else {}
print(json.dumps(result, indent=2, ensure_ascii=False))
