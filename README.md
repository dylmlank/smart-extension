# 🧠 Smart Personal Assistant — Browser Extension

An agentic Chrome (Manifest V3) extension that summarizes pages, organizes tabs,
assists research, and tracks focus — with a **constant retrospective loop** that
makes it smarter the more you use it.

## Architecture

```
Orchestrator (agents.js)
  ├─ summarizer   — summarize / Q&A on the current page
  ├─ organizer    — group, dedupe, close tabs
  ├─ researcher   — explain selection, build a research log
  ├─ focus        — time-on-site coaching
  └─ builder      — SELF-EXTENDING: builds a new tool for any unhandled task
        │           (toolfactory.js), reuses tools it built before
        │
        ▼
   LLM layer (llm.js) ── races Ollama (local) vs OpenRouter (cloud), fastest wins
        │
        ▼
   Retrospective (retrospective.js) ── logs every action, reflects every 30 min,
                                       injects learnings into future prompts
```

The **orchestrator** routes each free-form task to the right specialist agent
(keyword routing first, LLM routing as fallback). Every action is logged; a
scheduled alarm runs a retrospective that distills learnings, which are then
fed back into every agent's system prompt.

## Install (dev)

1. Open `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked** → select this `smart-extension/` folder
4. (Optional) Settings → paste an OpenRouter key for cloud fallback

Runs fully local with Ollama (`llama3.2:latest`) if no key is set. Make sure
Ollama allows the extension origin:
```bash
OLLAMA_ORIGINS='chrome-extension://*' ollama serve
```

## Self-built tools (the `builder` agent)

When you give the assistant a task no specialist covers, the **builder** agent
**creates a new tool for it on the fly**, saves it, and reuses it next time.

Because MV3 service workers can't `eval()` arbitrary code (CSP), tools aren't raw
JS. The LLM designs each tool as a *plan of safe ops* from a fixed vocabulary,
and a sandboxed interpreter (`runOps`) executes it. Real self-extension, no
arbitrary-code-execution hole.

Allowed ops: `fetchText`, `fetchJson`, `queryTabs`, `extract` (CSS selector on
the page), `store`/`load`, `llm` (reason over collected data), `openTab`. Steps
chain results with `$name` references.

> Example: *"get the top 5 Hacker News story titles and summarize the themes"* →
> builder writes a tool that `fetchJson`s the HN API, `fetchJson`s each item, then
> runs an `llm` step to summarize — and keeps it under **My tools** for reuse.

Manage them from the popup's **My tools** link.

## Features

- **Summarize / ask** about any page
- **Organize tabs** — auto-group by topic, close duplicates
- **Research** — highlight text, get explanations + follow-ups, saved to a log
- **Focus** — per-domain time tracking + gentle nudges
- **Self-improvement** — retrospective insights stored and reused

## Files

| File | Role |
|------|------|
| `manifest.json` | MV3 config |
| `src/core/background.js` | service worker: routing, focus tracking, scheduler |
| `src/core/llm.js` | Ollama vs OpenRouter race |
| `src/core/retrospective.js` | the constant self-improvement loop |
| `src/agents/agents.js` | orchestrator + specialist agents |
| `src/agents/toolfactory.js` | runtime tool creation + sandboxed op executor |
| `src/ui/` | popup + options (light/dark) |
