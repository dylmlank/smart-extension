// Offscreen document: privileged host for the sandbox iframe.
//
// - Receives "execJs" requests from the service worker (via chrome.runtime).
// - Forwards the code into the sandboxed iframe to run.
// - Services the iframe's bridge calls using real chrome.* APIs.
//
// The iframe runs arbitrary JS but can only reach the whitelist below.

import { chat } from "../core/llm.js";

const box = document.getElementById("box");
let ready = false;
let readyWaiters = [];
let seq = 0;
const runs = new Map();

function whenReady() {
  return ready ? Promise.resolve()
    : new Promise(r => readyWaiters.push(r));
}

// ---- Privileged bridge ops (the entire capability surface for sandboxed code) ----
const BRIDGE = {
  async fetchText({ url, opts }) {
    const res = await fetch(url, { ...sanitizeOpts(opts), signal: AbortSignal.timeout(15000) });
    return (await res.text()).slice(0, 50000);
  },
  async fetchJson({ url, opts }) {
    const res = await fetch(url, { ...sanitizeOpts(opts), signal: AbortSignal.timeout(15000) });
    return res.json();
  },
  async queryTabs({ query }) {
    return (await chrome.tabs.query(query || {})).map(t => ({ id: t.id, title: t.title, url: t.url }));
  },
  async extract({ selector, html }) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return "";
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [selector || "body", !!html],
      func: (s, h) => [...document.querySelectorAll(s)].map(e => h ? e.innerHTML : e.innerText).join("\n").slice(0, 20000)
    });
    return result || "";
  },
  async store({ key, value }) { await chrome.storage.local.set({ ["udata_" + key]: value }); return true; },
  async load({ key }) { const o = await chrome.storage.local.get("udata_" + key); return o["udata_" + key] ?? null; },
  async llm({ prompt, system }) {
    const { text } = await chat([
      { role: "system", content: system || "You are a concise helper inside a tool." },
      { role: "user", content: String(prompt) }
    ]);
    return text;
  },
  async openTab({ url, focus }) { const t = await chrome.tabs.create({ url, active: !!focus }); return { id: t.id }; }
};

// Only allow plain method + headers + body on fetch; never credentials/mode tricks.
function sanitizeOpts(opts) {
  if (!opts || typeof opts !== "object") return {};
  const { method, headers, body } = opts;
  return { method, headers, body };
}

// ---- Messages from the sandbox iframe ----
window.addEventListener("message", async (e) => {
  if (e.source !== box.contentWindow) return;
  const msg = e.data || {};

  if (msg.kind === "ready") {
    ready = true;
    readyWaiters.forEach(r => r());
    readyWaiters = [];
    return;
  }

  if (msg.kind === "log") {
    console.log("[sandbox]", ...msg.args);
    return;
  }

  if (msg.kind === "bridge") {
    const op = BRIDGE[msg.op];
    try {
      if (!op) throw new Error("disallowed op: " + msg.op);
      const result = await op(msg.args || {});
      box.contentWindow.postMessage({ kind: "bridgeResult", id: msg.id, result }, "*");
    } catch (err) {
      box.contentWindow.postMessage({ kind: "bridgeResult", id: msg.id, error: String(err.message || err) }, "*");
    }
    return;
  }

  if (msg.kind === "runResult") {
    const r = runs.get(msg.id);
    if (r) { runs.delete(msg.id); r(msg); }
    return;
  }
});

// Run code in the sandbox and await its result.
function runInSandbox(code, params) {
  return new Promise(async (resolve) => {
    await whenReady();
    const id = ++seq;
    runs.set(id, resolve);
    box.contentWindow.postMessage({ kind: "run", id, code, params }, "*");
    setTimeout(() => {
      if (runs.has(id)) { runs.delete(id); resolve({ error: "execution timeout" }); }
    }, 30000);
  });
}

// ---- Messages from the service worker ----
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== "offscreen-execJs") return;
  runInSandbox(msg.code, msg.params).then(res =>
    sendResponse(res.error ? { error: res.error } : { result: res.result })
  );
  return true;
});
