const out = document.getElementById("out");
const prov = document.getElementById("prov");
const taskIn = document.getElementById("task");

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

async function run(task) {
  out.textContent = "Thinking…";
  prov.textContent = "";
  // grab selection for research tasks
  let payload = {};
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const sel = await chrome.tabs.sendMessage(tab.id, { type: "getSelection" }).catch(() => null);
    if (sel?.selection) payload.selection = sel.selection;
  } catch {}
  const res = await chrome.runtime.sendMessage({ type: "task", task, payload });
  out.textContent = res.output || res.error || "(no response)";
  prov.textContent = res.agent ? `${res.agent}${res.provider ? " · " + res.provider : ""}` : "";
}

document.querySelectorAll(".quick button").forEach(b => {
  b.onclick = () => run(b.dataset.task);
});
document.getElementById("openHumanizer").onclick = () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("src/humanizer/humanizer.html") });
};

document.getElementById("go").onclick = () => taskIn.value && run(taskIn.value);
taskIn.addEventListener("keydown", e => { if (e.key === "Enter" && taskIn.value) run(taskIn.value); });

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
