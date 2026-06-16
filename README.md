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
  └─ focus        — time-on-site coaching
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
| `src/ui/` | popup + options (light/dark) |
