/* Iterative humanizer: keeps rewriting until the local detector score drops
   below a target, or max rounds is hit. Uses the local engine every round
   and, when an `llm` function is provided, an AI rewrite pass too.

   Requires window.Humanizer and window.Detector to be loaded.

   loopHumanize(text, opts) -> Promise<{
     text, score, rounds, history, hitTarget
   }>
   opts: {
     mode, target = 10, maxRounds = 6,
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
      "MOST IMPORTANT: vary sentence length a lot. Put short, punchy sentences " +
      "(3 to 6 words) right next to longer ones, so the rhythm is uneven the way " +
      "real people write. Pick specific, concrete, sometimes surprising words " +
      "instead of safe generic ones. Use contractions. " +
      "Cut filler, buzzwords, and AI cliches (e.g. 'leverage', 'foster', 'landscape', " +
      "'delve', 'in today's world', 'it is important to note'). " +
      "Do NOT use hyphens or dashes of any kind. Keep the original meaning. " +
      "Output only the rewritten text, nothing else.";
    const harder =
      " This text still reads like AI. The detector still sees uniform sentence " +
      "rhythm and predictable word choice. Be far more aggressive: smash the even " +
      "rhythm (mix 3-word sentences with 25-word ones), start every sentence " +
      "differently, swap predictable words for vivid specific ones, and add " +
      "natural contractions. Remove every remaining cliche.";
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

  // Describe which AI tells the detector still flags, as a short feedback string
  // the regenerator can target ("Sentence rhythm, Casual-AI phrases, ...").
  function survivingTells(detectResult) {
    if (!detectResult || !detectResult.signals) return "";
    return detectResult.signals
      .filter((s) => s.contribution >= 30)
      .sort((a, b) => b.contribution - a.contribution)
      .slice(0, 4)
      .map((s) => s.name)
      .join(", ");
  }

  async function loopHumanize(text, opts) {
    opts = opts || {};
    const mode = opts.mode || "balanced";
    const target = opts.target ?? 10;
    const maxRounds = opts.maxRounds ?? 6;
    const llm = opts.llm;
    const regenerate = opts.regenerate; // (text, mode, feedback, round) => string
    const onRound = opts.onRound || (() => {});

    const H = window.Humanizer, D = window.Detector;
    const history = [];

    // Score a candidate. A null score means "too short to judge" — that's not
    // an AI signal, so treat it as already acceptable (just below target).
    const detectOf = (t) => D.detect(t);
    const scoreOf = (t) => {
      const s = detectOf(t).score;
      return s == null ? Math.min(target, 25) : s;
    };

    // Round 0: always the fast local pass.
    let current = H.humanize(text, mode);
    let best = current;
    let bestScore = scoreOf(current);
    history.push({ round: 0, via: "local", score: bestScore });
    onRound({ round: 0, via: "local", score: bestScore, text: current,
              bestScore, bestText: best });

    if (bestScore <= target) {
      return { text: best, score: bestScore, rounds: 1, history, hitTarget: true };
    }

    // How many regenerate attempts have we made (drives prompt escalation)?
    let regenRound = 0;

    for (let r = 1; r < maxRounds; r++) {
      let candidate;
      let via;

      if (regenerate) {
        // Regenerate-loop: rebuild from MEANING each round, feeding back the
        // tells that survived so the model knows what to fix. We regenerate from
        // the ORIGINAL text (best signal) but escalate the prompt by round.
        try {
          const feedback = survivingTells(detectOf(best));
          const out = await regenerate(text, mode, feedback, regenRound);
          candidate = (out || "").trim();
          via = "regenerate";
          regenRound++;
        } catch (e) {
          candidate = H.humanize(current, mode);
          via = "local-fallback";
        }
      } else if (llm) {
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
      if (score < bestScore) { best = candidate; bestScore = score; }
      current = candidate;
      history.push({ round: r, via, score });
      onRound({ round: r, via, score, text: candidate,
                bestScore, bestText: best });

      // Best-of-N: with hot sampling, scores for the SAME input swing widely
      // round to round (e.g. 12% / 60% / 4%), so we keep re-rolling and hold onto
      // the single best candidate rather than accepting the first "ok" one. We
      // stop early once a candidate reaches the target. Target defaults to 10%
      // ("Likely human-written"), which is the realistic human range — genuine
      // human writing scores a median of ~11% on this detector, so chasing a much
      // lower number just burns API rounds below the proxy's own noise floor.
      if (bestScore <= target) {
        return { text: best, score: bestScore, rounds: r + 1, history, hitTarget: true };
      }
      // Without an LLM, local re-passes converge fast — stop if no gain.
      if (!llm && !regenerate && score >= history[r - 1].score) break;
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
