"""Launch-pack generator: a Render Workflows template.

You give it a link to your product. It reads the page, then writes a launch
pack (Reel script, WhatsApp message, X thread, cold email) IN PARALLEL, and
finally runs a quick fact-check so nothing claims more than the page says.

Why this is a workflow and not one API endpoint:
  * It takes 10-60 seconds (page fetch + several model calls). A web request
    should not wait that long.
  * The four writers are independent, so they run at the same time, each on
    its own machine, each with its own retries.
  * Model APIs fail sometimes. A failed writer retries by itself without
    redoing the page fetch or the other writers.

Shape of the run:

    generate_launch_pack
        |-- fetch_page                     (1 step, retried on network errors)
        |-- [ reel_script | whatsapp_message | x_thread | cold_email ]  parallel
        '-- review_pack                    (fact-check against the page)

Run locally:   render workflows dev -- python main.py
(`python main.py` on its own will not work: the Render CLI supplies the
environment the SDK needs.)
"""
import asyncio
import ipaddress
import socket
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser

from render import Retry, TaskContext, Workflows

import llm

# Defaults mirror Render's own: 3 retries, 1s first wait, doubling each time.
app = Workflows(
    default_retry=Retry(max_retries=3, wait_duration_ms=1000, backoff_scaling=2.0),
    default_timeout=300,
)

MAX_PAGE_CHARS = 6000  # keep prompts small and arguments far below the 4 MB limit


# ---------- helpers (plain functions, not tasks) ----------

class _TextExtractor(HTMLParser):
    def __init__(self):
        super().__init__()
        self.title = ""
        self._in_title = False
        self._skip = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style", "noscript"):
            self._skip += 1
        if tag == "title":
            self._in_title = True

    def handle_endtag(self, tag):
        if tag in ("script", "style", "noscript") and self._skip:
            self._skip -= 1
        if tag == "title":
            self._in_title = False

    def handle_data(self, data):
        text = data.strip()
        if not text:
            return
        if self._in_title:
            self.title += text
        elif not self._skip:
            self.parts.append(text)


def _assert_public_url(url: str) -> None:
    """Refuse non-http(s) and private/internal addresses.

    A task runs inside Render's private network. Without this check, a user
    could submit http://some-internal-service and read it back (SSRF). We also
    check every redirect hop. This does not defend against DNS rebinding; fine
    for a template, use an egress proxy if you handle untrusted traffic at scale.
    """
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        raise ValueError("URL must start with http:// or https://")
    try:
        infos = socket.getaddrinfo(parsed.hostname, None)
    except socket.gaierror as e:
        raise ValueError(f"could not resolve host {parsed.hostname!r}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if not ip.is_global or ip.is_multicast:
            raise ValueError("URL points to a private or internal address")


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Do not follow redirects automatically: we check each hop ourselves."""

    def redirect_request(self, *args, **kwargs):
        return None


_opener = urllib.request.build_opener(_NoRedirect)
MAX_REDIRECTS = 5


def _read_page(url: str) -> str:
    for _ in range(MAX_REDIRECTS + 1):
        _assert_public_url(url)
        req = urllib.request.Request(url, headers={"User-Agent": "revhack-launch-pack/1.0"})
        try:
            with _opener.open(req, timeout=20) as resp:
                return resp.read(1_000_000).decode("utf-8", errors="replace")
        except urllib.error.HTTPError as e:
            if e.code in (301, 302, 303, 307, 308):
                location = e.headers.get("Location")
                if not location:
                    raise ValueError("redirect without a Location header") from e
                url = urllib.parse.urljoin(url, location)
                continue
            raise
    raise ValueError("too many redirects")


# ---------- tasks ----------

@app.task(timeout_seconds=60)
def fetch_page(ctx: TaskContext, url: str) -> dict:
    """Download a page and return {url, title, text}. Retried on failure."""
    raw = _read_page(url)
    parser = _TextExtractor()
    parser.feed(raw)
    text = " ".join(parser.parts)[:MAX_PAGE_CHARS]
    if not text:
        raise ValueError("page had no readable text (is it rendered by JavaScript?)")
    return {"url": url, "title": parser.title or url, "text": text}


def _brief(page: dict) -> str:
    return f"Product page title: {page['title']}\nURL: {page['url']}\nPage text:\n{page['text']}"


_RULES = (
    "Only use facts that appear in the page text. Never invent features, "
    "prices, numbers or testimonials. Audience: college students in India. "
    "Tone: genuine, simple, no hype words. Keep it short."
)


@app.task
def reel_script(ctx: TaskContext, page: dict) -> dict:
    out = llm.complete(
        f"You write short-form video scripts. {_RULES}",
        f"Write a 20-second Instagram Reel script (hook, 2-3 beats, call to action, "
        f"with on-screen text lines) for this product.\n\n{_brief(page)}",
    )
    return {"channel": "reel_script", "content": out}


@app.task
def whatsapp_message(ctx: TaskContext, page: dict) -> dict:
    out = llm.complete(
        f"You write WhatsApp messages people actually tap. {_RULES}",
        f"Write a forwardable WhatsApp message (max 4 lines) ending with the link "
        f"{page['url']}.\n\n{_brief(page)}",
    )
    return {"channel": "whatsapp_message", "content": out}


@app.task
def x_thread(ctx: TaskContext, page: dict) -> dict:
    out = llm.complete(
        f"You write build-in-public threads. {_RULES}",
        f"Write a 4-post X thread: the problem, what was built, who it is for, "
        f"link {page['url']}. Number each post.\n\n{_brief(page)}",
    )
    return {"channel": "x_thread", "content": out}


@app.task
def cold_email(ctx: TaskContext, page: dict) -> dict:
    out = llm.complete(
        f"You write cold emails that get replies. {_RULES}",
        f"Write a cold email (subject line + under 90 words) asking a student club "
        f"lead to try this and share feedback.\n\n{_brief(page)}",
    )
    return {"channel": "cold_email", "content": out}


@app.task
def review_pack(ctx: TaskContext, page: dict, pack: list) -> dict:
    """Fact-check: flag anything the drafts claim that the page does not say."""
    drafts = "\n\n".join(f"## {p['channel']}\n{p['content']}" for p in pack)
    verdict = llm.complete(
        "You are a strict fact-checker.",
        "List every claim in the drafts that is NOT supported by the page text, "
        "one per line. If all claims are supported reply exactly: No unsupported "
        f"claims.\n\n{_brief(page)}\n\nDRAFTS:\n{drafts}",
        max_tokens=400,
    )
    return {"verdict": verdict, "clean": verdict.strip().lower().startswith("no unsupported")}


# ---------- the orchestrator (the task you trigger) ----------

WRITERS = (reel_script, whatsapp_message, x_thread, cold_email)


@app.task(timeout_seconds=600)
async def generate_launch_pack(ctx: TaskContext, url: str) -> dict:
    """Trigger this one: generate_launch_pack(url) -> full pack + fact-check.

    Functions that call ctx.run() must be async so they can await results.
    """
    page = await ctx.run(fetch_page, url)

    # Fan out: all four writers at once. return_exceptions=True means one
    # failed writer (after its own retries) does not throw away the other three.
    results = await asyncio.gather(
        *(ctx.run(writer, page) for writer in WRITERS), return_exceptions=True
    )
    pack, failed = [], []
    for writer, result in zip(WRITERS, results):
        if isinstance(result, BaseException):
            failed.append({"channel": writer.name, "error": str(result)[:200]})
        else:
            pack.append(result)

    if not pack:
        raise RuntimeError(f"all writers failed: {failed}")

    review = await ctx.run(review_pack, page, pack)
    return {
        "source": {"url": page["url"], "title": page["title"]},
        "pack": pack,
        "failed": failed,
        "review": review,
    }


if __name__ == "__main__":
    app.start()
