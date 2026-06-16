import { chat } from "../core/llm.js";

const $ = (id) => document.getElementById(id);
const input = $("input"), output = $("output");
const inWords = $("inWords"), outWords = $("outWords"), status = $("status");
let mode = "balanced";
let detectTarget = "input";

const wc = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);
const setStatus = (m, ms) => {
  status.textContent = m;
  if (ms) setTimeout(() => { if (status.textContent === m) status.textContent = ""; }, ms);
};

// Theme (synced with extension storage so it matches the popup).
const root = document.documentElement, themeBtn = $("themeToggle");
chrome.storage.local.get("theme").then(({ theme }) => {
  if (theme) root.setAttribute("data-theme", theme);
  syncIcon();
});
const syncIcon = () =>
  (themeBtn.textContent = root.getAttribute("data-theme") === "dark" ? "☀️" : "🌙");
themeBtn.onclick = () => {
  const next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
  root.setAttribute("data-theme", next);
  chrome.storage.local.set({ theme: next });
  syncIcon();
};

// Mode
document.querySelectorAll(".controls .seg-btn").forEach((b) => {
  b.onclick = () => {
    document.querySelectorAll(".controls .seg-btn").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    mode = b.dataset.mode;
  };
});

input.addEventListener("input", () => (inWords.textContent = wc(input.value)));

$("sampleBtn").onclick = () => {
  input.value = window.Humanizer.SAMPLE;
  inWords.textContent = wc(input.value);
};
$("clearBtn").onclick = () => {
  input.value = output.value = "";
  inWords.textContent = outWords.textContent = "0";
};
$("copyBtn").onclick = async () => {
  if (!output.value) return;
  await navigator.clipboard.writeText(output.value);
  setStatus("Copied!", 1500);
};

// Grab the current selection from the active tab.
$("pageBtn").onclick = async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab?.id) throw new Error("no tab");
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => window.getSelection().toString(),
    });
    if (result && result.trim()) {
      input.value = result.trim();
      inWords.textContent = wc(input.value);
      setStatus("Grabbed selection", 1500);
    } else {
      setStatus("No text selected on the page", 2500);
    }
  } catch {
    setStatus("Can't read that page", 2500);
  }
};

const PROMPTS = {
  balanced: "Rewrite to sound natural and human. Vary sentence length, cut filler and AI cliches, keep the meaning. Output only the rewrite.",
  simple: "Rewrite in plain, simple language a person would use. Short clear sentences. Keep meaning. Output only the rewrite.",
  casual: "Rewrite in a casual, conversational human tone. Contractions, varied rhythm, no corporate filler. Keep meaning. Output only the rewrite.",
};

const btn = $("humanizeBtn");
btn.onclick = async () => {
  const text = input.value.trim();
  if (!text) { setStatus("Paste some text first", 2000); return; }

  let result = window.Humanizer.humanize(text, mode);

  if ($("useLLM").checked) {
    btn.disabled = true;
    setStatus("Deep rewriting…");
    try {
      const { text: out, provider } = await chat([
        { role: "system", content: PROMPTS[mode] },
        { role: "user", content: text },
      ]);
      if (out && out.trim()) {
        result = out.trim();
        setStatus("Done · " + provider, 2500);
      } else setStatus("Empty AI reply — used local", 2500);
    } catch {
      setStatus("AI unavailable — used local rewrite", 2500);
    } finally {
      btn.disabled = false;
    }
  } else setStatus("Done", 1500);

  output.value = result;
  outWords.textContent = wc(result);
  detectTarget = "output";
  syncDetectTabs();
  runDetect();
};

// Detector
const detectorBody = $("detectorBody");
function syncDetectTabs() {
  document.querySelectorAll(".seg-sm .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.target === detectTarget)
  );
}
function runDetect() {
  const text = (detectTarget === "output" ? output.value : input.value).trim();
  window.renderDetector(detectorBody, window.Detector.detect(text));
}
document.querySelectorAll(".seg-sm .seg-btn").forEach((b) => {
  b.onclick = () => { detectTarget = b.dataset.target; syncDetectTabs(); runDetect(); };
});
$("detectBtn").onclick = runDetect;

// If opened with ?grab=1, auto-pull the page selection on load.
const params = new URLSearchParams(location.search);
if (params.get("grab") === "1") $("pageBtn").click();

// If opened from the right-click menu, load the stashed selection.
if (params.get("prefill") === "1") {
  chrome.storage.local.get("humanizePrefill").then(({ humanizePrefill }) => {
    if (humanizePrefill) {
      input.value = humanizePrefill;
      inWords.textContent = wc(input.value);
      chrome.storage.local.remove("humanizePrefill");
      runDetect();
    }
  });
}
