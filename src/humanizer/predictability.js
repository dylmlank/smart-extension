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

  // Common high-probability continuations. Keyed by a word; the value is the
  // set of words that very frequently follow it in fluent, generic prose.
  // These are the transitions an LLM is most likely to produce. Hand-curated
  // from the most frequent English bigrams (function words + generic content).
  const NEXT = {
    the: ["most", "same", "first", "best", "world", "way", "fact", "use", "need", "ability", "process", "number", "importance", "future", "power", "key", "rise", "concept", "idea", "role"],
    of: ["the", "a", "this", "these", "our", "their", "its", "such", "course", "all", "modern", "various", "different", "many"],
    to: ["the", "be", "make", "ensure", "provide", "create", "help", "understand", "achieve", "improve", "develop", "support", "address", "navigate", "explore", "consider", "do", "a"],
    in: ["the", "a", "this", "order", "addition", "fact", "terms", "today's", "many", "particular", "general", "recent", "our", "their"],
    a: ["wide", "variety", "range", "number", "result", "way", "key", "vital", "crucial", "significant", "comprehensive", "deeper", "better", "more", "powerful", "single", "new", "great"],
    is: ["a", "the", "an", "not", "one", "essential", "crucial", "important", "vital", "key", "often", "also", "that", "to", "becoming", "no"],
    and: ["the", "a", "their", "its", "this", "also", "can", "more", "even", "ensure", "provide", "make", "help", "improve"],
    it: ["is", "can", "also", "has", "comes", "becomes", "allows", "provides", "plays", "serves", "remains", "offers"],
    that: ["the", "this", "it", "they", "can", "are", "is", "would", "will", "may", "we", "you", "these"],
    this: ["is", "can", "approach", "means", "allows", "process", "way", "makes", "leads", "results", "ensures", "helps"],
    these: ["are", "tools", "factors", "include", "can", "challenges", "elements", "technologies", "changes", "trends", "insights"],
    for: ["the", "a", "example", "instance", "this", "these", "many", "those", "businesses", "individuals", "success", "growth"],
    with: ["the", "a", "this", "these", "their", "its", "respect", "regard", "ease", "care", "confidence"],
    as: ["a", "the", "well", "such", "it", "they", "we", "more", "part", "an"],
    can: ["be", "help", "also", "lead", "provide", "make", "ensure", "create", "improve", "enhance", "have", "significantly"],
    will: ["be", "help", "continue", "allow", "ensure", "provide", "have", "make", "likely", "also", "depend"],
    by: ["the", "a", "leveraging", "using", "understanding", "following", "providing", "creating", "ensuring", "embracing", "focusing"],
    on: ["the", "a", "this", "their", "its", "your", "our", "how", "what", "which"],
    are: ["the", "a", "not", "also", "often", "more", "essential", "crucial", "key", "becoming", "many", "several"],
    we: ["can", "must", "need", "should", "will", "have", "are", "live", "explore", "see"],
    you: ["can", "will", "should", "need", "may", "want", "have", "are", "must"],
    they: ["are", "can", "have", "also", "will", "provide", "offer", "help", "allow", "must"],
    not: ["only", "just", "merely", "simply", "a", "the", "be", "to"],
    more: ["than", "effective", "efficient", "important", "likely", "and", "complex", "accessible", "engaging", "productive"],
    its: ["own", "ability", "use", "role", "importance", "impact", "potential", "power", "value", "benefits"],
    their: ["own", "ability", "needs", "goals", "lives", "work", "use", "impact", "potential", "respective"],
    one: ["of", "that", "the", "must", "can", "key", "important"],
    plays: ["a", "an"],
    play: ["a", "an"],
    such: ["as", "a", "an"],
    when: ["it", "you", "we", "they", "the", "considering"],
    while: ["the", "it", "this", "also", "maintaining", "ensuring", "still"],
    however: ["it", "this", "the", "there", "as", "with"],
    moreover: ["it", "the", "this", "these"],
    furthermore: ["the", "it", "this"],
    through: ["the", "a", "this", "these", "their", "careful"],
    at: ["the", "its", "this", "a", "least", "hand"],
    an: ["essential", "important", "integral", "increasingly", "effective", "array", "era", "approach", "individual", "organization"],
    each: ["of", "other", "individual", "one", "person", "with"],
    from: ["the", "a", "this", "these", "their", "simple"],
  };

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

  // Fraction of adjacent word pairs whose second word is a "predictable"
  // continuation of the first. Higher fraction = lower perplexity = more AI.
  function predictability(text) {
    const ws = tok(text);
    if (ws.length < 12) return 0.5; // not enough signal
    let predictable = 0, considered = 0;
    for (let i = 0; i < ws.length - 1; i++) {
      const a = ws[i], b = ws[i + 1];
      const nexts = NEXT[a];
      if (!nexts) continue;          // we only judge pairs we have data for
      considered++;
      if (nexts.includes(b)) predictable++;
    }
    if (considered < 5) return 0.5;
    const frac = predictable / considered;
    // Calibrate: in generic AI prose, ~45-65% of judged transitions are
    // predictable; human prose tends lower (~25-40%). Map that band to 0..1.
    const bigramSig = clamp((frac - 0.3) / 0.35, 0, 1);

    // Blend with the filler-construction density. Filler is a strong, precise
    // tell, so it can pull the signal up on its own even if the bigram table
    // didn't cover many of this passage's transitions.
    const filler = fillerDensity(text);
    return clamp(Math.max(bigramSig * 0.7 + filler * 0.6, filler * 0.9), 0, 1);
  }

  global.Predictability = { predictability, fillerDensity };
})(typeof window !== "undefined" ? window : globalThis);
