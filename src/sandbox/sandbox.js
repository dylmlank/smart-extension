// Sandbox: the ONLY place arbitrary generated JS executes.
//
// This is a manifest "sandbox" page, so it runs with a relaxed CSP that allows
// eval/new Function, but has ZERO access to chrome.* APIs. Generated code is
// handed an `api` object whose methods are async bridges back to the parent
// (the offscreen document), which holds the real privileges. So even malicious
// generated code can only do what the bridge whitelists.

let seq = 0;
const pending = new Map();

// Bridge: call a privileged op in the parent and await its result.
function bridge(op, args) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ kind: "bridge", id, op, args }, "*");
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error("bridge timeout: " + op)); }
    }, 20000);
  });
}

// The capability surface exposed to generated code. Mirrors the safe ops,
// but here the code is real JS and can loop, branch, parse, compose freely.
const api = {
  fetchText: (url, opts) => bridge("fetchText", { url, opts }),
  fetchJson: (url, opts) => bridge("fetchJson", { url, opts }),
  queryTabs: (query) => bridge("queryTabs", { query }),
  extract: (selector, html) => bridge("extract", { selector, html }),
  store: (key, value) => bridge("store", { key, value }),
  load: (key) => bridge("load", { key }),
  llm: (prompt, system) => bridge("llm", { prompt, system }),
  openTab: (url, focus) => bridge("openTab", { url, focus }),
  canvasCourse: (opts) => bridge("canvasCourse", opts || {}),
  canvasFiles: (opts) => bridge("canvasFiles", opts || {}),
  readDoc: (url, hint) => bridge("readDoc", { url, hint }),
  download: (filename, content, url) => bridge("download", { filename, content, url }),
  clipboard: (text) => bridge("clipboard", { text }),
  notify: (title, message) => bridge("notify", { title, message }),
  log: (...a) => parent.postMessage({ kind: "log", args: a.map(String) }, "*")
};

window.addEventListener("message", async (e) => {
  const msg = e.data || {};

  // Result coming back from a bridged op.
  if (msg.kind === "bridgeResult") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
    return;
  }

  // Request to run generated code.
  if (msg.kind === "run") {
    try {
      // Wrap the code as an async function body. `api` and `params` in scope.
      const fn = new Function(
        "api", "params",
        `"use strict"; return (async () => { ${msg.code} })();`
      );
      const result = await fn(api, msg.params || {});
      parent.postMessage({ kind: "runResult", id: msg.id, result }, "*");
    } catch (err) {
      parent.postMessage({ kind: "runResult", id: msg.id, error: String(err && err.message || err) }, "*");
    }
  }
});

parent.postMessage({ kind: "ready" }, "*");
