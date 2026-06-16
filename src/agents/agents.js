// Runtime agents. Each agent is a specialist with a focused prompt + tools.
// The orchestrator picks (or the LLM routes to) the right one per task.

import { chat } from "../core/llm.js";
import { insightContext, logAction } from "../core/retrospective.js";
import { createAndRun, listTools, runOps } from "./toolfactory.js";

// ---- Tools the agents can use (browser side effects) ----
const tools = {
  async getActiveTabText() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return { text: "", tab };
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => document.body.innerText.slice(0, 8000)
    });
    return { text: result || "", tab };
  },
  async allTabs() {
    return chrome.tabs.query({});
  },
  async closeTabs(ids) {
    if (ids?.length) await chrome.tabs.remove(ids);
    return ids?.length || 0;
  },
  async groupTabs(tabIds, title) {
    const groupId = await chrome.tabs.group({ tabIds });
    await chrome.tabGroups.update(groupId, { title });
    return groupId;
  }
};

// `history` is an optional array of prior {role, content} turns so the agent
// can answer follow-up questions in context. We cap it to the last few turns
// to keep prompts short on the free tier.
async function ask(system, user, history) {
  const ctx = await insightContext();
  const past = Array.isArray(history) ? history.slice(-6) : [];
  const messages = [
    { role: "system", content: ctx ? `${system}\n\n${ctx}` : system },
    ...past,
    { role: "user", content: user }
  ];
  return chat(messages);
}

// ---- Specialist agents ----
export const AGENTS = {
  summarizer: {
    desc: "Summarize the current page or answer questions about it.",
    async run(task, payload) {
      // On a follow-up we already have the page in history — don't re-extract.
      const hasHistory = payload?.history?.length;
      const pageBlock = hasHistory ? "" : `PAGE:\n${(await tools.getActiveTabText()).text}\n\n`;
      const sys = "Summarize web pages clearly and concisely. If asked a question, answer using only the page. Keep answers tight.";
      const { text: out, provider } = await ask(sys, `${pageBlock}TASK: ${task}`, payload?.history);
      return { output: out, provider };
    }
  },

  organizer: {
    desc: "Organize, group, dedupe, or close tabs.",
    async run(task) {
      const all = await tools.allTabs();
      const list = all.map(t => `${t.id}: ${t.title} (${t.url})`).join("\n");
      const sys =
        'You organize browser tabs. Output ONLY JSON: {"groups":[{"title":"X","tabIds":[1,2]}],"close":[3]}. Group by topic, suggest closing duplicates/empty tabs.';
      const { text: out, provider } = await ask(sys, `TABS:\n${list}\n\nTASK: ${task}`);
      let plan = {};
      try { plan = JSON.parse(out.match(/\{[\s\S]*\}/)?.[0] || "{}"); } catch {}
      let acted = [];
      try {
        for (const g of plan.groups || []) {
          if (g.tabIds?.length) { await tools.groupTabs(g.tabIds, g.title); acted.push(`grouped "${g.title}"`); }
        }
        if (plan.close?.length) { await tools.closeTabs(plan.close); acted.push(`closed ${plan.close.length}`); }
      } catch (e) { acted.push("partial: " + e.message); }
      return { output: acted.length ? acted.join(", ") : "no changes", provider, plan };
    }
  },

  researcher: {
    desc: "Explain highlighted text, take notes, build a research log.",
    async run(task, payload) {
      const sel = payload?.selection || (await tools.getActiveTabText()).text.slice(0, 2000);
      const sys = "You are a research assistant. Explain clearly, then give 2-3 follow-up angles to explore.";
      const { text: out, provider } = await ask(sys, `CONTEXT:\n${sel}\n\nTASK: ${task}`, payload?.history);
      const { researchLog = [] } = await chrome.storage.local.get("researchLog");
      researchLog.push({ t: Date.now(), task, note: out.slice(0, 500) });
      await chrome.storage.local.set({ researchLog: researchLog.slice(-100) });
      return { output: out, provider };
    }
  },

  focus: {
    desc: "Track time on sites and nudge off distractions.",
    async run(task) {
      const { focusStats = {} } = await chrome.storage.local.get("focusStats");
      const top = Object.entries(focusStats)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([d, s]) => `${d}: ${Math.round(s / 60000)}min`)
        .join("\n") || "no data yet";
      const sys = "You are a focus coach. Be brief, kind, and specific. Suggest one concrete action.";
      const { text: out, provider } = await ask(sys, `TIME ON SITES TODAY:\n${top}\n\nTASK: ${task}`);
      return { output: out, provider };
    }
  },

  // The self-extending agent: when no specialist fits, it CREATES a tool
  // for the task (or reuses one it built earlier) and runs it.
  builder: {
    desc: "Handle any other task by reusing or building a new custom tool.",
    async run(task, payload) {
      const existing = await listTools();

      // Try to reuse a tool it already built for a similar task.
      if (Object.keys(existing).length) {
        const menu = Object.entries(existing)
          .map(([n, t]) => `${n}: ${t.desc}`)
          .join("\n");
        const { text } = await ask(
          `You have these custom tools:\n${menu}\n\nIf ONE clearly fits the task, reply with just its name. Otherwise reply "NONE".`,
          task
        );
        const pick = text.trim().split(/\s+/)[0];
        if (existing[pick]) {
          const result = await runOps(existing[pick], payload || {});
          return { output: typeof result === "string" ? result : JSON.stringify(result, null, 2),
                   provider: "custom-tool", tool: pick, reused: true };
        }
      }

      // None fit — build a new one and run it.
      const { tool, provider, result } = await createAndRun(task, payload || {});
      const output = typeof result === "string" ? result : JSON.stringify(result, null, 2);
      return { output: `🔧 Built tool "${tool}" and ran it:\n\n${output}`, provider, tool, created: true };
    }
  }
};

// Strong keyword signals — when these clearly match, skip the LLM round-trip.
function keywordRoute(t) {
  const tests = [
    ["organizer", /\b(tabs?|group|organi[sz]e|declutter|close|dedup|duplicate)\b/],
    ["focus", /\b(focus|distract|time on|productiv|how am i doing|screen time)\b/],
    ["researcher", /\b(research|explain|what does|note|study|look ?up|tell me about)\b/],
    ["summarizer", /\b(summar|tl;?dr|key points|gist|what.*(page|article|this))\b/],
  ];
  for (const [name, re] of tests) if (re.test(t)) return name;
  return null;
}

// LLM router: returns { agent, confidence } so we only fall back to the
// self-building agent when the model is genuinely unsure.
async function llmRoute(task) {
  const menu = Object.entries(AGENTS).map(([k, v]) => `${k}: ${v.desc}`).join("\n");
  const { text } = await ask(
    `Route the user's task to exactly ONE agent. ` +
    `Reply ONLY as JSON: {"agent":"<name>","confidence":0-1}. ` +
    `Use "builder" only if no specialist fits. Agents:\n${menu}`,
    task
  );
  try {
    const j = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
    const agent = String(j.agent || "").toLowerCase().trim();
    const confidence = typeof j.confidence === "number" ? j.confidence : 0.5;
    if (AGENTS[agent]) return { agent, confidence };
  } catch {}
  // Couldn't parse — treat the first token as the answer, low confidence.
  const first = text.trim().split(/\s+/)[0].toLowerCase();
  return { agent: AGENTS[first] ? first : "builder", confidence: 0.3 };
}

// ---- Orchestrator: route a free-form task to the right agent ----
// `history` (optional) is prior [{role, content}] turns for follow-ups.
export async function orchestrate(task, payload, history) {
  const t = task.toLowerCase();

  // 1) Cheap keyword routing for clear cases.
  let name = keywordRoute(t);
  let confidence = name ? 0.9 : 0;

  // 2) Otherwise ask the LLM, with a confidence score.
  if (!name) {
    const r = await llmRoute(task);
    name = r.agent;
    confidence = r.confidence;
    // Low confidence in a specialist => let the builder handle it instead.
    if (confidence < 0.45 && name !== "builder") name = "builder";
  }
  if (!AGENTS[name]) name = "builder";

  try {
    const res = await AGENTS[name].run(task, { ...(payload || {}), history });
    await logAction({ agent: name, task: task.slice(0, 80), outcome: "ok via " + res.provider });
    return { agent: name, confidence, ...res };
  } catch (e) {
    await logAction({ agent: name, task: task.slice(0, 80), outcome: "error", error: String(e.message || e) });
    return { agent: name, confidence, output: "Error: " + (e.message || e), error: true };
  }
}
