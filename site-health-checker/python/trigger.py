"""Trigger the Site Reliability & Health Suite workflow.

Usage:
    python trigger.py sample/sites.json

Local testing (with `render workflows dev -- python main.py` running in another terminal):
    macOS / Linux:       RENDER_USE_LOCAL_DEV=true python trigger.py sample/sites.json
    Windows PowerShell:  $env:RENDER_USE_LOCAL_DEV="true"; python trigger.py sample/sites.json

Deployed: set RENDER_API_KEY and WORKFLOW_SLUG (see README).
"""
import hashlib
import json
import os
import pathlib
import sys
import time

from render import Render

slug = os.environ.get("WORKFLOW_SLUG", "site-health-checker")
task = f"{slug}/check_sites"

file_path = sys.argv[1] if len(sys.argv) > 1 else "sample/sites.json"

try:
    content = pathlib.Path(file_path).read_text(encoding="utf-8")
    urls = json.loads(content)
    if not isinstance(urls, list):
        raise ValueError("sites file must contain a JSON array of URLs")
except Exception as e:
    sys.exit(f"Failed to load {file_path}: {e}")

# Generate idempotency key based on URL list and current 5-minute bucket
bucket = int(time.time() // 300)
key = "health-" + hashlib.sha256((json.dumps(urls) + str(bucket)).encode()).hexdigest()[:24]

print(f"Starting site health check workflow across {len(urls)} endpoints...")
render = Render()
run = render.workflows.run_task(task, [urls], idempotency_key=key)

result = run.results[0] if run.results else {}
if isinstance(result, dict) and "summaryMarkdown" in result:
    print("\n" + result["summaryMarkdown"])
else:
    print(json.dumps(result, indent=2, ensure_ascii=False))
