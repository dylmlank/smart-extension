/* Persistent learnings store — the detector/humanizer's "instructions file".

   Modeled on the retrospective-skill loop: each run reflects on how it went and
   appends durable learnings here; the detector and humanizer READ these on every
   subsequent run, so the system keeps getting better at catching AI text.

   Three kinds of learning, all persisted to localStorage:
     - phrases:      AI tells (strings) the detector should also flag
     - replacements: { from (regex source), to } the humanizer should apply
     - notes:        human-readable prose learnings (the "instructions" log)

   Everything here is offline + synchronous so detect()/humanize() can pull the
   current learnings with zero latency. */

(function (global) {
  "use strict";

  const KEY = "hz_learnings_v1";
  const MAX_PHRASES = 200, MAX_REPLACEMENTS = 200, MAX_NOTES = 50;

  // Storage backend. Prefer localStorage (web app). In a browser-extension page
  // chrome.storage is async, so we keep a synchronous in-memory cache that the
  // detector/humanizer read instantly, and write through to chrome.storage. Call
  // Learnings.hydrate() once at startup there to populate the cache.
  const hasChrome = typeof chrome !== "undefined" && chrome.storage && chrome.storage.local;
  const hasLocal = typeof localStorage !== "undefined";

  let memCache = null; // sync cache string for the chrome/node backends

  const store = hasLocal
    ? localStorage
    : {
        getItem: (k) => (memCache != null ? memCache : null),
        setItem: (k, v) => {
          memCache = String(v);
          if (hasChrome) chrome.storage.local.set({ [k]: memCache });
        },
        removeItem: () => { memCache = null; if (hasChrome) chrome.storage.local.remove(KEY); },
      };

  // Extension entry point: pull persisted learnings into the sync cache once.
  async function hydrate() {
    if (!hasChrome || hasLocal) return;
    try {
      const got = await chrome.storage.local.get(KEY);
      if (got && typeof got[KEY] === "string") memCache = got[KEY];
    } catch { /* ignore */ }
  }

  const empty = () => ({ phrases: [], replacements: [], notes: [] });

  function load() {
    try {
      const raw = store.getItem(KEY);
      if (!raw) return empty();
      const obj = JSON.parse(raw);
      return {
        phrases: Array.isArray(obj.phrases) ? obj.phrases : [],
        replacements: Array.isArray(obj.replacements) ? obj.replacements : [],
        notes: Array.isArray(obj.notes) ? obj.notes : [],
      };
    } catch {
      return empty();
    }
  }

  function save(data) {
    try { store.setItem(KEY, JSON.stringify(data)); } catch { /* quota / private mode */ }
  }

  // Normalize a phrase: trimmed, lowercased, collapse whitespace. Reject junk.
  function normPhrase(p) {
    if (typeof p !== "string") return null;
    const s = p.trim().toLowerCase().replace(/\s+/g, " ");
    if (s.length < 3 || s.length > 60) return null;
    if (!/[a-z]/.test(s)) return null;
    return s;
  }

  // Add learnings, de-duplicating against what's already known. Returns the
  // counts actually added so the UI can report progress.
  function add({ phrases = [], replacements = [], notes = [] } = {}) {
    const data = load();
    let added = { phrases: 0, replacements: 0, notes: 0 };

    const known = new Set(data.phrases);
    for (const p of phrases) {
      const n = normPhrase(p);
      if (n && !known.has(n)) { data.phrases.push(n); known.add(n); added.phrases++; }
    }

    const knownR = new Set(data.replacements.map((r) => r.from + "→" + r.to));
    for (const r of replacements) {
      if (!r || typeof r.from !== "string" || typeof r.to !== "string") continue;
      const from = r.from.trim(), to = r.to.trim();
      if (from.length < 2 || from.length > 60 || to.length > 60) continue;
      // Don't learn replacements that lengthen the text or are no-ops.
      if (from.toLowerCase() === to.toLowerCase()) continue;
      const key = from + "→" + to;
      if (!knownR.has(key)) { data.replacements.push({ from, to }); knownR.add(key); added.replacements++; }
    }

    for (const note of notes) {
      const s = typeof note === "string" ? note.trim() : "";
      if (s && s.length <= 200 && !data.notes.includes(s)) { data.notes.push(s); added.notes++; }
    }

    // Cap each list (keep the most recent).
    data.phrases = data.phrases.slice(-MAX_PHRASES);
    data.replacements = data.replacements.slice(-MAX_REPLACEMENTS);
    data.notes = data.notes.slice(-MAX_NOTES);

    save(data);
    return added;
  }

  function clear() { save(empty()); }

  // Convenience accessors the detector/humanizer call on every run.
  const learnedPhrases = () => load().phrases;
  const learnedReplacements = () => load().replacements;

  global.Learnings = { load, add, clear, learnedPhrases, learnedReplacements, hydrate };
})(typeof window !== "undefined" ? window : globalThis);
