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
        sendResponse(await orchestrate(msg.task, msg.payload));
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

// ---- Context menu: humanize selected text in the Humanize AI tab ----
const HUMANIZE_MENU_ID = "humanize-selection";
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: HUMANIZE_MENU_ID,
    title: "Humanize with AI",
    contexts: ["selection"],
  });
});

chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== HUMANIZE_MENU_ID) return;
  // Stash the selection so the page can pick it up immediately on load.
  if (info.selectionText) {
    await chrome.storage.local.set({ humanizePrefill: info.selectionText });
  }
  chrome.tabs.create({
    url: chrome.runtime.getURL("src/humanizer/humanizer.html?prefill=1"),
  });
});
