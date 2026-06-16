/* Iterative humanizer: keeps rewriting until the local detector score drops
   below a target, or max rounds is hit. Uses the local engine every round
   and, when an `llm` function is provided, an AI rewrite pass too.

   Requires window.Humanizer and window.Detector to be loaded.

   loopHumanize(text, opts) -> Promise<{
     text, score, rounds, history, hitTarget
   }>
   opts: {
     mode, target = 30, maxRounds = 5,
     llm,            // async (systemPrompt, userText) => string   (optional)
     onRound,        // (info) => void   progress callback (optional)
   }
*/
(function (global) {
  "use strict";

  // Escalating instructions per round — gets blunter the longer it resists.
  function promptFor(mode, round) {
    const base =
      "Rewrite the text so it reads as natural human writing. " +
      "Keep it concise and simple. Use short, plain sentences with varied length. " +
      "Cut filler, buzzwords, and AI cliches (e.g. 'leverage', 'foster', 'landscape', " +
      "'delve', 'in today's world', 'it is important to note'). " +
      "Do NOT use hyphens or dashes of any kind. Keep the original meaning. " +
      "Output only the rewritten text, nothing else.";
    const harder =
      " This text still reads like AI. Be more aggressive: break up uniform " +
      "sentences, vary rhythm hard, use everyday words and contractions, and " +
      "remove every remaining cliche.";
    const toneMap = {
      simple: " Aim for plain, sixth-grade-level clarity.",
      casual: " Use a relaxed, conversational tone.",
      balanced: "",
    };
    return base + (toneMap[mode] || "") + (round > 0 ? harder : "");
  }

  // Strip any hyphen/dash the LLM may reintroduce.
  function stripDashes(t) {
    return window.Humanizer
      ? window.Humanizer.humanize(t, "balanced") // local pass also de-dashes
      : t.replace(/[—–]/g, ", ").replace(/(\w)-(\w)/g, "$1 $2").replace(/-/g, " ");
  }

  async function loopHumanize(text, opts) {
    opts = opts || {};
    const mode = opts.mode || "balanced";
    const target = opts.target ?? 30;
    const maxRounds = opts.maxRounds ?? 5;
    const llm = opts.llm;
    const onRound = opts.onRound || (() => {});

    const H = window.Humanizer, D = window.Detector;
    const history = [];

    // Score a candidate. A null score means "too short to judge" — that's not
    // an AI signal, so treat it as already acceptable (just below target).
    const scoreOf = (t) => {
      const s = D.detect(t).score;
      return s == null ? Math.min(target, 25) : s;
    };

    // Round 0: always the fast local pass.
    let current = H.humanize(text, mode);
    let best = current;
    let bestScore = scoreOf(current);
    history.push({ round: 0, via: "local", score: bestScore });
    onRound({ round: 0, via: "local", score: bestScore, text: current });

    if (bestScore <= target) {
      return { text: best, score: bestScore, rounds: 1, history, hitTarget: true };
    }

    for (let r = 1; r < maxRounds; r++) {
      let candidate;
      let via;
      if (llm) {
        try {
          const out = await llm(promptFor(mode, r), current);
          candidate = stripDashes((out || "").trim());
          via = "ai";
        } catch (e) {
          candidate = H.humanize(current, mode); // fall back to local re-pass
          via = "local-fallback";
        }
      } else {
        // No LLM: re-run local engine on its own output to keep squeezing.
        candidate = H.humanize(current, mode);
        via = "local";
      }

      if (!candidate) candidate = current;
      const score = scoreOf(candidate);
      history.push({ round: r, via, score });
      onRound({ round: r, via, score, text: candidate });

      if (score < bestScore) { best = candidate; bestScore = score; }
      current = candidate;

      if (bestScore <= target) {
        return { text: best, score: bestScore, rounds: r + 1, history, hitTarget: true };
      }
      // Without an LLM, local re-passes converge fast — stop if no gain.
      if (!llm && score >= history[r - 1].score) break;
    }

    return {
      text: best,
      score: bestScore,
      rounds: history.length,
      history,
      hitTarget: bestScore <= target,
    };
  }

  global.loopHumanize = loopHumanize;
})(typeof window !== "undefined" ? window : globalThis);
