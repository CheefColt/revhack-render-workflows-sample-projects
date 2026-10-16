"""Tiny, dependency-free LLM helper.

Picks a provider automatically:
  1. LLM_PROVIDER=gemini | anthropic | openai | mock   (explicit choice), else
  2. GEMINI_API_KEY present     -> Gemini
  3. ANTHROPIC_API_KEY present  -> Anthropic
  4. OPENAI_API_KEY present     -> OpenAI
  5. otherwise                  -> mock (deterministic, works offline, free)

Why a mock? So the template runs on day one with zero keys, and so tests
never spend money. Set a real key and the same code uses a real model.

Errors are raised (not swallowed) on purpose: Render retries a failed task
automatically, so a flaky 429/5xx from the model API heals itself.
"""
import json
import os
import urllib.error
import urllib.request

DEFAULT_MODELS = {
    "gemini": "gemini-3.8-flash",
    "anthropic": "claude-haiku-5-5",
    "openai": "gpt-4o-mini",
}


class LLMError(RuntimeError):
    """Raised when the model API fails. Render will retry the task."""


def provider() -> str:
    explicit = os.environ.get("LLM_PROVIDER", "").strip().lower()
    if explicit in ("gemini", "anthropic", "openai", "mock"):
        return explicit
    if os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY"):
        return "gemini"
    if os.environ.get("ANTHROPIC_API_KEY"):
        return "anthropic"
    if os.environ.get("OPENAI_API_KEY"):
        return "openai"
    return "mock"


def _post(url: str, headers: dict, body: dict, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", **headers},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", errors="replace")[:300]
        raise LLMError(f"model API returned HTTP {e.code}: {detail}") from e
    except urllib.error.URLError as e:
        raise LLMError(f"could not reach model API: {e.reason}") from e


def _require_key(name: str) -> str:
    key = os.environ.get(name)
    if not key and name == "GEMINI_API_KEY":
        key = os.environ.get("GOOGLE_API_KEY")
    if not key:
        raise LLMError(f"{name} is not set")
    return key


def complete(system: str, prompt: str, max_tokens: int = 700) -> str:
    """Return the model's text reply for one system + user prompt."""
    p = provider()
    model = os.environ.get("LLM_MODEL", DEFAULT_MODELS.get(p, "mock"))

    if p == "gemini":
        body = {
            "contents": [{"role": "user", "parts": [{"text": prompt}]}],
            "generationConfig": {"maxOutputTokens": max_tokens},
        }
        if system:
            body["systemInstruction"] = {"parts": [{"text": system}]}
        data = _post(
            f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
            {"x-goog-api-key": _require_key("GEMINI_API_KEY")},
            body,
        )
        candidates = data.get("candidates", [])
        if not candidates:
            raise LLMError(f"gemini returned no candidates: {data}")
        parts = candidates[0].get("content", {}).get("parts", [])
        return "".join(part.get("text", "") for part in parts if "text" in part).strip()

    if p == "anthropic":
        data = _post(
            "https://api.anthropic.com/v1/messages",
            {
                "x-api-key": _require_key("ANTHROPIC_API_KEY"),
                "anthropic-version": "2023-06-01",
            },
            {
                "model": model,
                "max_tokens": max_tokens,
                "system": system,
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        return "".join(
            b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"
        ).strip()

    if p == "openai":
        data = _post(
            "https://api.openai.com/v1/chat/completions",
            {"authorization": f"Bearer {_require_key('OPENAI_API_KEY')}"},
            {
                "model": model,
                "max_tokens": max_tokens,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": prompt},
                ],
            },
        )
        return data["choices"][0]["message"]["content"].strip()

    # mock: deterministic placeholder so everything runs offline
    first = prompt.strip().splitlines()[0][:80] if prompt.strip() else ""
    return f"[mock reply] {system.split('.')[0][:60]} :: {first}"
