// Runtime agents. Each agent is a specialist with a focused prompt + tools.
// The orchestrator picks (or the LLM routes to) the right one per task.

import { chat } from "../core/llm.js";
import { insightContext, logAction } from "../core/retrospective.js";

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

async function ask(system, user) {
  const ctx = await insightContext();
  const messages = [
    { role: "system", content: ctx ? `${system}\n\n${ctx}` : system },
    { role: "user", content: user }
  ];
  return chat(messages);
}

// ---- Specialist agents ----
export const AGENTS = {
  summarizer: {
    desc: "Summarize the current page or answer questions about it.",
    async run(task) {
      const { text } = await tools.getActiveTabText();
      const sys = "Summarize web pages clearly and concisely. If asked a question, answer using only the page.";
      const { text: out, provider } = await ask(sys, `PAGE:\n${text}\n\nTASK: ${task}`);
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
      const { text: out, provider } = await ask(sys, `CONTEXT:\n${sel}\n\nTASK: ${task}`);
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
  }
};

// ---- Orchestrator: route a free-form task to the right agent ----
export async function orchestrate(task, payload) {
  // Cheap keyword routing first; LLM routing as fallback.
  const t = task.toLowerCase();
  let name =
    /tab|group|organi|close|dedup/.test(t) ? "organizer" :
    /focus|distract|time|productiv/.test(t) ? "focus" :
    /research|explain|note|study|learn/.test(t) ? "researcher" :
    /summar|tl;?dr|what.*page|question/.test(t) ? "summarizer" :
    null;

  if (!name) {
    const menu = Object.entries(AGENTS).map(([k, v]) => `${k}: ${v.desc}`).join("\n");
    const { text } = await ask(
      `Route the task to ONE agent. Reply with only the agent name.\nAgents:\n${menu}`,
      task
    );
    name = text.trim().split(/\s+/)[0].toLowerCase();
  }
  if (!AGENTS[name]) name = "summarizer";

  try {
    const res = await AGENTS[name].run(task, payload);
    await logAction({ agent: name, task: task.slice(0, 80), outcome: "ok via " + res.provider });
    return { agent: name, ...res };
  } catch (e) {
    await logAction({ agent: name, task: task.slice(0, 80), outcome: "error", error: String(e.message || e) });
    return { agent: name, output: "Error: " + (e.message || e), error: true };
  }
}
