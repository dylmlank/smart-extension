const out = document.getElementById("out");
const prov = document.getElementById("prov");
const taskIn = document.getElementById("task");
const newBtn = document.getElementById("new");

// Theme
const themeBtn = document.getElementById("theme");
(async () => {
  const { theme = "light" } = await chrome.storage.local.get("theme");
  apply(theme);
})();
function apply(t) {
  document.documentElement.dataset.theme = t;
  themeBtn.textContent = t === "dark" ? "☀️" : "🌙";
}
themeBtn.onclick = async () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  apply(t);
  await chrome.storage.local.set({ theme: t });
};

// Conversation memory: the running turn history for follow-up questions.
// Reset when the agent changes (a new topic) or via the "New" button.
let history = [];
let lastAgent = null;

// Minimal markdown: **bold**, `code`, bullet lines, and escape HTML.
function renderMd(text) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return esc(text)
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/^[-*]\s+(.*)$/gm, "<li>$1</li>")
    .replace(/(<li>[\s\S]*?<\/li>)/g, "<ul>$1</ul>")
    .replace(/\n/g, "<br>");
}

const copyBtn = document.getElementById("copyOut");
let lastOutput = "";

// Grab the current page selection (if any) so writing/translate tools act on it.
async function getSelection() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const sel = await chrome.tabs.sendMessage(tab.id, { type: "getSelection" }).catch(() => null);
    return sel?.selection || "";
  } catch { return ""; }
}

async function run(task, extra = {}) {
  out.textContent = "Thinking…";
  prov.textContent = "";
  copyBtn.style.display = "none";
  let payload = { ...extra };
  if (!payload.selection) {
    const selection = await getSelection();
    if (selection) payload.selection = selection;
  }

  const res = await chrome.runtime.sendMessage({ type: "task", task, payload, history });

  // If the router switched agents, this is a new topic — start a fresh thread.
  if (res.agent && res.agent !== lastAgent) history = [];
  lastAgent = res.agent || lastAgent;

  const answer = res.output || res.error || "(no response)";
  lastOutput = answer;
  out.innerHTML = renderMd(answer);
  if (!res.error && answer && answer !== "(no response)") copyBtn.style.display = "";
  prov.textContent = res.agent
    ? `${res.agent}${res.meta ? " · " + res.meta : ""}${res.lang ? " · " + res.lang : ""}` +
      `${res.provider ? " · " + res.provider : ""}` +
      (typeof res.confidence === "number" ? ` · ${Math.round(res.confidence * 100)}%` : "")
    : "";

  // Record the turn so follow-ups have context (cap kept short).
  if (!res.error) {
    history.push({ role: "user", content: task });
    history.push({ role: "assistant", content: answer });
    history = history.slice(-8);
    newBtn.style.display = "";
    taskIn.placeholder = "Ask a follow-up…";
  }
}

function resetChat() {
  history = [];
  lastAgent = null;
  taskIn.placeholder = "Ask anything…";
  newBtn.style.display = "none";
  out.textContent = "Pick an action or type a request.";
  prov.textContent = "";
}

document.querySelectorAll(".quick button").forEach(b => {
  if (!b.dataset.task) return;          // skip the "open humanizer" button
  b.onclick = () => { resetChat(); run(b.dataset.task); };
});
newBtn.onclick = resetChat;
document.getElementById("openHumanizer").onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/humanizer/humanizer.html") });
};

document.getElementById("go").onclick = () => taskIn.value && run(taskIn.value);
taskIn.addEventListener("keydown", e => { if (e.key === "Enter" && taskIn.value) run(taskIn.value); });

// Writing tools: each chip rewrites the current selection in a chosen style.
const STYLE_LABEL = {
  fix: "Fix grammar", concise: "Make concise", professional: "Make professional",
  casual: "Make casual", humanize: "Humanize",
};
document.querySelectorAll("#writeChips button").forEach(b => {
  b.onclick = async () => {
    const selection = await getSelection();
    if (!selection) { out.textContent = "Select some text on the page first, then click a writing tool."; return; }
    resetChat();
    run(STYLE_LABEL[b.dataset.style] || "Rewrite this", { selection, style: b.dataset.style });
  };
});

// "Undetectable" rewrite chip: routes to the rewriter agent on the selection.
document.querySelector("#writeChips button[data-rewrite]").onclick = async () => {
  const selection = await getSelection();
  if (!selection) { out.textContent = "Select some text on the page first, then click Undetectable."; return; }
  resetChat();
  run("Rewrite this to be undetectable", { selection });
};

// ---- Canvas: show the section only when the active tab is a Canvas page. ----
let canvasCtx = null; // { origin, courseId, pageUrl }
async function detectCanvas() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const u = new URL(tab.url);
    const isCanvas = /\.instructure\.com$/.test(u.hostname) || /\.canvas\.com$/.test(u.hostname);
    const cm = u.pathname.match(/\/courses\/(\d+)/);
    if (!isCanvas || !cm) return;
    const pm = u.pathname.match(/\/courses\/\d+\/pages\/([^/?#]+)/);
    canvasCtx = {
      origin: u.origin,
      courseId: cm[1],
      pageUrl: pm ? decodeURIComponent(pm[1]) : null,
    };
    document.getElementById("canvasSection").style.display = "";
    document.getElementById("canvasHint").textContent = `course ${canvasCtx.courseId}`;
    if (canvasCtx.pageUrl) document.getElementById("canvasPageBtn").style.display = "";
  } catch {}
}
detectCanvas();

const CANVAS_LABEL = {
  summary: "Summarize this Canvas course",
  studyGuide: "Make a study guide for this course",
  quiz: "Make a practice quiz for this course",
  due: "What assignments are due?",
  page: "Summarize this Canvas page",
};
document.querySelectorAll("#canvasChips button").forEach(b => {
  b.onclick = () => {
    if (!canvasCtx) { out.textContent = "Open a Canvas course page first."; return; }
    resetChat();
    run(CANVAS_LABEL[b.dataset.mode] || "Help with this course",
        { canvas: canvasCtx, mode: b.dataset.mode });
  };
});

// Translate the selection (or the page) into the chosen language.
document.getElementById("translateBtn").onclick = async () => {
  const lang = document.getElementById("lang").value;
  const selection = await getSelection();
  resetChat();
  run(`Translate this to ${lang}`, { selection, lang });
};

// Copy the last output to the clipboard.
copyBtn.onclick = async () => {
  try {
    await navigator.clipboard.writeText(lastOutput);
    copyBtn.textContent = "✓ Copied";
    setTimeout(() => (copyBtn.textContent = "⧉ Copy"), 1200);
  } catch { copyBtn.textContent = "✗"; }
};

document.getElementById("tools").onclick = async e => {
  e.preventDefault();
  const { tools } = await chrome.runtime.sendMessage({ type: "listTools" });
  const names = Object.values(tools || {});
  out.textContent = names.length
    ? "🔧 Tools I've built:\n\n" + names.map(t => `• ${t.name} ${t.mode === "code" ? "⚡" : ""}— ${t.desc}`).join("\n")
    : "No custom tools yet. Ask me to do something new and I'll build one.";
  prov.textContent = `${names.length} custom tool(s)`;
};

document.getElementById("opts").onclick = e => { e.preventDefault(); chrome.runtime.openOptionsPage(); };
document.getElementById("retro").onclick = async e => {
  e.preventDefault();
  out.textContent = "Reflecting on recent activity…";
  const r = await chrome.runtime.sendMessage({ type: "retro" });
  out.textContent = r.skipped ? "Not enough activity yet." :
    r.error ? "Error: " + r.error :
    "New learnings:\n• " + (r.learnings || []).join("\n• ");
};
