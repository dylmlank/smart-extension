const key = document.getElementById("key");
const codemode = document.getElementById("codemode");
const status = document.getElementById("status");

chrome.storage.local.get(["openrouterKey", "codeModeEnabled"]).then((s) => {
  if (s.openrouterKey) key.value = s.openrouterKey;
  codemode.checked = !!s.codeModeEnabled;
});

// ---- Local Ollama health ----
const OLLAMA_MODEL = "llama3.2:latest";
const healthEl = document.getElementById("ollamaHealth");

async function checkOllama() {
  try {
    const res = await fetch("http://localhost:11434/api/tags");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const models = (data.models || []).map((m) => m.name);
    const hasModel = models.includes(OLLAMA_MODEL);
    healthEl.className = "health " + (hasModel ? "ok" : "bad");
    healthEl.innerHTML = hasModel
      ? `<b>✓ Local Ollama connected.</b> Using <code>${OLLAMA_MODEL}</code>. The extension can run fully offline.`
      : `<b>⚠ Ollama is reachable but <code>${OLLAMA_MODEL}</code> isn't installed.</b><br>Run: <code>ollama pull ${OLLAMA_MODEL}</code>`;
  } catch {
    healthEl.className = "health bad";
    healthEl.innerHTML =
      `<b>✗ Can't reach local Ollama.</b><br>` +
      `Either it isn't running, or it's blocking this extension (CORS).<br>` +
      `Start it and allow the extension origin:<br>` +
      `<code>OLLAMA_ORIGINS=* ollama serve</code><br>` +
      `(or set <code>OLLAMA_ORIGINS=*</code> in the ollama systemd service and restart it).<br>` +
      `Without Ollama, add an OpenRouter key above to use the cloud fallback.`;
  }
}
checkOllama();

document.getElementById("save").onclick = async () => {
  await chrome.storage.local.set({
    openrouterKey: key.value.trim(),
    codeModeEnabled: codemode.checked
  });
  status.textContent = "Saved ✓";
  setTimeout(() => (status.textContent = ""), 2000);
};
