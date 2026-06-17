/* Perplexity engine — the statistical core of the detector.

   Trusted AI detectors (GPTZero, Originality, Binoculars, DetectGPT) don't count
   buzzwords. They measure PERPLEXITY: how surprising each word is given its
   context, under a language model. LLM text is LOW perplexity (it repeatedly
   picks the statistically most likely word); human text is HIGHER perplexity
   (rarer words, odd collocations). And BURSTINESS — GPTZero's own definition —
   is "how much the perplexity VARIES over the document": humans mix surprising
   and plain sentences; LLMs hold a flat, low-perplexity "AI-print".

   We can't ship a transformer, so we approximate the scoring LM with two bundled
   tables:
     - unigrams.js: -log p(word) for the 12k most common English words. The
       backbone. AI over-picks common words -> low average surprisal.
     - bigrams.js: top continuations per word + concentration mass. Lets us lower
       a word's surprisal when it's a highly predictable continuation of the
       previous word (a real conditional-probability effect, the thing the old
       inverted "bigram match" tried and failed to capture).

   This is a coarse proxy for true neural perplexity, but it is correctly signed
   and is the single most discriminative cheap signal — exactly what the old
   buzzword-only detector was missing.

   Returns surprisal in "nlp*100" units (-log p * 100) to match the table, and a
   normalized 0..1 perplexity score plus per-sentence values for burstiness. */

(function (global) {
  "use strict";

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  let UNI = (typeof global !== "undefined" && global.UNIGRAMS) ||
            (typeof window !== "undefined" && window.UNIGRAMS) || null;
  if (!UNI && typeof require === "function") {
    try { UNI = require("./unigrams.json"); } catch { /* not in node path */ }
  }
  let BI = (typeof global !== "undefined" && global.BIGRAMS) ||
           (typeof window !== "undefined" && window.BIGRAMS) || null;
  if (!BI && typeof require === "function") {
    try { BI = require("./bigrams.json"); } catch { /* not in node path */ }
  }
  BI = BI || {};

  const HAS_MODEL = !!(UNI && UNI.w && Object.keys(UNI.w).length > 0);

  // Surprisal percentiles from the corpus (nlp*100, token-weighted). Used to
  // normalize a document's mean surprisal onto 0..1. Defaults match the
  // generator output so the engine still works if pct is missing.
  const PCT = (UNI && UNI.pct) || { "0.1": 348, "0.25": 487, "0.5": 690, "0.75": 936, "0.9": 1128 };
  const OOV = (UNI && UNI.oov) || 1608;
  // The human-corpus token-weighted MEAN surprisal sits near the 50th pct. AI
  // text runs BELOW it. We map mean surprisal so that the corpus median (~690)
  // is the human/AI midpoint and lower values push toward "AI-like".
  const MED = Number(PCT["0.5"]) || 690;
  const LO = Number(PCT["0.25"]) || 487;   // low surprisal => AI-leaning
  const HI = Number(PCT["0.75"]) || 936;   // high surprisal => human-leaning

  function tok(text) {
    return (text.toLowerCase().match(/[a-z']+/g) || []);
  }

  function sentences(text) {
    return (text.match(/[^.!?]+[.!?]+/g) || [text])
      .map((s) => s.trim()).filter(Boolean);
  }

  // Per-word surprisal (nlp*100) given the previous word. Backbone is the
  // unigram -log p(word). We then apply a conditional discount: if the word is
  // among the previous word's known top continuations, it's more predictable in
  // context, so we lower its surprisal proportionally to how concentrated that
  // previous word's continuations are (its mass `m`). This is a cheap stand-in
  // for p(word | prev) without a full bigram-probability table.
  function wordSurprisal(word, prev) {
    let s = (UNI && UNI.w && UNI.w[word] != null) ? UNI.w[word] : OOV;
    if (prev) {
      const e = BI[prev];
      if (e && e.n && e.n.indexOf(word) !== -1) {
        // Predictable continuation: discount surprisal. A high-mass word (very
        // concentrated continuations) discounts more. Cap the discount so we
        // never go negative or erase the unigram signal entirely.
        const discount = clamp(0.25 + (e.m || 0) * 1.2, 0.25, 0.7);
        s = s * (1 - discount);
      }
    }
    return s;
  }

  // Mean per-word surprisal for a token list (nlp*100).
  function meanSurprisal(ws) {
    if (!ws.length) return MED;
    let sum = 0;
    for (let i = 0; i < ws.length; i++) {
      sum += wordSurprisal(ws[i], i > 0 ? ws[i - 1] : null);
    }
    return sum / ws.length;
  }

  // Normalize a mean surprisal (nlp*100) to a 0..1 "AI-likelihood from
  // perplexity" score: LOW surprisal -> high score (AI-like). We anchor at the
  // corpus quartiles so the mapping is corpus-calibrated, not arbitrary.
  function surprisalToAiScore(meanS) {
    // At/above HI (75th pct) -> clearly human (0). At/below LO (25th pct) ->
    // clearly AI (1). Linear in between, centered on the median.
    if (meanS >= HI) return 0;
    if (meanS <= LO) return 1;
    return clamp((HI - meanS) / (HI - LO), 0, 1);
  }

  // Document perplexity score (0..1, 1 = AI-like) plus the raw mean surprisal.
  function perplexity(text) {
    if (!HAS_MODEL) return { score: 0, meanSurprisal: MED, hasModel: false };
    const ws = tok(text);
    if (ws.length < 12) return { score: 0, meanSurprisal: MED, hasModel: true, low: true };
    const m = meanSurprisal(ws);
    return { score: surprisalToAiScore(m), meanSurprisal: m, hasModel: true };
  }

  // Per-sentence mean surprisal — the input to real burstiness.
  function sentenceSurprisals(text) {
    const sents = sentences(text);
    return sents.map((s) => {
      const ws = tok(s);
      return ws.length ? meanSurprisal(ws) : MED;
    });
  }

  // BURSTINESS, done the way GPTZero defines it: the spread of per-sentence
  // perplexity. Humans are bursty (high spread); LLMs are flat (low spread).
  // Returns a 0..1 AI-likelihood: LOW spread + low overall surprisal => AI-like.
  // We use the coefficient of variation of per-sentence surprisal so it's scale
  // free, and require a meaningful number of sentences.
  function burstiness(text) {
    if (!HAS_MODEL) return { score: 0, cv: null, hasModel: false };
    const vals = sentenceSurprisals(text);
    if (vals.length < 3) return { score: 0, cv: null, hasModel: true, low: true };
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    if (mean <= 0) return { score: 0, cv: 0, hasModel: true };
    const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
    const cv = Math.sqrt(variance) / mean;
    // Human per-sentence-perplexity CV is typically ~0.18+; AI clusters tight
    // (~0.05-0.12). Map: cv <= 0.06 -> very AI (1), cv >= 0.22 -> human (0).
    const score = clamp((0.22 - cv) / (0.22 - 0.06), 0, 1);
    return { score, cv, mean, hasModel: true, perSentence: vals };
  }

  global.Perplexity = {
    perplexity, burstiness, sentenceSurprisals, wordSurprisal,
    meanSurprisal, surprisalToAiScore, HAS_MODEL,
  };
})(typeof window !== "undefined" ? window : globalThis);
