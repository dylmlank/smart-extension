// LLM layer: races local Ollama against OpenRouter, uses whichever is fastest.
// Falls back across OpenRouter free models on 429 / errors.

const OLLAMA_URL = "http://localhost:11434/api/chat";
const OLLAMA_MODEL = "llama3.2:latest";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OR_MODELS = [
  "meta-llama/llama-3.3-70b-instruct:free",
  "qwen/qwen3-next-80b-a3b-instruct:free",
  "google/gemma-4-31b-it:free",
  "openai/gpt-oss-20b:free"
];

async function getKey() {
  const { openrouterKey } = await chrome.storage.local.get("openrouterKey");
  return openrouterKey || "";
}

// ---- Ollama ----
async function callOllama(messages, signal, opts) {
  let res;
  // Map our sampling opts onto Ollama's "options" block. The humanizer passes a
  // hot preset (high temperature + repeat penalty) to push token choices toward
  // higher-perplexity, less-detectable output.
  const options = {};
  if (opts) {
    if (opts.temperature != null) options.temperature = opts.temperature;
    if (opts.top_p != null) options.top_p = opts.top_p;
    // Ollama uses repeat_penalty; approximate from frequency_penalty.
    if (opts.frequency_penalty != null) options.repeat_penalty = 1 + opts.frequency_penalty;
  }
  try {
    res = await fetch(OLLAMA_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: OLLAMA_MODEL, messages, stream: false,
        ...(Object.keys(options).length ? { options } : {}),
      }),
      signal
    });
  } catch (e) {
    // A network/CORS failure here is almost always one of two things:
    //   1. Ollama isn't running (`ollama serve`).
    //   2. Ollama is running but blocks the extension origin (CORS) — fix with
    //      OLLAMA_ORIGINS=* (or chrome-extension://*) in its environment.
    if (e.name === "AbortError") throw e;
    throw new Error(
      "ollama unreachable — is `ollama serve` running and OLLAMA_ORIGINS set " +
      "to allow this extension? (" + e.message + ")"
    );
  }
  if (res.status === 404) {
    throw new Error(`ollama model "${OLLAMA_MODEL}" not found — run: ollama pull ${OLLAMA_MODEL}`);
  }
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = await res.json();
  return { text: data.message?.content ?? "", provider: "ollama" };
}

// Is a local Ollama reachable from this extension at all? Used to give the UI
// an honest status instead of silently looking like "not running".
export async function ollamaHealth() {
  try {
    const res = await fetch(OLLAMA_URL.replace("/api/chat", "/api/tags"));
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    return {
      ok: true,
      models,
      hasModel: models.includes(OLLAMA_MODEL),
      model: OLLAMA_MODEL
    };
  } catch (e) {
    return {
      ok: false,
      reason: "unreachable (not running, or OLLAMA_ORIGINS blocks this extension)"
    };
  }
}

// ---- OpenRouter (with model fallback on 429) ----
async function callOpenRouter(messages, signal, opts) {
  const key = await getKey();
  if (!key) throw new Error("no openrouter key");
  let lastErr;
  for (const model of OR_MODELS) {
    try {
      const res = await fetch(OPENROUTER_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${key}`,
          "HTTP-Referer": "chrome-extension://smart-assistant",
          "X-Title": "Smart Personal Assistant"
        },
        body: JSON.stringify({ model, messages, ...(opts || {}) }),
        signal
      });
      if (res.status === 429) { lastErr = new Error("429"); continue; }
      if (!res.ok) { lastErr = new Error(`or ${res.status}`); continue; }
      const data = await res.json();
      return {
        text: data.choices?.[0]?.message?.content ?? "",
        provider: `openrouter:${model.split("/")[1] || model}`
      };
    } catch (e) {
      lastErr = e;
      if (e.name === "AbortError") throw e;
    }
  }
  throw lastErr || new Error("openrouter failed");
}

// Race the available providers; first successful response wins, the other is
// aborted. OpenRouter only joins the race when a key is configured — otherwise
// Ollama runs alone and we surface its real error (e.g. CORS / not running)
// instead of a misleading "all providers failed".
// `opts` carries optional sampling params (temperature, top_p, frequency_penalty,
// presence_penalty) used by the humanizer's hot rewrite preset.
export async function chat(messages, opts) {
  const ac1 = new AbortController();
  const ac2 = new AbortController();

  const wrap = (p, ac) =>
    p.then(r => ({ ok: true, r })).catch(e => ({ ok: false, e, ac }));

  const hasKey = !!(await getKey());

  const racers = [wrap(callOllama(messages, ac1.signal, opts), ac1)];
  if (hasKey) racers.push(wrap(callOpenRouter(messages, ac2.signal, opts), ac2));

  return new Promise((resolve, reject) => {
    let pending = racers.length;
    const acs = [ac1, ac2];
    const settle = (res, ownIdx) => {
      if (res.ok) {
        acs.forEach((ac, i) => i !== ownIdx && ac.abort());
        resolve(res.r);
      } else if (--pending === 0) {
        reject(res.e || new Error("all providers failed"));
      }
    };
    racers.forEach((racer, i) => racer.then(res => settle(res, i)));
  });
}
