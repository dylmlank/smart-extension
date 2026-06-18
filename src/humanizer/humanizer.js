import { chat } from "../core/llm.js";

// Load any learnings persisted from past runs into the sync cache so the
// detector/humanizer pick them up immediately.
if (window.Learnings && window.Learnings.hydrate) window.Learnings.hydrate();

const $ = (id) => document.getElementById(id);
const input = $("input"), output = $("output");
const inWords = $("inWords"), outWords = $("outWords"), status = $("status");
const changePctEl = $("changePct");
let mode = "balanced";
let detectTarget = "input";

const wc = (s) => (s.trim() ? s.trim().split(/\s+/).length : 0);

// Output is a rich (highlightable) div; keep the plain text result alongside it.
let outputText = "";
const getOutput = () => outputText;
function setOutput(text, original) {
  outputText = text || "";
  if (text && original != null && $("showDiff").checked && window.Diff) {
    const d = window.Diff.diffWords(original, text);
    output.innerHTML = d.html;
    changePctEl.textContent = d.changePct + "%";
  } else {
    output.textContent = text || "";
    changePctEl.textContent = "0%";
  }
  outWords.textContent = wc(outputText);
}

// Fill the before/after AI-likelihood strip from detector scores.
function showScoreStrip(original, humanized) {
  const before = window.Detector.detect(original);
  const after = window.Detector.detect(humanized);
  const fmt = (r) => (r.score == null ? "–" : r.score + "%");
  const tag = (r) => (r.score == null ? "(need ~20 words)" : r.label);
  const colorFor = (s) =>
    s == null ? "var(--muted)" : s >= 70 ? "#ef4444" : s >= 45 ? "#f59e0b" : "#22c55e";

  $("beforeScore").textContent = fmt(before);
  $("beforeScore").style.color = colorFor(before.score);
  $("beforeTag").textContent = tag(before);
  $("afterScore").textContent = fmt(after);
  $("afterScore").style.color = colorFor(after.score);
  $("afterTag").textContent = tag(after);

  const delta = $("scoreDelta");
  if (before.score != null && after.score != null) {
    const drop = before.score - after.score;
    delta.hidden = false;
    if (drop > 0) { delta.className = "score-delta good"; delta.textContent = `▼ ${drop} pts less AI`; }
    else if (drop < 0) { delta.className = "score-delta bad"; delta.textContent = `▲ ${-drop} pts more AI`; }
    else { delta.className = "score-delta"; delta.textContent = "no change"; }
  } else {
    delta.hidden = true;
  }
  $("scoreStrip").hidden = false;
}
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
  input.value = "";
  setOutput("");
  inWords.textContent = "0";
  $("scoreStrip").hidden = true;
};
$("copyBtn").onclick = async () => {
  const text = getOutput();
  if (!text) return;
  await navigator.clipboard.writeText(text);
  setStatus("Copied!", 1500);
};
$("showDiff").addEventListener("change", () => {
  if (getOutput()) setOutput(getOutput(), input.value.trim());
});

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

const RULES =
  " Keep it concise and simple. Short, plain sentences with varied length. " +
  "Do NOT use hyphens or dashes of any kind. Cut filler and AI cliches. " +
  "Keep the meaning. Output only the rewrite.";
const PROMPTS = {
  balanced: "Rewrite to sound natural and human." + RULES,
  simple: "Rewrite in plain, simple language a person would use." + RULES,
  casual: "Rewrite in a casual, conversational human tone with contractions." + RULES,
};

// Wrap the extension's chat() into the (systemPrompt, userText) shape the loop wants.
async function llmRewrite(systemPrompt, userText) {
  const { text } = await chat([
    { role: "system", content: systemPrompt },
    { role: "user", content: userText },
  ]);
  return text || "";
}

// Regenerate from scratch: summarize -> rewrite fresh from the notes following
// the anti-detection guidelines, then run the local humanizer as a finishing
// pass. Breaks the AI sentence skeleton entirely. `feedback`/`round` let the
// loop target surviving tells and escalate.
// Summarize step: reduce to bare styleless note fragments so NONE of the
// original AI phrasing or sentence structure survives into the rewrite.
const SUMMARIZE_PROMPT =
  "Reduce the text to its bare facts as a flat list of short note fragments. " +
  "Each note is 2 to 7 words, telegraphic style, no full sentences, no " +
  "transitions, no opinions. Capture every distinct fact, claim, name, number, " +
  "and step. Drop all original phrasing and structure. Output ONLY the notes, " +
  "one per line, each starting with '- '.";
const REGEN_RULES =
  " You are given NOTES, not prose — build the writing yourself. MOST IMPORTANT: " +
  "vary sentence length dramatically. Put a 3 to 6 word sentence next to a long " +
  "one. Never let several sentences in a row have similar length. Use specific, " +
  "concrete, sometimes unexpected words, not safe generic ones. Use contractions. " +
  "Start every sentence differently. Reorder points if it reads better. Do NOT " +
  "use hyphens/dashes, buzzwords (leverage/delve/foster/seamless/robust/crucial/" +
  "realm/landscape), phrases like 'in today's world' / 'it is important to note' / " +
  "'plays a role' / 'not just X but Y', or 'First,/Second,/Finally,' scaffolding. " +
  "No formulaic intro or conclusion. Keep about the same length. Output only the final text.";
// Latest extracted notes, surfaced to the UI.
let lastNotes = "";
async function llmRegenerate(text, mode, feedback, round) {
  const tone = mode === "simple" ? "in plain, simple language"
    : mode === "casual" ? "in a casual, conversational voice" : "naturally";
  const notes = await llmRewrite(SUMMARIZE_PROMPT, text);
  lastNotes = notes || "";
  let sys = `Write a human paragraph ${tone} from these notes.` + REGEN_RULES;
  if (round > 0) sys += " The previous attempt STILL read like AI. Smash the rhythm harder and use plainer, more specific words.";
  if (feedback) sys += ` Fix these tells the detector found: ${String(feedback).slice(0, 200)}.`;
  const draft = await llmRewrite(sys, notes || text);
  // finish(): light cleanup only, so we don't re-flatten the new rhythm.
  return window.Humanizer.finish((draft || "").trim(), mode);
}

// Loop-compatible regenerate: returns final text (string); notes are stashed.
async function regenerateForLoop(text, mode, feedback, round) {
  return await llmRegenerate(text, mode, feedback, round);
}

const btn = $("humanizeBtn");
btn.onclick = async () => {
  const text = input.value.trim();
  if (!text) { setStatus("Paste some text first", 2000); return; }

  // Default = deep summarize -> notes -> regenerate. "Fast local rewrite"
  // forces the offline rule-only pass (no LLM call).
  const fastLocal = $("fastLocal") && $("fastLocal").checked;
  btn.disabled = true;
  lastNotes = "";
  let result;

  try {
    if (fastLocal) {
      result = window.Humanizer.humanize(text, mode);
      setStatus("Done (fast local rewrite)", 1500);
    } else {
      setStatus("Summarizing to notes & rewriting…");
      try {
        const res = await window.loopHumanize(text, {
          mode,
          target: 30,
          maxRounds: 5,
          regenerate: regenerateForLoop,
          onRound: (info) => {
            if (info.text) setOutput(info.text, text);
            setStatus(`Round ${info.round + 1} · ${info.via} · ${info.score}% AI`);
          },
        });
        result = res.text;
        setStatus(
          res.hitTarget
            ? `Undetectable ✓ (${res.score}% AI, ${res.rounds} rounds)`
            : `Best effort: ${res.score}% AI after ${res.rounds} rounds`,
          4000
        );
      } catch (e) {
        result = window.Humanizer.humanize(text, mode);
        setStatus("⚠ AI model unreachable (start Ollama or set a key) — used fast local rewrite.", 5000);
      }
    }
  } catch (e) {
    if (!result) result = window.Humanizer.humanize(text, mode);
    setStatus("⚠ Rewrite error — used fast local rewrite.", 4000);
  } finally {
    btn.disabled = false;
  }

  setOutput(result, text);
  showScoreStrip(text, result);
  renderNotes();
  detectTarget = "output";
  syncDetectTabs();
  runDetect();

  // Retrospective: reflect (LLM reflection unless fast-local was forced).
  runRetro(text, result, !fastLocal);
};

// Show the extracted notes the rewrite was built from.
function renderNotes() {
  const card = $("notesCard"), body = $("notesBody");
  if (!card || !body) return;
  if (!lastNotes) { card.hidden = true; return; }
  const items = lastNotes.split(/\n+/).map((l) => l.replace(/^[-*]\s*/, "").trim()).filter(Boolean);
  if (!items.length) { card.hidden = true; return; }
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  body.innerHTML = `<ul class="notes-list">${items.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>`;
  card.hidden = false;
}

// Reflect on a run and persist learnings that improve future detect/humanize.
async function runRetro(inp, outp, useLLM) {
  if (!window.Retrospective || !window.Learnings) return;
  try {
    const after = window.Detector.detect(outp);
    const run = {
      input: inp, output: outp,
      beforeScore: window.Detector.detect(inp).score,
      afterScore: after.score,
      survivedSignals: (after.signals || []).filter((s) => s.contribution >= 25),
    };
    const reflector = useLLM ? llmRewrite : null;
    const res = await window.Retrospective.reflect(run, reflector);
    if (res && res.added) {
      const a = res.added, n = a.phrases + a.replacements + a.notes;
      if (n > 0) setStatus(`Learned ${a.phrases} tell(s), ${a.replacements} fix(es)`, 3000);
    }
  } catch { /* best-effort */ }
}

// Detector
const detectorBody = $("detectorBody");
function syncDetectTabs() {
  document.querySelectorAll(".seg-sm .seg-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.target === detectTarget)
  );
}
function runDetect() {
  const text = (detectTarget === "output" ? getOutput() : input.value).trim();
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
