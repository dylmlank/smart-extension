/* Predictability / "perplexity proxy" signal.

   Real AI detectors measure perplexity: how surprising each word is given the
   previous one. LLM text is LOW perplexity — it picks the statistically most
   likely next word over and over. Humans are higher perplexity (more
   surprising word choices, odd collocations, idiosyncratic phrasing).

   We approximate this without a multi-megabyte language model by shipping a
   curated table of very common English word→next-word transitions. The more of
   a passage's transitions fall into this "predictable" set, the lower its
   perplexity, the more AI-like it reads.

   This is a heuristic, not a true LM — but it captures the core signal cheaply
   and offline. Returns 0..1 where 1 = very predictable (AI-like). */

(function (global) {
  "use strict";

  function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

  // Real bigram-probability table built from ~4.8M tokens of human prose (NLTK
  // brown/reuters/gutenberg/webtext). Loaded from bigrams.js (browser <script>)
  // or bigrams.json (node). Each entry: { n: [top-12 next words], m: mass the
  // top-K covers }. `m` is how concentrated a word's continuations are — a high
  // m means "when you see this word, the next word is very predictable".
  let TABLE = (typeof global !== "undefined" && global.BIGRAMS) ||
              (typeof window !== "undefined" && window.BIGRAMS) || null;
  if (!TABLE && typeof require === "function") {
    try { TABLE = require("./bigrams.json"); } catch { /* not in node path */ }
  }
  TABLE = TABLE || {};
  const HAS_TABLE = Object.keys(TABLE).length > 0;

  // Generic low-information AI constructions: vague modal hedges, "a wide range
  // of" filler, possessive doubling, empty intensifiers. These produce fluent
  // but contentless text — a strong tell even when no buzzword is present.
  // Each entry is a precise AI-filler construction. Kept tight so it fires on
  // genuine hedge/padding patterns, not on any plain declarative sentence.
  const FILLER_CONSTRUCTIONS = [
    /\b(?:can|will|may|could|should)\s+(?:help|handle|adapt|provide|ensure|allow|lead|enhance|offer|serve|cater)\b/gi,
    /\ba\s+(?:wide|broad|diverse|vast)\s+(?:range|array|variety|spectrum)\s+of\b/gi,
    /\bits?\s+own\s+\w+\s+and\s+its?\s+own\b/gi,
    /\beach\s+\w+\s+has\s+its\s+own\b/gi,
    /\bthere\s+are\s+(?:many|several|various|numerous|countless)\s+ways?\b/gi,
    /\bthis\s+(?:will|can)\s+(?:help\s+)?ensure\b/gi,
    /\bthe\s+best\s+way\s+to\b/gi,
    /\bwhen\s+it\s+comes\s+to\b/gi,
    /\bplays?\s+an?\s+\w+\s+role\b/gi,
    /\b\w+\s+find(?:s)?\s+that\s+it\b/gi,
    /\bnot\s+only\s+\w+\s+but\s+also\b/gi,
  ];

  function fillerDensity(text) {
    const ws = (text.match(/[a-z']+/gi) || []).length;
    if (!ws) return 0;
    let hits = 0;
    for (const re of FILLER_CONSTRUCTIONS) hits += (text.match(re) || []).length;
    // ~2 filler constructions per 100 words is strongly AI.
    return clamp((hits / ws) * 100 / 2, 0, 1);
  }

  // Tokenize to lowercase words (apostrophes kept).
  function tok(text) {
    return (text.toLowerCase().match(/[a-z']+/g) || []);
  }

  // How predictable is each next word given the previous one? For every pair
  // (a, b) we know about, we score a "hit" when b is among a's top
  // continuations, weighted by a's concentration mass `m` (predictable
  // transitions from highly-concentrated words are the strongest AI tell).
  // Higher average = lower perplexity = more AI-like.
  function predictability(text) {
    // NOTE: the raw bigram-match signal turned out to be INVERTED on real data.
    // The table is built from human literary corpora (Brown/Reuters/Gutenberg),
    // so genuine human prose matches its common transitions MORE than generic
    // AI prose does — the opposite of the perplexity intuition. Measured on the
    // labeled set: AI bigram-avg 0.19 vs human 0.27 (separation -0.08). So we no
    // longer use the bigram match as an AI signal; the FILLER-construction
    // density is the precise, correctly-signed part (AI 0.30 vs human 0.00) and
    // now carries the signal on its own.
    return clamp(fillerDensity(text), 0, 1);
  }

  // Raw bigram-match average, exposed for analysis/tuning only. Not used as an
  // AI signal (see predictability() above — it's inverted on real data).
  function bigramMatch(text) {
    const ws = tok(text);
    if (!HAS_TABLE || ws.length < 12) return null;
    let scoreSum = 0, considered = 0;
    for (let i = 0; i < ws.length - 1; i++) {
      const e = TABLE[ws[i]];
      if (!e) continue;
      considered++;
      if (e.n.indexOf(ws[i + 1]) !== -1) scoreSum += 0.5 + e.m;
    }
    return considered < 5 ? null : scoreSum / considered;
  }

  global.Predictability = { predictability, fillerDensity, bigramMatch, HAS_TABLE };
})(typeof window !== "undefined" ? window : globalThis);
