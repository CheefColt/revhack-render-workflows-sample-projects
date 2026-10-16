# Launch-Pack Generator (Render Workflows Starter)

> **Launch-Pack Generator** is like having an automated marketing agency in a box.
> 
> You paste a link to your product or landing page, and it reads your website, writes launch content across 4 different marketing channels at the exact same time (an Instagram Reel script, a WhatsApp message, an X/Twitter thread, and a cold email), and then fact-checks every single draft against your real page so the AI never makes up fake features or false promises.

A beginner-friendly template in **TypeScript** and **Python** demonstrating how to run parallel AI tasks, isolated retries, and a quality-control judge step using Render Workflows.

---

## What does all the jargon mean?

If you're wondering why this should be a Render Workflow instead of a normal script or API endpoint, here is how the architectural patterns work in everyday terms:

| Big Tech Term | What It Actually Means | Why It's Great in a Workflow |
|---|---|---|
| **Fan-Out Parallelism** | **Running all 4 writers at the exact same time.** | Calling an AI model 4 times in a row would take 30–60 seconds, which freezes normal web apps. In a workflow, all 4 writers run side-by-side on independent worker machines in seconds. |
| **Isolated Retries** | **Retrying only the single piece that glitched.** | AI APIs occasionally hit rate limits or timeout errors. If the cold email writer fails, Render retries *only* the cold email. It never wastes time or tokens re-reading your webpage or re-running the other 3 writers. |
| **Partial Failure Resilience** | **Never losing good work.** | If one writer fails completely after retries, the workflow doesn't crash. It delivers the 3 successful drafts along with an error note for the failed one. |
| **Fan-In Judge / Fact-Check** | **A strict quality-control reviewer at the end.** | Once all 4 writers finish, a final reviewer task reads all drafts side-by-side with your original webpage text to flag any hallucinations or unsupported claims. |

---

## How It Works (Step-by-Step)

```
                    generate_launch_pack (The Orchestrator)
                                      │
                                1. fetch_page
                           (Reads your product URL)
                                      │
            ┌────────────────┬────────┴───────┬────────────────┐
            │                │                │                │
      2a. reel_script  2b. whatsapp_msg  2c. x_thread    2d. cold_email
        (20s Video)      (Quick pitch)    (4-post thread)   (Club lead)
            │                │                │                │
            └────────────────┼────────┬───────┴────────────────┘
                                      │
                                3. review_pack
                          (Strict AI Fact-Checker)
                         • Compares drafts vs page text
                         • Flags unsupported claims
```

---

## 1. Quick Start (Run Offline Tests)

You can run the offline tests immediately on your computer without any Render account, credit card, or external API keys. The template includes a **free built-in mock model** that simulates AI responses instantly.

### TypeScript (Node 20+)
```bash
cd launch-pack/typescript
npm install
npm test
npm run typecheck
```

### Python (3.10+)
```bash
cd launch-pack/python
python -m venv .venv

# On Windows (PowerShell):
.venv\Scripts\Activate.ps1
# On macOS / Linux:
# source .venv/bin/activate

pip install -r requirements.txt pytest
pytest -q
```

---

## 2. Using a Real AI Model (Optional)

By default, the template uses the free built-in mock. When you're ready to use real AI models, set **one** of these environment variables:

- **Google Gemini**: `GEMINI_API_KEY=AIzaSy...` (uses `gemini-3.8-flash` by default)
- **Anthropic Claude**: `ANTHROPIC_API_KEY=sk-ant-...` (uses `claude-haiku-5-5` by default)
- **OpenAI**: `OPENAI_API_KEY=sk-...` (uses `gpt-4o-mini` by default)

*(You can override the model name with `LLM_MODEL=your-model-name`.)*

---

## 3. Deploying to Render

When you are ready to run this live in the cloud:

1. Push your repository to GitHub, GitLab, or Bitbucket.
2. Go to the [Render Dashboard](https://dashboard.render.com) and click **New > Workflow**.
3. Connect your repository.
4. Set the **Root Directory** to either:
   - `launch-pack/typescript` OR
   - `launch-pack/python`
5. Configure the build and start commands:
   - **TypeScript**: Build: `npm install` | Start: `npm start`
   - **Python**: Build: `pip install -r requirements.txt` | Start: `python main.py`
6. Under **Environment**, add your `ANTHROPIC_API_KEY` or `OPENAI_API_KEY` (or leave blank to use the mock model).
7. Click **Deploy Workflow**.
8. In the Render Dashboard under **Tasks**, click **Start Task** on `generate_launch_pack` (or `generateLaunchPack`) and supply your product URL in a JSON array:
   ```json
   ["https://render.com"]
   ```

---

## 4. What the Final Output Looks Like

At the end of each run, the workflow returns the marketing pack and the fact-check verdict:

### 📢 Generated Launch Pack

| Channel | Format | Sample Draft |
|---|---|---|
| **Instagram Reel** | 20-second video script | **Hook:** Stop sharing lecture notes across 10 messy WhatsApp groups.<br>**Beat 1:** Upload your syllabus and collaborate in one place.<br>**Beat 2:** Search peer-verified notes before exam week.<br>**CTA:** Tap the link to join your campus workspace. |
| **WhatsApp** | Forwardable text | *Hey guys, check out StudyHub for our semester notes: https://example.com/study-hub. Verified summaries without messy group chats.* |
| **X (Twitter)** | 4-post thread | **1/4** College note-sharing is broken across dead group chats.<br>**2/4** We built StudyHub to organize verified notes in one shared workspace.<br>**3/4** Tested with 200+ students during midterms.<br>**4/4** Try it free: https://example.com/study-hub |
| **Cold Email** | Lead outreach (<90 words) | **Subject:** Note sharing tool for your student club<br><br>Hi Alex, saw you're leading the CS chapter. We built StudyHub to help batchmates organize class notes without spamming chat groups. Would love your feedback: https://example.com/study-hub |

### 🛡️ Fact-Check Review (Quality Control)

- **Verdict:** `No unsupported claims.`
- **Status:** 🟢 **Clean** — every feature and number cited in the drafts was verified against your live landing page.

<details>
<summary><b>Click to view raw JSON response</b></summary>

```json
{
  "source": {
    "url": "https://example.com/study-hub",
    "title": "StudyHub: Collaborative Notes for College Students"
  },
  "pack": [
    { "channel": "reel_script", "content": "HOOK: Stop sharing lecture notes..." },
    { "channel": "whatsapp_message", "content": "Hey guys, check out StudyHub..." },
    { "channel": "x_thread", "content": "1/4 College note-sharing is broken..." },
    { "channel": "cold_email", "content": "Subject: Note sharing tool..." }
  ],
  "failed": [],
  "review": {
    "clean": true,
    "verdict": "No unsupported claims."
  }
}
```
</details>
