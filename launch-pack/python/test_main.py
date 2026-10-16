"""Offline tests: no network, no Render, no API key, no cost.

Render's docs suggest testing a task by calling its `.func` with a stand-in
context. FakeCtx runs "chained" tasks in-process so we can test the whole
orchestrator the same way.

Run:  pip install pytest pytest-asyncio  &&  pytest -q
"""
import asyncio
import os

import pytest

os.environ["LLM_PROVIDER"] = "mock"  # never call a real model in tests

import main  # noqa: E402

PAGE = {"url": "https://example.com", "title": "Example", "text": "A tool for students."}


class FakeCtx:
    """Stand-in for TaskContext: ctx.run(task, *args) runs the task directly."""

    def __init__(self, fail=()):
        self.fail = set(fail)
        self.calls = []

    async def run(self, task, *args):
        self.calls.append(task.name)
        if task.name in self.fail:
            raise RuntimeError(f"{task.name} exploded")
        out = task.func(self, *args)
        return await out if asyncio.iscoroutine(out) else out


def run(coro):
    return asyncio.run(coro)


def test_writers_return_channel_and_content():
    for writer in main.WRITERS:
        out = writer.func(None, PAGE)
        assert out["channel"] == writer.name
        assert out["content"]


def test_orchestrator_runs_all_steps_in_order(monkeypatch):
    monkeypatch.setattr(main.fetch_page, "func", lambda ctx, url: PAGE)
    ctx = FakeCtx()
    result = run(main.generate_launch_pack.func(ctx, "https://example.com"))
    assert ctx.calls[0] == "fetch_page"
    assert ctx.calls[-1] == "review_pack"
    assert {p["channel"] for p in result["pack"]} == {w.name for w in main.WRITERS}
    assert result["failed"] == []


def test_one_failed_writer_does_not_lose_the_others(monkeypatch):
    monkeypatch.setattr(main.fetch_page, "func", lambda ctx, url: PAGE)
    ctx = FakeCtx(fail={"x_thread"})
    result = run(main.generate_launch_pack.func(ctx, "https://example.com"))
    assert [f["channel"] for f in result["failed"]] == ["x_thread"]
    assert len(result["pack"]) == 3


def test_all_writers_failing_fails_the_run(monkeypatch):
    monkeypatch.setattr(main.fetch_page, "func", lambda ctx, url: PAGE)
    ctx = FakeCtx(fail={w.name for w in main.WRITERS})
    with pytest.raises(RuntimeError):
        run(main.generate_launch_pack.func(ctx, "https://example.com"))


@pytest.mark.parametrize(
    "url",
    ["ftp://example.com", "http://127.0.0.1/admin", "http://localhost:8080", "http://10.0.0.5"],
)
def test_private_or_non_http_urls_are_refused(url):
    with pytest.raises(ValueError):
        main._assert_public_url(url)


def test_mock_provider_is_default_without_keys(monkeypatch):
    monkeypatch.delenv("LLM_PROVIDER", raising=False)
    monkeypatch.delenv("GEMINI_API_KEY", raising=False)
    monkeypatch.delenv("GOOGLE_API_KEY", raising=False)
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    assert main.llm.provider() == "mock"


def test_html_text_extraction_skips_scripts_and_reads_title():
    p = main._TextExtractor()
    p.feed("<html><head><title>Hi</title><script>var x=1;</script></head>"
           "<body><h1>Build</h1><style>p{}</style><p>Ship it</p></body></html>")
    assert p.title == "Hi"
    assert " ".join(p.parts) == "Build Ship it"


def test_gemini_request_shape_and_parsing(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "gemini")
    monkeypatch.setenv("GEMINI_API_KEY", "test-key")
    seen = {}

    def fake_post(url, headers, body, timeout=60):
        seen.update(url=url, headers=headers, body=body)
        return {"candidates": [{"content": {"parts": [{"text": " hello from gemini "}]}}]}

    monkeypatch.setattr(main.llm, "_post", fake_post)
    assert main.llm.complete("sys", "user prompt") == "hello from gemini"
    assert seen["url"] == "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent"
    assert seen["headers"]["x-goog-api-key"] == "test-key"
    assert seen["body"]["contents"][0]["parts"][0]["text"] == "user prompt"
    assert seen["body"]["systemInstruction"]["parts"][0]["text"] == "sys"


def test_anthropic_request_shape_and_parsing(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")
    seen = {}

    def fake_post(url, headers, body, timeout=60):
        seen.update(url=url, headers=headers, body=body)
        return {"content": [{"type": "text", "text": " hello "}]}

    monkeypatch.setattr(main.llm, "_post", fake_post)
    assert main.llm.complete("sys", "user prompt") == "hello"
    assert seen["url"] == "https://api.anthropic.com/v1/messages"
    assert seen["headers"]["x-api-key"] == "sk-test"
    assert seen["body"]["messages"][0]["content"] == "user prompt"
    assert seen["body"]["system"] == "sys"


def test_openai_request_shape_and_parsing(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "openai")
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test")
    monkeypatch.setattr(
        main.llm, "_post",
        lambda url, headers, body, timeout=60: {"choices": [{"message": {"content": " yo "}}]},
    )
    assert main.llm.complete("sys", "p") == "yo"


def test_redirect_to_a_private_address_is_refused(monkeypatch):
    import urllib.error
    from email.message import Message

    headers = Message()
    headers["Location"] = "http://10.0.0.1/admin"

    def fake_open(req, timeout=None):
        raise urllib.error.HTTPError(req.full_url, 302, "Found", headers, None)

    monkeypatch.setattr(main._opener, "open", fake_open)
    # a public IP literal, so the first hop needs no DNS
    with pytest.raises(ValueError, match="private or internal"):
        main._read_page("http://93.184.216.34/")


def test_cgnat_and_metadata_ranges_are_refused():
    for url in ("http://100.64.0.1/", "http://169.254.169.254/latest/meta-data"):
        with pytest.raises(ValueError):
            main._assert_public_url(url)


def test_real_provider_without_key_gives_a_clear_error(monkeypatch):
    monkeypatch.setenv("LLM_PROVIDER", "anthropic")
    monkeypatch.delenv("ANTHROPIC_API_KEY", raising=False)
    with pytest.raises(main.llm.LLMError, match="ANTHROPIC_API_KEY is not set"):
        main.llm.complete("s", "p")
