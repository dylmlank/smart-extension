/* Retrospective: reflect on a rewrite+detect run and learn from it.

   Mirrors the retrospective-skill loop — after each run, an LLM reflects on how
   it went and writes durable learnings (new AI tells, better replacements, and
   prose notes) that get persisted via Learnings and loaded into every future
   run. The detector and humanizer read those learnings, so the system keeps
   improving at catching and removing AI text.

   reflect(run) -> Promise<{ added, learnings } | { skipped } | { error }>
   where run = { input, output, beforeScore, afterScore, survivedSignals }.

   Uses the server's /api/rewrite proxy (system prompt + text -> text). If the
   LLM is unavailable, falls back to a deterministic rule-based reflection so the
   loop still learns something offline. */

(function (global) {
  "use strict";

  const SYS =
    "You analyze an AI-text humanizer run and extract durable learnings to " +
    "improve future detection and rewriting. You are given the ORIGINAL " +
    "(AI-written) text, the HUMANIZED output, the detector's AI score before " +
    "and after, and which AI tells SURVIVED into the output. " +
    "Reply with ONLY a JSON object, no prose, in this exact shape:\n" +
    '{"phrases":["ai cliche still present","another tell"],' +
    '"replacements":[{"from":"buzzword","to":"plain word"}],' +
    '"notes":["one short learning"]}\n' +
    "Rules: phrases = AI tells you SEE in the original or surviving output that " +
    "a detector should flag (2-5 short ones, lowercase, no duplicates of common " +
    "words). replacements = how the humanizer should rewrite surviving tells " +
    "(plain, human, shorter; never lengthen). notes = 1-2 concise lessons. " +
    "If nothing is worth learning, return empty arrays.";

  // Build the user payload describing the run.
  function runText(run) {
    const sig = (run.survivedSignals || [])
      .map((s) => `${s.name}: ${s.detail || s.contribution + "%"}`)
      .join("; ");
    return (
      `ORIGINAL:\n${(run.input || "").slice(0, 1200)}\n\n` +
      `HUMANIZED:\n${(run.output || "").slice(0, 1200)}\n\n` +
      `AI SCORE: ${run.beforeScore} -> ${run.afterScore}\n` +
      `SURVIVING TELLS: ${sig || "none reported"}`
    );
  }

  // Deterministic fallback: harvest recurring multi-word phrases from the input
  // that still look AI-ish, when no LLM is available. Conservative on purpose.
  function ruleReflect(run) {
    const phrases = [];
    const text = (run.input || "").toLowerCase();
    // Recurring 3-grams (appear 2+ times) are candidate tells.
    const ws = text.match(/[a-z']+/g) || [];
    const counts = new Map();
    for (let i = 0; i + 3 <= ws.length; i++) {
      const g = ws.slice(i, i + 3).join(" ");
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    const STOP = new Set(["the", "a", "an", "of", "to", "and", "in", "is", "it", "that", "this", "for", "on", "with", "as", "are", "be", "or", "by", "at", "we", "you", "they"]);
    for (const [g, c] of counts) {
      if (c >= 2 && !g.split(" ").every((w) => STOP.has(w))) phrases.push(g);
    }
    return { phrases: phrases.slice(0, 5), replacements: [], notes: [] };
  }

  function parseLearnings(raw) {
    try {
      const m = raw.match(/\{[\s\S]*\}/);
      if (!m) return null;
      const j = JSON.parse(m[0]);
      return {
        phrases: Array.isArray(j.phrases) ? j.phrases : [],
        replacements: Array.isArray(j.replacements) ? j.replacements : [],
        notes: Array.isArray(j.notes) ? j.notes : [],
      };
    } catch {
      return null;
    }
  }

  // llmRewrite: optional async (system, text) => string. When omitted or it
  // fails, we use the deterministic fallback so the loop still learns.
  async function reflect(run, llmRewrite) {
    if (!run || run.input == null) return { skipped: true, reason: "no run" };

    let learnings = null;
    if (typeof llmRewrite === "function") {
      try {
        const out = await llmRewrite(SYS, runText(run));
        learnings = parseLearnings(out);
      } catch { /* fall through to rule-based */ }
    }
    if (!learnings) learnings = ruleReflect(run);

    const L = global.Learnings;
    if (!L) return { error: "no Learnings store" };
    const added = L.add(learnings);
    return { added, learnings };
  }

  global.Retrospective = { reflect, SYS };
})(typeof window !== "undefined" ? window : globalThis);
