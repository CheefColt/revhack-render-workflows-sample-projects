# Site Health Checker (Render Workflows Starter)

> **Site Health Checker** is like an automated doctor for your websites.
> 
> You give it a list of website links, and it tests their pulse—checking whether each site is online, how fast it loads, and if its security certificates are healthy. If a site is broken, it doesn't just say "failed"; it automatically diagnoses the root cause (DNS crash, refused connection, or expired SSL) and generates a clean checkup report with recommended fixes. Zero API keys or setup required.

A beginner-friendly template in **TypeScript** and **Python** demonstrating how to run parallel checks, smart retries, and automatic troubleshooting using Render Workflows.

---

## What does all the jargon mean?

If you saw terms like *"fan-out bounded parallelism"* or *"conditional dynamic triage"*, here is what they actually mean in everyday language:

| Big Tech Term | What It Actually Means | Why It's Great in a Workflow |
|---|---|---|
| **Bounded Parallelism** *(Fan-Out)* | **Checking sites at the same time in safe batches.** | If you test 50 websites one by one in a normal script, it could take several minutes. Here, it tests up to 10 sites at once. The whole check finishes in seconds without overloading your connection. |
| **Smart Retries vs. Fast Fail** | **Retrying glitches, but skipping hopeless errors.** | If a site has a temporary hiccup (like a network timeout or a 503 server busy error), Render retries it automatically. But if it gets a 404 ("Not Found"), it stops right away so it doesn't waste time retrying a link that doesn't exist. |
| **Conditional Triage** *(Branching)* | **Only calling the doctor when a site is actually sick.** | Healthy sites move on immediately. If a site fails, the workflow automatically spins up a "deep diagnosis" task that checks DNS, TCP, and TLS connections to pinpoint the exact failure. |
| **Synthesis & Reporting** *(Fan-In)* | **Collecting all the pieces into one final report.** | Once all website checks and diagnoses finish, a final step gathers all the results, calculates your average uptime and latency, flags certificates expiring soon, and creates a neat Markdown report. |

---

## How It Works (Step-by-Step)

```
                     checkSites (The Boss / Orchestrator)
                                   │
              ┌────────────────────┴────────────────────┐
              │                                         │
   1. [ probeSite x N ]                      2. [ diagnoseFailure x M ]
      (Test all sites in batches)               (Investigate broken sites)
      • Is it online?                           • Did DNS lookup fail?
      • How fast did it load?                   • Did TCP connection fail?
      • Are SSL certificates valid?             • Did TLS/SSL handshake fail?
      • Retries on temporary glitches           • ONLY runs for sites that failed!
              │                                         │
              └────────────────────┬────────────────────┘
                                   │
                      3. generateReport (The Reporter)
                         • Calculates overall uptime %
                         • Shows response times (p50, p95, max)
                         • Flags SSL certificates expiring in ≤ 30 days
                         • Outputs a clean Markdown & JSON summary
```

---

## 1. Quick Start (Run Offline Tests)

You can run the offline tests immediately on your machine without an internet connection or a Render account. The tests use mock data to verify all logic instantly.

### TypeScript (Node 20+)
```bash
cd site-health-checker/typescript
npm install
npm test
npm run typecheck
```

### Python (3.10+)
```bash
cd site-health-checker/python
python -m venv .venv

# On Windows (PowerShell):
.venv\Scripts\Activate.ps1
# On macOS / Linux:
# source .venv/bin/activate

pip install -r requirements.txt pytest pytest-asyncio
pytest -q
```

---

## 2. Deploying to Render

When you are ready to run this in the cloud:

1. Push your repository to GitHub, GitLab, or Bitbucket.
2. Go to the [Render Dashboard](https://dashboard.render.com) and click **New > Workflow**.
3. Connect your repository.
4. Set the **Root Directory** to either:
   - `site-health-checker/typescript` OR
   - `site-health-checker/python`
5. Configure the build and start commands:
   - **TypeScript**: Build: `npm install` | Start: `npm start`
   - **Python**: Build: `pip install -r requirements.txt` | Start: `python main.py`
6. Click **Deploy Workflow**.
7. Once deployed, open your workflow's **Tasks** tab, click **Start Task** on `checkSites` (or `check_sites`), and supply a JSON array of URLs:
   ```json
   [["https://github.com", "https://render.com", "https://expired.badssl.com", "https://httpstat.us/404"]]
   ```

---

## 3. What the Final Report Looks Like

Here is an example of the actual report generated at the end of every run:

### 🌐 Site Fleet Reliability Report
> *Generated across 16 monitored endpoints.*

#### 📊 Fleet Status Overview
| Total Sites | 🟢 Healthy | 🟡 Slow | 🔴 Down | ⚪ 4xx Client Error | Overall Uptime |
|:---:|:---:|:---:|:---:|:---:|:---:|
| **16** | **12** | **1** | **2** | **1** | **81.3%** |

#### ⚡ Response Times (Healthy Endpoints)
| Fastest | Median (p50) | 95th Percentile | Slowest | Average |
|:---:|:---:|:---:|:---:|:---:|
| 84 ms | 142 ms | 1,850 ms | 2,100 ms | 310 ms |

#### 🚨 Active Incidents & Root-Cause Diagnosis
| Status | Target URL | Failure Stage | Root Cause | Recommended Action |
|:---:|:---|:---:|:---|:---|
| 🔴 **DOWN** | `https://expired.badssl.com` | **TLS** | `SSL_CERTIFICATE_EXPIRED`<br>*(Certificate has expired)* | Renew the TLS/SSL certificate immediately with Let's Encrypt. |
| 🔴 **DOWN** | `https://this-domain-will-fail-dns.org` | **DNS** | `DNS_RESOLUTION_FAILED`<br>*(Domain not found / ENOTFOUND)* | Check domain registration or DNS nameservers. |
| ⚪ **CLIENT** | `https://httpstat.us/404` | **HTTP** | `CLIENT_ERROR`<br>*(HTTP 404 Not Found)* | Verify the endpoint URL path. |

