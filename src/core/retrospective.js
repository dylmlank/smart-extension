// Retrospective: a constant self-improvement loop.
// Every agent action is logged. Periodically the system reflects on the log,
// extracts learnings, and stores "insights" that get injected into future
// agent prompts — so the assistant gets smarter the more you use it.

import { chat } from "./llm.js";

const LOG_KEY = "retro_log";
const INSIGHTS_KEY = "retro_insights";
const MAX_LOG = 200;

export async function logAction(entry) {
  const { [LOG_KEY]: log = [] } = await chrome.storage.local.get(LOG_KEY);
  log.push({ t: Date.now(), ...entry });
  if (log.length > MAX_LOG) log.splice(0, log.length - MAX_LOG);
  await chrome.storage.local.set({ [LOG_KEY]: log });
}

export async function getInsights() {
  const { [INSIGHTS_KEY]: ins = [] } = await chrome.storage.local.get(INSIGHTS_KEY);
  return ins;
}

// Build a short context string of learnings to inject into agent prompts.
export async function insightContext() {
  const ins = await getInsights();
  if (!ins.length) return "";
  return "Learnings from past sessions:\n" + ins.slice(-5).map(i => `- ${i.text}`).join("\n");
}

// Reflect on recent actions: what worked, what failed, what to do differently.
export async function runRetrospective() {
  const { [LOG_KEY]: log = [] } = await chrome.storage.local.get(LOG_KEY);
  if (log.length < 5) return { skipped: true, reason: "not enough activity" };

  const recent = log.slice(-40);
  const summary = recent
    .map(e => `[${e.agent || "?"}] ${e.task || ""} -> ${e.outcome || "?"}${e.error ? " (ERR: " + e.error + ")" : ""}`)
    .join("\n");

  const messages = [
    {
      role: "system",
      content:
        "You are a retrospective analyst for a browser assistant. Read the action log and output 1-3 concise, actionable learnings to improve future behavior. Each learning = one short line. No preamble."
    },
    { role: "user", content: `Action log:\n${summary}\n\nWhat should the assistant do differently? Reply as bullet lines only.` }
  ];

  try {
    const { text, provider } = await chat(messages);
    const learnings = text
      .split("\n")
      .map(l => l.replace(/^[-*•\d.\s]+/, "").trim())
      .filter(Boolean)
      .slice(0, 3);

    const { [INSIGHTS_KEY]: ins = [] } = await chrome.storage.local.get(INSIGHTS_KEY);
    const stamped = learnings.map(text => ({ t: Date.now(), text }));
    const merged = [...ins, ...stamped].slice(-20);
    await chrome.storage.local.set({ [INSIGHTS_KEY]: merged });

    await logAction({ agent: "retrospective", task: "reflect", outcome: `+${learnings.length} insights via ${provider}` });
    return { learnings, provider };
  } catch (e) {
    await logAction({ agent: "retrospective", task: "reflect", outcome: "failed", error: String(e.message || e) });
    return { error: String(e.message || e) };
  }
}
