// Runtime agents. Each agent is a specialist with a focused prompt + tools.
// The orchestrator picks (or the LLM routes to) the right one per task.

import { chat } from "../core/llm.js";
import { insightContext, logAction } from "../core/retrospective.js";
import { createAndRun, listTools, runOps } from "./toolfactory.js";
import {
  parseCanvasUrl, gatherCourse, upcomingAssignments,
  courseToPrompt, CanvasAPI, htmlToText,
} from "./canvas-api.js";
import { extractDocText } from "./docparse.js";

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
  },
  // Parse Canvas course/page info from the active tab's URL.
  async activeCanvas() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab?.url ? parseCanvasUrl(tab.url) : null;
  }
};

// In-memory cache of gathered course content, keyed by `${origin}:${courseId}`.
// Lets Canvas chat follow-ups reuse the fetch instead of re-reading every page.
const courseCache = new Map();
async function getCourseData(origin, courseId, force = false) {
  const key = `${origin}:${courseId}`;
  if (!force && courseCache.has(key)) return courseCache.get(key);
  const data = await gatherCourse(origin, courseId);
  courseCache.set(key, data);
  return data;
}

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

  // Rewrite text to read as naturally human-written and evade AI detectors.
  // Ported from the standalone "rewriter" project but run through this
  // extension's LLM layer. Uses a hot sampling preset for higher-perplexity,
  // less-detectable output. `payload.tone` sets the voice; `payload.selection`
  // (or page text) is the input.
  rewriter: {
    desc: "Rewrite text to sound human and undetectable by AI checkers.",
    async run(task, payload) {
      const text = (payload?.selection || "").trim() ||
        (await tools.getActiveTabText()).text.slice(0, 6000);
      if (!text) return { output: "Select text or open a page with text, then try again." };
      const tone = (payload?.tone || "natural").toLowerCase();
      const sys = "You rewrite text so it reads as genuinely human-written and is undetectable by AI checkers. Output ONLY the rewritten text — no preamble, no quotes, no meta-commentary.";
      const user =
        `Rewrite this text so it's undetectable by AI checkers. Rules:\n` +
        `- Use different words, phrasing, sentence structures, and idea order\n` +
        `- Vary length ±15-25%; mix short punchy sentences with longer ones\n` +
        `- Sound ${tone} but natural — a real person who writes well, not an AI\n` +
        `- Use contractions and casual connectors where they fit\n` +
        `- Avoid: "furthermore", "additionally", "it is important to note", "delve", "crucial", "leverage", "in conclusion", "utilize", "multifaceted"\n` +
        `- Real writing has personality and slight imperfections — add a few\n` +
        `- Keep the same meaning and key facts. Output ONLY the rewritten text.\n\n` +
        `Text to rewrite:\n${text}`;
      // Hot preset: push token choices toward higher perplexity.
      const ctx = await insightContext();
      const messages = [
        { role: "system", content: ctx ? `${sys}\n\n${ctx}` : sys },
        { role: "user", content: user },
      ];
      const { text: out, provider } = await chat(messages, {
        temperature: 1.0, top_p: 0.95, frequency_penalty: 0.3, presence_penalty: 0.3,
      });
      return { output: out.trim(), provider, tone };
    }
  },

  // Canvas LMS assistant: reads a course's pages/modules/assignments/files via
  // the Canvas REST API (using the user's session) and summarizes, builds study
  // aids, lists due dates, or answers questions grounded in the course.
  // `payload.canvas` = { origin, courseId, pageUrl }; `payload.mode` selects the
  // feature (summary | studyGuide | quiz | due | page | chat).
  canvas: {
    desc: "Read a Canvas course (pages, modules, assignments, files) and summarize, build study aids, list due dates, or answer questions.",
    async run(task, payload) {
      const cv = payload?.canvas || (await tools.activeCanvas());
      if (!cv?.courseId) {
        return { output: "Open a Canvas course page first (a URL like .../courses/12345/...)." };
      }
      const { origin, courseId, pageUrl } = cv;
      // Decide the mode from payload or the task wording.
      let mode = payload?.mode;
      if (!mode) {
        const t = task.toLowerCase();
        if (/\b(due|deadline|upcoming|assignment.*(when|due))\b/.test(t)) mode = "due";
        else if (/\b(slide|powerpoint|ppt|lecture|pdf|reading|document)\b/.test(t)) mode = "slides";
        else if (/\b(study guide|review sheet)\b/.test(t)) mode = "studyGuide";
        else if (/\b(quiz|practice question|test me)\b/.test(t)) mode = "quiz";
        else if (/\b(this page|current page)\b/.test(t) && pageUrl) mode = "page";
        else if (/\b(summar|overview|tl;?dr)\b/.test(t)) mode = "summary";
        else mode = "chat";
      }

      // Due dates: pure data, no LLM.
      if (mode === "due") {
        const list = await upcomingAssignments(origin, courseId);
        if (!list.length) return { output: "No upcoming assignments with due dates.", provider: "canvas" };
        const lines = list.map((a) => {
          const due = new Date(a.due).toLocaleString();
          const pts = a.points != null ? ` · ${a.points} pts` : "";
          return `• ${a.name} — due ${due}${pts}`;
        });
        return { output: "**Upcoming assignments:**\n" + lines.join("\n"), provider: "canvas", due: list };
      }

      // Single page summary.
      if (mode === "page") {
        if (!pageUrl) return { output: "Open a specific Canvas page to summarize it." };
        const api = new CanvasAPI(origin);
        const page = await api.getPage(courseId, pageUrl);
        const content = `# ${page.title}\n\n${htmlToText(page.body)}`.slice(0, 16000);
        const { text: out, provider } = await ask(
          "Summarize this single Canvas page for a student in a few clear bullet points. Be concise.",
          content, payload?.history);
        return { output: out, provider };
      }

      // Slides/documents: find PDF/PPTX files, extract text, summarize.
      if (mode === "slides") {
        const all = await new CanvasAPI(origin).getFiles(courseId);
        const docs = all
          .map((f) => ({ name: f.display_name || f.filename, type: f.content_type || "", url: f.url }))
          .filter((f) => /pdf|presentation|powerpoint|pptx?/i.test(f.type + " " + f.name));
        if (!docs.length) {
          return { output: "No readable PDF or PowerPoint files found in this course's Files.", provider: "canvas" };
        }
        // Pick the file the user named, else the only one, else list choices.
        const named = payload?.fileName
          ? docs.find((d) => d.name === payload.fileName)
          : docs.find((d) => task.toLowerCase().includes(d.name.toLowerCase().replace(/\.[^.]+$/, "")));
        const pick = named || (docs.length === 1 ? docs[0] : null);
        if (!pick) {
          const list = docs.map((d) => `• ${d.name}`).join("\n");
          return {
            output: `Found ${docs.length} readable files. Tell me which one to summarize:\n${list}`,
            provider: "canvas", files: docs,
          };
        }
        let text;
        try {
          text = await extractDocText(pick.url, pick.type + " " + pick.name);
        } catch (e) {
          return { output: `Couldn't read "${pick.name}": ${e.message}. It may be a scanned/image file (no text layer).`, provider: "canvas" };
        }
        if (!text.trim()) {
          return { output: `"${pick.name}" has no extractable text (likely scanned images — would need OCR).`, provider: "canvas" };
        }
        const { text: out, provider } = await ask(
          "Summarize these lecture slides / document for a student. Use short sections and bullets. Note key concepts and any definitions. Be concise.",
          `# ${pick.name}\n\n${text.slice(0, 18000)}`, payload?.history);
        return { output: out, provider, meta: pick.name };
      }

      // Whole-course modes (summary / studyGuide / quiz / chat) use gathered content.
      const data = await getCourseData(origin, courseId);
      const context = courseToPrompt(data);
      const SYS = {
        summary: "Summarize this Canvas course for a student. Use short sections and bullets. Be concise.",
        studyGuide: "Create a study guide from this Canvas content: key concepts, definitions, likely exam topics. Be concise.",
        quiz: "Write 5 practice questions with answers based on this Canvas content. Be concise.",
        chat: "You are a study assistant. Answer the student's question using ONLY the provided Canvas course content. If the answer isn't in it, say so. Be concise.",
      };
      const sys = SYS[mode] || SYS.chat;
      const user = mode === "chat"
        ? `COURSE CONTENT:\n${context}\n\nQUESTION: ${task}`
        : context;
      const { text: out, provider } = await ask(sys, user, payload?.history);
      const meta = `${data.pages.length} pages · ${data.modules.length} modules · ${data.files.length} files`;
      return { output: out, provider, meta };
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
    ["canvas", /\b(canvas|course|module|syllabus|assignment|due date|deadline|study guide|lecture|powerpoint|professor posted)\b/],
    ["rewriter", /\b(undetectable|bypass ai|evade detect|ai checker|turnitin|make.*(undetectable|human)|rewrite.*(undetectable|to pass))\b/],
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
