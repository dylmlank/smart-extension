/* Local AI-text detector (heuristic).
   No model — estimates how "AI-like" text reads using signals that
   correlate with LLM output: low burstiness (uniform sentence length),
   AI-cliche density, low vocabulary variety, punctuation regularity,
   and filler/hedging frequency.

   It returns an estimated AI-likelihood score 0-100 plus a breakdown.
   This is an ESTIMATE, not a verdict — see the disclaimer in the UI. */

(function (global) {
  "use strict";

  const AI_PHRASES = [
    "it is important to note", "it is worth noting", "it should be noted",
    "in today's world", "in the modern era", "in the realm of",
    "plays a crucial role", "plays a vital role", "plays a key role",
    "a testament to", "navigate the complexities", "in the grand scheme",
    "delve into", "tapestry", "it is essential", "furthermore", "moreover",
    "additionally", "consequently", "in conclusion", "as a result",
    "on the other hand", "when it comes to", "a wide range of",
    "a plethora of", "leverage", "utilize", "facilitate", "foster",
    "underscore", "pivotal", "multifaceted", "realm", "landscape",
    "ever-evolving", "ever-changing", "seamless", "robust", "holistic",
    "in summary", "to summarize", "first and foremost", "needless to say",
  ];

  const HEDGES = [
    "generally", "typically", "often", "usually", "essentially",
    "fundamentally", "arguably", "notably", "importantly", "ultimately",
    "overall", "in many cases", "to some extent", "for the most part",
  ];

  function words(text) {
    return (text.toLowerCase().match(/[a-z']+/g) || []);
  }

  function sentences(text) {
    return (text.match(/[^.!?]+[.!?]+/g) || [text]).map(s => s.trim()).filter(Boolean);
  }

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // Burstiness: humans vary sentence length a lot; AI tends toward uniform.
  // Returns 0 (very uniform / AI-like) .. 1 (very bursty / human-like).
  function burstiness(sents) {
    if (sents.length < 2) return 0.5;
    const lens = sents.map(s => (s.split(/\s+/).length));
    const mean = lens.reduce((a, b) => a + b, 0) / lens.length;
    if (mean === 0) return 0.5;
    const variance = lens.reduce((a, b) => a + (b - mean) ** 2, 0) / lens.length;
    const cv = Math.sqrt(variance) / mean; // coefficient of variation
    return clamp(cv / 0.6, 0, 1); // ~0.6 CV ≈ clearly human rhythm
  }

  // Vocabulary variety (type-token ratio). Low variety => more AI-like.
  function ttr(ws) {
    if (!ws.length) return 0.5;
    const uniq = new Set(ws).size;
    return uniq / ws.length;
  }

  function phraseHits(text, list) {
    const lower = " " + text.toLowerCase() + " ";
    let count = 0;
    for (const p of list) {
      let idx = 0;
      while ((idx = lower.indexOf(p, idx)) !== -1) { count++; idx += p.length; }
    }
    return count;
  }

  // Per-100-word density of a phrase list.
  function density(text, list, wordCount) {
    if (!wordCount) return 0;
    return (phraseHits(text, list) / wordCount) * 100;
  }

  function detect(text) {
    const t = (text || "").trim();
    const ws = words(t);
    const wordCount = ws.length;

    if (wordCount < 20) {
      return {
        score: null,
        label: "Need more text",
        note: "Paste at least ~20 words for a meaningful estimate.",
        signals: [],
      };
    }

    const sents = sentences(t);

    // --- signals (each 0..1 where 1 = more AI-like) ---
    const burst = burstiness(sents);            // human-like high
    const sigBurst = 1 - burst;                 // AI-like when low burstiness

    const variety = ttr(ws);                    // human-like high
    // Normalize: typical human TTR for a paragraph ~0.55-0.7
    const sigVariety = clamp((0.62 - variety) / 0.25, 0, 1);

    const cliche = density(t, AI_PHRASES, wordCount);   // hits per 100 words
    const sigCliche = clamp(cliche / 2.5, 0, 1);        // ~2.5/100w = very AI

    const hedge = density(t, HEDGES, wordCount);
    const sigHedge = clamp(hedge / 3, 0, 1);

    // Em-dash / formal punctuation regularity
    const dashes = (t.match(/—|–/g) || []).length;
    const sigDash = clamp((dashes / sents.length) / 0.5, 0, 1);

    // Contractions: humans use them more in most registers.
    const contractions = (t.match(/\b\w+'\w+\b/g) || []).length;
    const contractionRate = contractions / wordCount;
    const sigNoContractions = clamp((0.02 - contractionRate) / 0.02, 0, 1);

    // Weighted blend. Cliché density is the most reliable single tell,
    // so it carries the most weight.
    const weights = [
      [sigCliche, 0.34, "AI cliché density", cliche.toFixed(1) + " / 100 words"],
      [sigBurst, 0.22, "Sentence rhythm", burst > 0.5 ? "varied (human-like)" : "uniform (AI-like)"],
      [sigVariety, 0.12, "Vocabulary variety", (variety * 100).toFixed(0) + "% unique"],
      [sigHedge, 0.12, "Hedging / filler", hedge.toFixed(1) + " / 100 words"],
      [sigNoContractions, 0.10, "Contraction use", contractions + " found"],
      [sigDash, 0.10, "Em-dash regularity", dashes + " dashes"],
    ];

    let score = 0;
    for (const [val, w] of weights) score += val * w;
    score = score * 100;

    // Heavy cliché use alone is a strong AI signal — apply a floor so a
    // single varied-rhythm pass can't mask it.
    if (cliche >= 3) score = Math.max(score, 68);
    if (cliche >= 6) score = Math.max(score, 80);

    score = Math.round(clamp(score, 1, 99));

    let label;
    if (score >= 70) label = "Likely AI-generated";
    else if (score >= 45) label = "Mixed / uncertain";
    else label = "Likely human-written";

    const signals = weights.map(([val, w, name, detail]) => ({
      name, detail,
      contribution: Math.round(val * 100),
    }));

    return { score, label, signals, wordCount };
  }

  global.Detector = { detect };
})(typeof window !== "undefined" ? window : globalThis);
