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

  // Rewrite, fix, or restyle a piece of text. Powers the inline writing
  // assistant: grammar fixes, tone shifts (professional/casual/concise/friendly),
  // expand/shorten, and "humanize". `payload.style` selects the transform;
  // `payload.selection` (or the page text) is the input.
  writer: {
    desc: "Rewrite, fix grammar, or change the tone of selected text.",
    async run(task, payload) {
      const text = (payload?.selection || "").trim() ||
        (await tools.getActiveTabText()).text.slice(0, 4000);
      if (!text) return { output: "Select some text first, then try again." };
      const style = (payload?.style || "").toLowerCase();
      const STYLES = {
        fix: "Fix grammar, spelling, and punctuation. Keep the meaning and voice. Return ONLY the corrected text.",
        professional: "Rewrite in a clear, professional tone. Return ONLY the rewrite.",
        casual: "Rewrite in a relaxed, friendly, conversational tone. Return ONLY the rewrite.",
        concise: "Make it as concise as possible without losing meaning. Return ONLY the rewrite.",
        expand: "Expand with more detail and clarity, staying on topic. Return ONLY the rewrite.",
        friendly: "Rewrite to sound warm and approachable. Return ONLY the rewrite.",
        humanize: "Rewrite to read human. Vary sentence length hard: mix very short sentences with long ones. Pick specific, surprising words, not safe generic ones. Use contractions, cut clichés. No dashes. Return ONLY the rewrite.",
      };
      const instruction = STYLES[style] ||
        "Improve this text: fix errors and make it clearer and more natural. Return ONLY the improved text.";
      const sys = "You are a precise writing assistant. Output only the rewritten text, no preamble, no quotes.";
      const { text: out, provider } = await ask(sys, `${instruction}\n\nTEXT:\n${text}`, payload?.history);
      return { output: out.trim(), provider, style: style || "improve" };
    }
  },

  // Translate selected text (or the page) to a target language. Detects the
  // target from the task ("translate to Spanish") or payload.lang.
  translator: {
    desc: "Translate selected text or the page to another language.",
    async run(task, payload) {
      const text = (payload?.selection || "").trim() ||
        (await tools.getActiveTabText()).text.slice(0, 4000);
      if (!text) return { output: "Select text or open a page, then try again." };
      // Pull the target language from the payload or the task wording.
      let lang = payload?.lang;
      if (!lang) {
        const m = task.match(/(?:to|into|in)\s+([A-Za-z]+)\s*$/i) ||
                  task.match(/translate\s+(?:this\s+)?(?:to|into)\s+([A-Za-z]+)/i);
        lang = m ? m[1] : "English";
      }
      const sys = "You are a translator. Output ONLY the translation, preserving meaning, tone, and formatting. No notes.";
      const { text: out, provider } = await ask(sys, `Translate the following into ${lang}:\n\n${text}`);
      return { output: out.trim(), provider, lang };
    }
  },

  // Chat with the current page/article: answer questions grounded in the page,
  // with follow-ups. Richer than the summarizer — it also surfaces reading time
  // and key takeaways on the first turn when no specific question is asked.
  pageChat: {
    desc: "Answer questions about the current page or article, with follow-ups.",
    async run(task, payload) {
      const hasHistory = payload?.history?.length;
      let pageBlock = "", meta = "";
      if (!hasHistory) {
        const { text } = await tools.getActiveTabText();
        pageBlock = `PAGE:\n${text}\n\n`;
        const words = (text.match(/\S+/g) || []).length;
        meta = `~${Math.max(1, Math.round(words / 220))} min read`;
      }
      const generic = /^(summari|key points|takeaways|tl;?dr|what'?s this|explain this page)/i.test(task.trim());
      const sys = generic
        ? "Read the page and reply with: a one-line gist, then 3-5 bullet key takeaways. Be specific and tight. Use only the page."
        : "Answer the user's question using ONLY the page content. If it's not in the page, say so. Keep it tight and cite the relevant part briefly.";
      const { text: out, provider } = await ask(sys, `${pageBlock}TASK: ${task}`, payload?.history);
      return { output: out, provider, meta };
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
    ["translator", /\b(translate|translation|in (?:spanish|french|german|chinese|japanese|italian|portuguese|korean|arabic|russian|hindi)|to (?:spanish|french|german|chinese|japanese|italian|portuguese|korean|arabic|russian|hindi))\b/],
    ["writer", /\b(rewrite|reword|paraphrase|fix (?:grammar|this|the)|grammar|proofread|make.*(shorter|concise|professional|casual|friendly|formal)|change the tone|humanize)\b/],
    ["organizer", /\b(tabs?|group|organi[sz]e|declutter|close|dedup|duplicate)\b/],
    ["focus", /\b(focus|distract|time on|productiv|how am i doing|screen time)\b/],
    ["pageChat", /\b(ask (?:this|the) page|chat with|about (?:this|the) (?:page|article)|takeaways|reading time)\b/],
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
