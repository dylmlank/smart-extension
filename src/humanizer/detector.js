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
    "delve into", "delving into", "tapestry", "it is essential",
    "it is crucial", "it is vital", "furthermore", "moreover",
    "additionally", "consequently", "in conclusion", "as a result",
    "on the other hand", "when it comes to", "a wide range of",
    "a plethora of", "a myriad of", "myriad", "leverage", "utilize",
    "facilitate", "foster", "underscore", "underscores", "pivotal",
    "multifaceted", "realm", "landscape", "ever-evolving", "ever-changing",
    "ever-growing", "seamless", "seamlessly", "robust", "holistic",
    "in summary", "to summarize", "first and foremost", "needless to say",
    "at the end of the day", "the bottom line", "rest assured",
    "it's worth mentioning", "cornerstone", "game-changer", "game changer",
    "paradigm", "synergy", "streamline", "streamlined", "elevate", "embark",
    "embark on", "unlock", "unleash", "harness", "harnessing", "dive into",
    "let's dive", "diving into", "treasure trove", "double-edged sword",
    "stand the test of time", "the world of", "in the world of",
    "boasts", "boasting", "encompasses", "comprehensive understanding",
    "valuable insights", "crucial role", "vital role", "key role",
    "play a significant role", "wide array of", "broad spectrum",
    "navigating the", "shed light", "sheds light", "spearhead",
    "transformative", "unprecedented", "cutting-edge", "state-of-the-art",
    "in essence", "with that said", "that being said", "all in all",
  ];

  // Words AI reaches for far more than humans (single-word tells).
  const AI_WORDS = [
    "crucial", "essential", "vital", "significant", "various", "numerous",
    "moreover", "furthermore", "additionally", "consequently", "thus",
    "hence", "therefore", "notably", "particularly", "specifically",
    "ultimately", "fundamentally", "essentially", "comprehensive",
    "innovative", "dynamic", "vibrant", "intricate", "nuanced", "profound",
    "remarkable", "invaluable", "indispensable", "paramount", "myriad",
    "plethora", "realm", "landscape", "tapestry", "delve", "foster",
    "leverage", "utilize", "underscore", "showcase", "facilitate",
    "enhance", "empower", "optimize", "elevate", "navigate", "embark",
  ];

  const HEDGES = [
    "generally", "typically", "often", "usually", "essentially",
    "fundamentally", "arguably", "notably", "importantly", "ultimately",
    "overall", "in many cases", "to some extent", "for the most part",
    "in general", "more often than not", "by and large", "as a whole",
    "it depends", "in some sense", "to a certain extent", "relatively",
  ];

  // Antithesis templates AI loves: "not just X, but Y", "It's not X, it's Y",
  // "rather than X, Y". These read as a strong stylistic tell.
  const ANTITHESIS = [
    /\bit'?s not (?:just |merely |only |simply )?about\b/i,
    /\bnot (?:just|only|merely|simply) [^.,;]{1,40}?,? but(?: also)?\b/i,
    /\bit'?s not [^.,;]{1,40}?,? it'?s\b/i,
    /\bisn'?t (?:just|only|merely)\b/i,
    /\brather than [^.,;]{1,40}?,\b/i,
    /\bmore than (?:just|simply)\b/i,
  ];

  // Formulaic openers/closers AI uses to frame paragraphs.
  const FORMULAIC_OPENERS = [
    "in conclusion", "to conclude", "in summary", "to summarize",
    "all in all", "overall", "ultimately", "in essence", "at its core",
    "first and foremost", "to begin with", "let's", "let us", "imagine",
    "picture this", "in today's", "in the world", "as we", "whether you're",
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

  // ---- Repetition: AI reuses the same multi-word chunks within a passage. ----
  // Counts how often any bigram/trigram repeats. Returns a 0..1 "repetition"
  // score where higher = more repeated phrasing (more AI-like).
  function ngramRepetition(ws) {
    if (ws.length < 8) return 0;
    const count = (n) => {
      const map = new Map();
      for (let i = 0; i + n <= ws.length; i++) {
        const g = ws.slice(i, i + n).join(" ");
        map.set(g, (map.get(g) || 0) + 1);
      }
      // Ignore grams made only of common stopwords — those repeat naturally.
      const STOP = new Set(["the","a","an","of","to","and","in","is","it","that","this","for","on","with","as","be","are","or","at","by"]);
      let repeats = 0, total = 0;
      for (const [g, c] of map) {
        total++;
        if (c > 1 && !g.split(" ").every((w) => STOP.has(w))) repeats += c - 1;
      }
      return total ? repeats / total : 0;
    };
    // Blend bigram + trigram repetition; trigrams are the stronger tell.
    return clamp(count(2) * 0.6 + count(3) * 1.4, 0, 1);
  }

  // ---- Repeated sentence openers: AI starts many sentences the same way. ----
  // "This...", "These...", "It's...", "By doing...", "While...", "Additionally,"
  function openerRepetition(sents) {
    if (sents.length < 3) return 0;
    const openers = sents.map((s) => {
      const m = s.toLowerCase().match(/^[\s"']*([a-z']+)(?:\s+([a-z']+))?/);
      if (!m) return "";
      // Use the first word, plus the second when the first is a weak lead-in.
      const weak = new Set(["this", "these", "it", "by", "while", "as", "in", "with", "when", "for", "to"]);
      return weak.has(m[1]) && m[2] ? m[1] + " " + m[2] : m[1];
    });
    const counts = new Map();
    for (const o of openers) if (o) counts.set(o, (counts.get(o) || 0) + 1);
    let maxRepeat = 0;
    for (const c of counts.values()) maxRepeat = Math.max(maxRepeat, c);
    // 3+ sentences sharing an opener in a short passage is a clear pattern.
    return clamp((maxRepeat - 1) / Math.max(2, sents.length * 0.4), 0, 1);
  }

  // ---- "Rule of three": AI lists exactly three items/adjectives constantly. ----
  function ruleOfThree(text) {
    // "X, Y, and Z" patterns (commas + a final "and"/"or").
    const m = text.match(/\b[\w'-]+,\s+[\w'-]+,\s+and\s+[\w'-]+\b/gi) || [];
    return m.length;
  }

  // Count regex-template hits across a list.
  function regexHits(text, regexes) {
    let n = 0;
    for (const re of regexes) if (re.test(text)) n++;
    return n;
  }

  // ---- Punctuation profile ----
  // AI prose leans on "formal" punctuation: serial/Oxford commas, semicolons,
  // and mid-sentence colons. Humans use parentheticals, ellipses, dashes, and
  // sentence fragments more. Returns 0..1 where 1 = AI-like punctuation.
  function punctuationProfile(text, sents, wordCount) {
    if (!wordCount) return 0;
    const per100 = (n) => (n / wordCount) * 100;
    const oxford = (text.match(/,\s+(?:and|or)\s+\w/gi) || []).length;
    const semicolons = (text.match(/;/g) || []).length;
    const colonsMid = (text.match(/\w:\s+[a-z]/g) || []).length; // colon mid-sentence
    // Human informality markers (push the score DOWN).
    const parens = (text.match(/\([^)]*\)/g) || []).length;
    const ellipses = (text.match(/\.\.\.|…/g) || []).length;
    const fragments = sents.filter((s) => s.split(/\s+/).length <= 4).length;
    const exclaims = (text.match(/!/g) || []).length;

    // Formal markers raise the AI signal; informal markers lower it.
    const formal = per100(oxford) * 0.5 + per100(semicolons) * 1.2 + per100(colonsMid) * 1.0;
    const informal = per100(parens) + per100(ellipses) * 1.5 +
                     per100(fragments) * 0.4 + per100(exclaims) * 0.6;
    return clamp((formal - informal) / 2.5, 0, 1);
  }

  // ---- Per-sentence AI score ----
  // A lightweight per-sentence estimate so the UI can highlight the lines that
  // read most like AI. Uses the cheap, sentence-local signals.
  function scoreSentence(s) {
    const ws = words(s);
    const wc = ws.length;
    if (wc < 4) return 0;
    let score = 0;
    // Phrase + word clichés in this sentence.
    score += clamp(density(s, AI_PHRASES, wc) / 2, 0, 1) * 0.4;
    score += clamp(density(s, AI_WORDS, wc) / 4, 0, 1) * 0.25;
    // Antithesis / formulaic templates land hard at sentence level.
    if (regexHits(s, ANTITHESIS)) score += 0.3;
    const low = s.toLowerCase();
    if (FORMULAIC_OPENERS.some((o) => low.startsWith(o))) score += 0.2;
    // Long, comma-heavy, semicolon-using sentences read formal.
    if (wc > 25) score += 0.1;
    if (/;/.test(s)) score += 0.1;
    return clamp(score, 0, 1);
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

    // Cliché phrases + single-word AI tells, combined per 100 words.
    const cliche = density(t, AI_PHRASES, wordCount) + density(t, AI_WORDS, wordCount) * 0.6;
    const sigCliche = clamp(cliche / 3, 0, 1);

    const hedge = density(t, HEDGES, wordCount);
    const sigHedge = clamp(hedge / 3, 0, 1);

    // Em-dash / formal punctuation regularity
    const dashes = (t.match(/—|–/g) || []).length;
    const sigDash = clamp((dashes / sents.length) / 0.5, 0, 1);

    // Contractions: humans use them more in most registers.
    const contractions = (t.match(/\b\w+'\w+\b/g) || []).length;
    const contractionRate = contractions / wordCount;
    const sigNoContractions = clamp((0.02 - contractionRate) / 0.02, 0, 1);

    // Repeated phrasing (n-gram reuse) — a hallmark of generated text.
    const sigRepeat = ngramRepetition(ws);

    // Repeated sentence openers (This/These/It's/By.../While...).
    const sigOpeners = openerRepetition(sents);

    // Antithesis templates: "not just X, but Y", "It's not X, it's Y".
    const antithesisHits = regexHits(t, ANTITHESIS);
    const sigAntithesis = clamp(antithesisHits / 2, 0, 1);

    // Rule-of-three lists ("X, Y, and Z") per 100 words.
    const threes = ruleOfThree(t);
    const sigThree = clamp((threes / wordCount) * 100 / 1.2, 0, 1);

    // Formulaic openers/closers ("In conclusion", "Overall", "Imagine...").
    const formulaic = phraseHits(t, FORMULAIC_OPENERS.map((p) => p));
    const sigFormulaic = clamp(formulaic / 3, 0, 1);

    // Punctuation profile (formal serial commas/semicolons/colons vs. informal).
    const sigPunct = punctuationProfile(t, sents, wordCount);

    // Predictability / perplexity proxy: how often the next word is the
    // statistically obvious one. LLM text is low-perplexity (very predictable).
    const P = (typeof global !== "undefined" && global.Predictability) ||
              (typeof window !== "undefined" && window.Predictability) || null;
    const sigPredict = P ? P.predictability(t) : 0.5;
    const hasPredict = !!P;

    // Weighted blend. Predictability + repetition + cliché are the strongest.
    const weights = [
      [sigCliche, 0.20, "AI cliché / buzzword density", cliche.toFixed(1) + " / 100 words"],
      [sigPredict, 0.16, "Predictability (perplexity)", sigPredict > 0.5 ? "low perplexity (AI-like)" : "high perplexity (human-like)"],
      [sigRepeat, 0.13, "Repeated phrasing", sigRepeat > 0.3 ? "reuses phrases (AI-like)" : "low repetition"],
      [sigBurst, 0.12, "Sentence rhythm", burst > 0.5 ? "varied (human-like)" : "uniform (AI-like)"],
      [sigOpeners, 0.09, "Repeated sentence openers", sigOpeners > 0.3 ? "same openings repeat" : "varied openings"],
      [sigPunct, 0.07, "Punctuation profile", sigPunct > 0.4 ? "formal (AI-like)" : "informal (human-like)"],
      [sigAntithesis, 0.06, "Antithesis templates", antithesisHits + " (\"not X, but Y\")"],
      [sigVariety, 0.05, "Vocabulary variety", (variety * 100).toFixed(0) + "% unique"],
      [sigHedge, 0.04, "Hedging / filler", hedge.toFixed(1) + " / 100 words"],
      [sigThree, 0.03, "Rule-of-three lists", threes + " found"],
      [sigFormulaic, 0.03, "Formulaic framing", formulaic + " openers/closers"],
      [sigNoContractions, 0.01, "Contraction use", contractions + " found"],
      [sigDash, 0.01, "Em-dash regularity", dashes + " dashes"],
    ];

    // If the predictability table isn't loaded, redistribute its weight so the
    // score stays calibrated (don't let a neutral 0.5 drag every result up).
    if (!hasPredict) weights.splice(1, 1);

    let score = 0;
    for (const [val, w] of weights) score += val * w;
    score = score * 100;

    // Heavy *phrase-level* cliché use is a strong tell — floor the score so a
    // single varied-rhythm pass can't mask it. Single-word buzzwords are noisier
    // (some are normal English), so the floor keys off multi-word phrase hits.
    const phraseCliche = density(t, AI_PHRASES, wordCount);
    if (phraseCliche >= 3) score = Math.max(score, 66);
    if (phraseCliche >= 5) score = Math.max(score, 78);
    // Strong repetition is itself a reliable tell.
    if (sigRepeat >= 0.5) score = Math.max(score, 65);
    // Multiple antithesis templates in one passage rarely happen in human prose.
    if (antithesisHits >= 2) score = Math.max(score, 70);
    // Very low perplexity / heavy filler constructions: fluent but contentless
    // text reads AI even with no buzzwords. Require a corroborating structural
    // signal (uniform rhythm OR repeated openers OR another filler tell) so a
    // plain-but-human short paragraph isn't flagged on predictability alone.
    const corroborated = sigBurst >= 0.4 || sigOpeners >= 0.3 || sigCliche >= 0.2;
    if (hasPredict && sigPredict >= 0.75 && corroborated) score = Math.max(score, 58);
    if (hasPredict && sigPredict >= 0.9 && corroborated) score = Math.max(score, 66);

    score = Math.round(clamp(score, 1, 99));

    let label;
    if (score >= 70) label = "Likely AI-generated";
    else if (score >= 45) label = "Mixed / uncertain";
    else label = "Likely human-written";

    const signals = weights.map(([val, w, name, detail]) => ({
      name, detail,
      contribution: Math.round(val * 100),
    }));

    // Per-sentence scores so the UI can highlight the most AI-like lines.
    const perSentence = sents.map((s) => ({
      text: s,
      score: Math.round(scoreSentence(s) * 100),
    }));

    return { score, label, signals, wordCount, perSentence };
  }

  global.Detector = { detect };
})(typeof window !== "undefined" ? window : globalThis);
