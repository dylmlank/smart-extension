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

const TOOLS_KEY = "custom_tools";

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

// ---- Execute a tool's op-plan safely ----
export async function runOps(tool, params = {}) {
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

// ---- The factory: ask the LLM to DESIGN a new tool for a task ----
export async function createTool(taskDescription) {
  const opDocs = `
fetchText {url}            -> GET url, returns text
fetchJson {url}            -> GET url, returns parsed JSON
queryTabs {query}          -> list of {id,title,url}
extract {selector,html}    -> text/html from active page matching CSS selector
store {key,value} / load {key}
llm {prompt,system,input}  -> run the language model on collected data
openTab {url,focus}        -> open a new tab
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
