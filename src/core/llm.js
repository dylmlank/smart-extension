// LLM layer: races local Ollama against OpenRouter, uses whichever is fastest.
// Falls back across OpenRouter free models on 429 / errors.

const OLLAMA_URL = "http://localhost:11434/api/chat";
const OLLAMA_MODEL = "llama3.2:latest";

const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const OR_MODELS = [
  "meta-llama/llama-3.2-3b-instruct:free",
  "google/gemma-2-9b-it:free",
  "mistralai/mistral-7b-instruct:free",
  "qwen/qwen-2-7b-instruct:free"
];

async function getKey() {
  const { openrouterKey } = await chrome.storage.local.get("openrouterKey");
  return openrouterKey || "";
}

// ---- Ollama ----
async function callOllama(messages, signal) {
  const res = await fetch(OLLAMA_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: OLLAMA_MODEL, messages, stream: false }),
    signal
  });
  if (!res.ok) throw new Error(`ollama ${res.status}`);
  const data = await res.json();
  return { text: data.message?.content ?? "", provider: "ollama" };
}

// ---- OpenRouter (with model fallback on 429) ----
async function callOpenRouter(messages, signal) {
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
        body: JSON.stringify({ model, messages }),
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

// Race both providers; first successful response wins, the other is aborted.
export async function chat(messages) {
  const ac1 = new AbortController();
  const ac2 = new AbortController();

  const wrap = (p, ac) =>
    p.then(r => ({ ok: true, r })).catch(e => ({ ok: false, e, ac }));

  const ollama = wrap(callOllama(messages, ac1.signal), ac1);
  const openrouter = wrap(callOpenRouter(messages, ac2.signal), ac2);

  // Promise.any over the wrapped winners
  return new Promise((resolve, reject) => {
    let pending = 2;
    const settle = (res, otherAc) => {
      if (res.ok) {
        otherAc.abort();
        resolve(res.r);
      } else if (--pending === 0) {
        reject(res.e || new Error("all providers failed"));
      }
    };
    ollama.then(res => settle(res, ac2));
    openrouter.then(res => settle(res, ac1));
  });
}
