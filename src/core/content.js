// Content script: relays the current text selection on demand, and renders an
// inline result bubble for the right-click "Smart Assistant" actions.

chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg.type === "getSelection") {
    send({ selection: window.getSelection().toString() });
    return true;
  }
  if (msg.type === "saResult") {
    showBubble(msg);
    return false;
  }
  return false;
});

let bubbleEl = null;

function dismissBubble() {
  if (bubbleEl) { bubbleEl.remove(); bubbleEl = null; }
}

// Position a floating card near the current selection (or top-right fallback).
function anchorRect() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) {
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.width || r.height) return r;
  }
  return { bottom: 60, left: window.innerWidth - 380 };
}

function showBubble({ state, title, output }) {
  dismissBubble();
  const rect = anchorRect();
  const dark = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

  const el = document.createElement("div");
  el.setAttribute("data-sa-bubble", "1");
  const top = Math.min(window.innerHeight - 40, (rect.bottom || 60) + window.scrollY + 8);
  const left = Math.min(window.innerWidth - 360, Math.max(8, (rect.left || 8) + window.scrollX));
  Object.assign(el.style, {
    position: "absolute", top: top + "px", left: left + "px", zIndex: 2147483647,
    width: "340px", maxHeight: "300px", overflow: "auto",
    background: dark ? "#18181b" : "#ffffff",
    color: dark ? "#f4f4f5" : "#1a1a1a",
    border: "1px solid " + (dark ? "#3f3f46" : "#e4e4e7"),
    borderRadius: "12px", boxShadow: "0 8px 30px rgba(0,0,0,.25)",
    font: "13px/1.5 system-ui, sans-serif", padding: "0",
  });

  const accent = dark ? "#818cf8" : "#4f46e5";
  el.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;
                padding:8px 12px;border-bottom:1px solid ${dark ? "#3f3f46" : "#e4e4e7"}">
      <strong style="font-size:12px;color:${accent}">🧠 ${escapeHtml(title || "Smart Assistant")}</strong>
      <span style="display:flex;gap:6px">
        <button data-sa-copy style="cursor:pointer;border:none;background:none;color:inherit;font-size:13px">⧉</button>
        <button data-sa-close style="cursor:pointer;border:none;background:none;color:inherit;font-size:15px">×</button>
      </span>
    </div>
    <div data-sa-body style="padding:10px 12px;white-space:pre-wrap">${
      state === "loading" ? "Thinking…" : escapeHtml(output || "")
    }</div>`;

  document.body.appendChild(el);
  bubbleEl = el;

  el.querySelector("[data-sa-close]").onclick = dismissBubble;
  const copyBtn = el.querySelector("[data-sa-copy]");
  copyBtn.onclick = async () => {
    try {
      await navigator.clipboard.writeText(output || el.querySelector("[data-sa-body]").textContent);
      copyBtn.textContent = "✓";
      setTimeout(() => (copyBtn.textContent = "⧉"), 1000);
    } catch {}
  };

  // Dismiss on outside click / Escape.
  setTimeout(() => {
    const onDoc = (e) => { if (bubbleEl && !bubbleEl.contains(e.target)) { dismissBubble(); document.removeEventListener("mousedown", onDoc); } };
    document.addEventListener("mousedown", onDoc);
  }, 0);
  document.addEventListener("keydown", function esc(e) {
    if (e.key === "Escape") { dismissBubble(); document.removeEventListener("keydown", esc); }
  });
}

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
