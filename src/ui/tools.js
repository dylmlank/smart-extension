// Tools panel: list / build / run / delete the assistant's self-built tools.

const listEl = document.getElementById("list");

// Theme (shared convention with the popup).
const themeBtn = document.getElementById("theme");
(async () => {
  const { theme = "light" } = await chrome.storage.local.get("theme");
  document.documentElement.dataset.theme = theme;
  themeBtn.textContent = theme === "dark" ? "☀️" : "🌙";
})();
themeBtn.onclick = async () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t;
  themeBtn.textContent = t === "dark" ? "☀️" : "🌙";
  await chrome.storage.local.set({ theme: t });
};

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function load() {
  const { tools = {} } = await chrome.runtime.sendMessage({ type: "listTools" });
  const entries = Object.values(tools);
  if (!entries.length) {
    listEl.innerHTML = `<div class="empty">No tools yet.<br>Describe a task above and the assistant will build one.</div>`;
    return;
  }
  listEl.innerHTML = "";
  for (const tool of entries) {
    const params = Array.isArray(tool.params) ? tool.params : [];
    const card = document.createElement("div");
    card.className = "card";
    const modeBadge = tool.mode === "code"
      ? `<span class="badge">⚡ code</span>`
      : `<span class="badge op">op-plan</span>`;
    const stepInfo = tool.mode === "code"
      ? `mode: sandboxed JS`
      : `steps: ${(tool.steps || []).map((s) => s.op).join(" → ") || "—"}`;
    card.innerHTML = `
      <h3>${esc(tool.name)} ${modeBadge}</h3>
      <p class="desc">${esc(tool.desc || "(no description)")}</p>
      <p class="steps">${esc(stepInfo)}</p>
      <div class="params">
        ${params.map((p) => `<input data-param="${esc(p)}" placeholder="${esc(p)}" />`).join("")}
      </div>
      <div class="row">
        <button class="accent run">Run ▶</button>
        <button class="ghost danger del">Delete</button>
      </div>
      <div class="out"></div>`;

    const out = card.querySelector(".out");
    card.querySelector(".run").onclick = async () => {
      const p = {};
      card.querySelectorAll("[data-param]").forEach((i) => { if (i.value) p[i.dataset.param] = i.value; });
      out.style.display = "block";
      out.textContent = "Running…";
      const res = await chrome.runtime.sendMessage({ type: "runTool", name: tool.name, params: p });
      out.textContent = res.error ? "Error: " + res.error : (res.result || "(no output)");
    };
    card.querySelector(".del").onclick = async () => {
      await chrome.runtime.sendMessage({ type: "deleteTool", name: tool.name });
      load();
    };
    listEl.appendChild(card);
  }
}

document.getElementById("buildBtn").onclick = async () => {
  const task = document.getElementById("buildInput").value.trim();
  if (!task) return;
  const btn = document.getElementById("buildBtn");
  btn.textContent = "Building…"; btn.disabled = true;
  try {
    const res = await chrome.runtime.sendMessage({ type: "buildTool", task, payload: {} });
    if (res.error) alert("Build failed: " + res.error);
    document.getElementById("buildInput").value = "";
    await load();
  } finally {
    btn.textContent = "Build"; btn.disabled = false;
  }
};
document.getElementById("buildInput").addEventListener("keydown", (e) => {
  if (e.key === "Enter") document.getElementById("buildBtn").click();
});

load();
