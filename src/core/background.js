// Service worker: message router, focus tracking, retrospective scheduler.
import { orchestrate } from "../agents/agents.js";
import { runRetrospective } from "./retrospective.js";
import { listTools, deleteTool, createAndRun } from "../agents/toolfactory.js";

// ---- Message handling from popup / content / options ----
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Messages addressed to the offscreen document are handled there, not here.
  if (msg?.type === "offscreen-execJs") return false;
  (async () => {
    try {
      if (msg.type === "task") {
        sendResponse(await orchestrate(msg.task, msg.payload, msg.history));
      } else if (msg.type === "retro") {
        sendResponse(await runRetrospective());
      } else if (msg.type === "listTools") {
        sendResponse({ tools: await listTools() });
      } else if (msg.type === "deleteTool") {
        await deleteTool(msg.name);
        sendResponse({ ok: true });
      } else if (msg.type === "buildTool") {
        sendResponse(await createAndRun(msg.task, msg.payload));
      } else {
        sendResponse({ error: "unknown message" });
      }
    } catch (e) {
      sendResponse({ error: String(e.message || e) });
    }
  })();
  return true; // async response
});

// ---- Focus tracking: accumulate active time per domain ----
let active = { domain: null, since: Date.now() };

function domainOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

async function flush() {
  if (!active.domain) return;
  const ms = Date.now() - active.since;
  if (ms < 1000) return;
  const { focusStats = {} } = await chrome.storage.local.get("focusStats");
  focusStats[active.domain] = (focusStats[active.domain] || 0) + ms;
  await chrome.storage.local.set({ focusStats });
}

async function switchTo(url) {
  await flush();
  active = { domain: domainOf(url), since: Date.now() };
}

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (tab?.url) switchTo(tab.url);
});
chrome.tabs.onUpdated.addListener((id, info, tab) => {
  if (info.url && tab.active) switchTo(info.url);
});
chrome.windows.onFocusChanged.addListener(async (winId) => {
  if (winId === chrome.windows.WINDOW_ID_NONE) { await flush(); active.domain = null; }
});

// ---- Reset focus stats daily ----
chrome.alarms.create("dailyReset", { periodInMinutes: 60 });
// ---- Constant retrospective: reflect every 30 min of activity ----
chrome.alarms.create("retrospective", { periodInMinutes: 30 });

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "retrospective") {
    await runRetrospective();
  } else if (alarm.name === "dailyReset") {
    const { lastReset } = await chrome.storage.local.get("lastReset");
    const today = new Date().toDateString();
    if (lastReset !== today) {
      await chrome.storage.local.set({ focusStats: {}, lastReset: today });
    }
  }
});

// ---- Context menus: act on selected text from any page ----
// Top-level "Smart Assistant" with quick writing/translate/explain actions, plus
// the full humanizer opener. Selection-based actions run the matching agent and
// show the result inline via the content script (no tab switch needed).
const HUMANIZE_MENU_ID = "humanize-selection";

// Each entry: [menu id, title, agent task, extra payload]. `agent`/`payload`
// are looked up in onClicked below.
const SELECTION_ACTIONS = [
  { id: "sa-fix",          title: "Fix grammar",       task: "Fix grammar",        style: "fix" },
  { id: "sa-concise",      title: "Make it concise",   task: "Make concise",       style: "concise" },
  { id: "sa-professional", title: "Make professional", task: "Make professional",  style: "professional" },
  { id: "sa-humanize-inl", title: "Humanize",          task: "Humanize",           style: "humanize" },
  { id: "sa-explain",      title: "Explain this",      task: "Explain the selected text" },
  { id: "sa-translate-es", title: "Translate → Spanish", task: "Translate to Spanish", lang: "Spanish" },
  { id: "sa-translate-en", title: "Translate → English", task: "Translate to English", lang: "English" },
];

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: "sa-root", title: "Smart Assistant", contexts: ["selection"],
    });
    for (const a of SELECTION_ACTIONS) {
      chrome.contextMenus.create({
        id: a.id, parentId: "sa-root", title: a.title, contexts: ["selection"],
      });
    }
    chrome.contextMenus.create({
      id: "sa-sep", parentId: "sa-root", type: "separator", contexts: ["selection"],
    });
    chrome.contextMenus.create({
      id: HUMANIZE_MENU_ID, parentId: "sa-root",
      title: "Open in Humanizer + Detector", contexts: ["selection"],
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  // Full humanizer tab (kept as before).
  if (info.menuItemId === HUMANIZE_MENU_ID) {
    if (info.selectionText) {
      await chrome.storage.local.set({ humanizePrefill: info.selectionText });
    }
    chrome.tabs.create({ url: chrome.runtime.getURL("src/humanizer/humanizer.html?prefill=1") });
    return;
  }

  // Inline selection actions: run the agent and show the result on the page.
  const action = SELECTION_ACTIONS.find((a) => a.id === info.menuItemId);
  if (!action || !info.selectionText || !tab?.id) return;

  const payload = { selection: info.selectionText };
  if (action.style) payload.style = action.style;
  if (action.lang) payload.lang = action.lang;

  // Tell the content script to show a loading bubble immediately.
  chrome.tabs.sendMessage(tab.id, { type: "saResult", state: "loading", title: action.title }).catch(() => {});

  try {
    const res = await orchestrate(action.task, payload, []);
    chrome.tabs.sendMessage(tab.id, {
      type: "saResult", state: "done", title: action.title,
      output: res.output || res.error || "(no response)",
    }).catch(() => {});
  } catch (e) {
    chrome.tabs.sendMessage(tab.id, {
      type: "saResult", state: "done", title: action.title,
      output: "Error: " + (e.message || e),
    }).catch(() => {});
  }
});
