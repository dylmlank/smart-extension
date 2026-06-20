// Tool Factory: lets the assistant CREATE its own tools at runtime.
//
// MV3 service workers forbid eval()/new Function() (CSP). So instead of running
// arbitrary generated JS, the LLM defines a tool as a *plan of safe ops* drawn
// from a fixed vocabulary. A sandboxed interpreter (runOps) executes them.
// This gives genuine self-extension without an arbitrary-code-execution hole.
//
// Each tool: { name, desc, params:[...], steps:[ {op, ...args} ] }
// Steps can reference prior results and params via "$name" placeholders.

import { chat } from "../core/llm.js";
import { CanvasAPI, parseCanvasUrl, gatherCourse, courseToPrompt } from "./canvas-api.js";
import { extractDocText } from "./docparse.js";

const TOOLS_KEY = "custom_tools";
const CODE_MODE_KEY = "codeModeEnabled";

// ---------------------------------------------------------------------------
// OPT-IN CODE MODE: run real generated JS in a sandboxed offscreen iframe.
// Off by default. When on, the builder can write arbitrary JS instead of the
// constrained op-plan — more powerful, gated behind a settings toggle.
// ---------------------------------------------------------------------------

export async function isCodeModeEnabled() {
  const { [CODE_MODE_KEY]: on } = await chrome.storage.local.get(CODE_MODE_KEY);
  return !!on;
}

let offscreenReady = null;
async function ensureOffscreen() {
  if (offscreenReady) return offscreenReady;
  offscreenReady = (async () => {
    const existing = await chrome.runtime.getContexts?.({
      contextTypes: ["OFFSCREEN_DOCUMENT"]
    }).catch(() => []);
    if (!existing || existing.length === 0) {
      await chrome.offscreen.createDocument({
        url: "src/offscreen/offscreen.html",
        reasons: ["IFRAME_SCRIPTING"],
        justification: "Run user-approved generated tool code in a sandboxed iframe."
      });
    }
  })();
  return offscreenReady;
}

// Execute arbitrary JS (body of an async fn with `api` and `params` in scope).
export async function execJs(code, params = {}) {
  if (!(await isCodeModeEnabled())) {
    throw new Error("Code mode is off. Enable it in Settings to run generated JS.");
  }
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ type: "offscreen-execJs", code, params });
  if (res?.error) throw new Error(res.error);
  return res?.result;
}

// ---- Allowed operations (the entire capability surface) ----
const OPS = {
  // HTTP GET, returns text (capped)
  async fetchText(args, ctx) {
    const url = resolve(args.url, ctx);
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return (await res.text()).slice(0, 12000);
  },
  // HTTP GET JSON
  async fetchJson(args, ctx) {
    const url = resolve(args.url, ctx);
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    return res.json();
  },
  // Query browser tabs
  async queryTabs(args) {
    return (await chrome.tabs.query(args.query || {})).map(t => ({
      id: t.id, title: t.title, url: t.url
    }));
  },
  // Extract text/HTML from the active page via a CSS selector
  async extract(args, ctx) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) return "";
    const sel = resolve(args.selector || "body", ctx);
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [sel, !!args.html],
      func: (s, html) => {
        const els = [...document.querySelectorAll(s)];
        return els.map(e => html ? e.innerHTML : e.innerText).join("\n").slice(0, 12000);
      }
    });
    return result || "";
  },
  // Persist a value
  async store(args, ctx) {
    await chrome.storage.local.set({ [args.key]: resolve(args.value, ctx) });
    return "stored " + args.key;
  },
  async load(args) {
    const o = await chrome.storage.local.get(args.key);
    return o[args.key] ?? null;
  },
  // Ask the LLM to transform/reason over collected data
  async llm(args, ctx) {
    const prompt = resolve(args.prompt, ctx);
    const data = args.input ? "\n\nDATA:\n" + JSON.stringify(resolve(args.input, ctx)).slice(0, 8000) : "";
    const { text } = await chat([
      { role: "system", content: args.system || "You are a helpful tool step. Be concise." },
      { role: "user", content: prompt + data }
    ]);
    return text;
  },
  // Open a URL in a new tab
  async openTab(args, ctx) {
    const tab = await chrome.tabs.create({ url: resolve(args.url, ctx), active: !!args.focus });
    return { id: tab.id };
  },
  // Read the Canvas course of the active tab (or an explicit {origin,courseId}).
  // Returns a flattened text digest of pages/modules/assignments/files.
  async canvasCourse(args, ctx) {
    let origin = resolve(args.origin, ctx), courseId = resolve(args.courseId, ctx);
    if (!origin || !courseId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const cv = tab?.url ? parseCanvasUrl(tab.url) : null;
      origin = origin || cv?.origin;
      courseId = courseId || cv?.courseId;
    }
    if (!origin || !courseId) throw new Error("no Canvas course (open a course tab or pass origin+courseId)");
    const data = await gatherCourse(origin, courseId);
    return courseToPrompt(data, args.maxChars || 20000);
  },
  // List a Canvas course's files (name, type, download url).
  async canvasFiles(args, ctx) {
    let origin = resolve(args.origin, ctx), courseId = resolve(args.courseId, ctx);
    if (!origin || !courseId) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const cv = tab?.url ? parseCanvasUrl(tab.url) : null;
      origin = origin || cv?.origin;
      courseId = courseId || cv?.courseId;
    }
    if (!origin || !courseId) throw new Error("no Canvas course");
    const files = await new CanvasAPI(origin).getFiles(courseId);
    return files.map((f) => ({ name: f.display_name || f.filename, type: f.content_type, url: f.url }));
  },
  // Extract text from a PDF/PPTX at a URL (e.g. a Canvas file).
  async readDoc(args, ctx) {
    const url = resolve(args.url, ctx);
    return (await extractDocText(url, resolve(args.hint, ctx) || "")).slice(0, 16000);
  },
  // Save data to a file via the downloads API.
  async download(args, ctx) {
    const filename = resolve(args.filename, ctx) || "smart-assistant-output.txt";
    let url = resolve(args.url, ctx);
    if (!url) {
      const content = resolve(args.content, ctx);
      const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
      // data: URL so we don't need a Blob URL lifecycle in the worker.
      url = "data:text/plain;charset=utf-8," + encodeURIComponent(text);
    }
    const id = await chrome.downloads.download({ url, filename, saveAs: false });
    return { downloadId: id, filename };
  },
  // Copy text to the clipboard (best-effort; needs a focused document context).
  async clipboard(args, ctx) {
    const text = String(resolve(args.text, ctx) ?? "");
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id }, args: [text],
        func: (t) => navigator.clipboard.writeText(t).catch(() => {}),
      });
    }
    return "copied";
  },
  // Show a desktop notification.
  async notify(args, ctx) {
    chrome.notifications?.create({
      type: "basic",
      iconUrl: chrome.runtime.getURL("icons/icon128.png"),
      title: resolve(args.title, ctx) || "Smart Assistant",
      message: String(resolve(args.message, ctx) ?? ""),
    });
    return "notified";
  }
};

// Resolve "$ref" placeholders against params + accumulated step results.
function resolve(v, ctx) {
  if (typeof v === "string" && v.startsWith("$")) {
    const key = v.slice(1);
    return key in ctx ? ctx[key] : v;
  }
  if (Array.isArray(v)) return v.map(x => resolve(x, ctx));
  if (v && typeof v === "object") {
    const o = {};
    for (const k in v) o[k] = resolve(v[k], ctx);
    return o;
  }
  return v;
}

// ---- Execute a tool. Dispatches on mode: safe op-plan, or sandboxed code. ----
export async function runOps(tool, params = {}) {
  if (tool.mode === "code") {
    // Real JS, executed in the sandboxed offscreen iframe (opt-in only).
    return execJs(tool.code, params);
  }
  const ctx = { ...params };
  let last = null;
  for (const [i, step] of (tool.steps || []).entries()) {
    const op = OPS[step.op];
    if (!op) throw new Error(`unknown op: ${step.op}`);
    last = await op(step, ctx);
    ctx[step.as || `step${i}`] = last; // make result referenceable
  }
  return last;
}

// ---- Storage of custom tools ----
export async function listTools() {
  const { [TOOLS_KEY]: tools = {} } = await chrome.storage.local.get(TOOLS_KEY);
  return tools;
}
export async function saveTool(tool) {
  const tools = await listTools();
  tools[tool.name] = tool;
  await chrome.storage.local.set({ [TOOLS_KEY]: tools });
  return tool;
}
export async function deleteTool(name) {
  const tools = await listTools();
  delete tools[name];
  await chrome.storage.local.set({ [TOOLS_KEY]: tools });
}

// ---- Validation: every step must use an allowed op ----
function validate(tool) {
  if (!tool || typeof tool.name !== "string") throw new Error("tool needs a name");
  tool.name = tool.name.replace(/[^a-z0-9_]/gi, "_").slice(0, 40);
  if (!Array.isArray(tool.steps) || !tool.steps.length) throw new Error("tool needs steps");
  for (const s of tool.steps) {
    if (!OPS[s.op]) throw new Error(`step uses disallowed op "${s.op}". Allowed: ${Object.keys(OPS).join(", ")}`);
  }
  return tool;
}

// ---- Code-mode factory: ask the LLM to WRITE real JS for the task ----
async function createCodeTool(taskDescription) {
  const apiDocs = `
You write the BODY of an async function. Available in scope:
  api.fetchText(url, opts?)   -> string
  api.fetchJson(url, opts?)   -> parsed JSON
  api.queryTabs(query?)       -> [{id,title,url}]
  api.extract(selector, html?)-> text/html from the active page
  api.store(key, value) / api.load(key)
  api.llm(prompt, system?)    -> string from the language model
  api.openTab(url, focus?)    -> {id}
  api.canvasCourse(opts?)     -> text digest of the active Canvas course
  api.canvasFiles(opts?)      -> [{name,type,url}] of the course's files
  api.readDoc(url, hint?)     -> text extracted from a PDF/PPTX at url
  api.download(filename, content?, url?) -> save a file
  api.clipboard(text)         -> copy to clipboard
  api.notify(title, message)  -> desktop notification
  api.log(...)                -> debug log
  params                      -> object of inputs
You may use loops, try/catch, JSON, fetch results, etc.
End by 'return'ing the final result (string or JSON-serializable).`;

  const sys = `You author browser-automation tools as JavaScript. ${apiDocs}\n\nOutput STRICT JSON only:\n{"name":"snake_case","desc":"what it does","params":["arg1"],"mode":"code","code":"<the async function body>"}\nThe "code" value is JS as a JSON string. No markdown, no prose.`;

  const { text, provider } = await chat([
    { role: "system", content: sys },
    { role: "user", content: `Write a tool for this task:\n${taskDescription}` }
  ]);

  let tool;
  try {
    tool = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {
    throw new Error("LLM did not return valid tool JSON");
  }
  if (typeof tool.code !== "string" || !tool.code.trim()) throw new Error("code tool has no code");
  tool.mode = "code";
  tool.name = String(tool.name || "tool").replace(/[^a-z0-9_]/gi, "_").slice(0, 40);
  await saveTool(tool);
  return { tool, provider };
}

// ---- The factory: ask the LLM to DESIGN a new tool for a task ----
export async function createTool(taskDescription) {
  if (await isCodeModeEnabled()) return createCodeTool(taskDescription);
  const opDocs = `
fetchText {url}            -> GET url, returns text
fetchJson {url}            -> GET url, returns parsed JSON
queryTabs {query}          -> list of {id,title,url}
extract {selector,html}    -> text/html from active page matching CSS selector
store {key,value} / load {key}
llm {prompt,system,input}  -> run the language model on collected data
openTab {url,focus}        -> open a new tab
canvasCourse {origin?,courseId?,maxChars?} -> text digest of the active (or given) Canvas course
canvasFiles {origin?,courseId?}            -> list of the course's files [{name,type,url}]
readDoc {url,hint?}        -> extract text from a PDF/PPTX at url (e.g. a Canvas file)
download {filename,content?,url?} -> save content (or a url) to a file
clipboard {text}           -> copy text to the clipboard
notify {title,message}     -> show a desktop notification
Reference earlier results/params with "$name". Give each step an "as" name to reuse it.`;

  const sys = `You design small automation tools as JSON. ONLY use these ops:\n${opDocs}\n\nOutput STRICT JSON only:\n{"name":"snake_case","desc":"what it does","params":["arg1"],"steps":[{"op":"...","as":"x", ...}]}\nNo prose, no markdown fences.`;

  const { text, provider } = await chat([
    { role: "system", content: sys },
    { role: "user", content: `Design a tool for this task:\n${taskDescription}` }
  ]);

  let tool;
  try {
    tool = JSON.parse(text.match(/\{[\s\S]*\}/)?.[0] || "{}");
  } catch {
    throw new Error("LLM did not return valid tool JSON");
  }
  validate(tool);
  await saveTool(tool);
  return { tool, provider };
}

// ---- One-shot: create a tool for a task if none fits, then run it ----
export async function createAndRun(taskDescription, params = {}) {
  const { tool, provider } = await createTool(taskDescription);
  const result = await runOps(tool, params);
  return { tool: tool.name, created: true, provider, result };
}
