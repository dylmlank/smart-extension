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

  // "Casual AI" tells: stock conversational phrases AI uses when told to sound
  // human/relatable. These survive contractions + informal punctuation (which
  // otherwise read human), so they're a distinct, important signal as AI output
  // gets more natural.
  const CASUAL_AI_PHRASES = [
    "let's be real", "let's be honest", "here's the thing", "here's the deal",
    "the truth is", "let's face it", "make no mistake", "at the end of the day",
    "isn't going anywhere", "is here to stay", "but here's", "the reality is",
    "let's dive in", "buckle up", "spoiler alert", "plot twist", "newsflash",
    "we've all been there", "we've got to", "we need to talk about",
    "think about it", "and honestly", "honestly,", "trust me", "believe me",
    "it's pretty wild", "mind-blowing", "game changer", "no-brainer",
    "let that sink in", "you guessed it", "that's right", "and guess what",
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

  // ---- Enumeration & tutorial voice ----
  // AI loves explicit enumeration ("First,... Second,... Finally,...",
  // "Here are 5 tips") and instructional framing ("To do X, you'll need to...,
  // Then..., This ensures Y"). Both are strong tells humans rarely stack.
  const ORDINAL_OPENERS = [
    "first", "firstly", "second", "secondly", "third", "thirdly",
    "fourth", "fifth", "next", "then", "finally", "lastly", "to begin",
    "to start", "in addition", "furthermore", "moreover",
  ];
  const TUTORIAL_PATTERNS = [
    /\bhere are \w+ (?:tips|ways|steps|reasons|things|strategies|methods|examples)\b/gi,
    /\bto (?:do|implement|achieve|create|build|make|get|ensure) [^.,;]{2,40}?,\s*(?:you|first|start)\b/gi,
    /\b(?:this|that|these)\s+(?:ensures?|guarantees?|provides?|allows?|enables?)\s+\w+(?:\s+and\s+\w+)?\b/gi,
    /\byou'?ll (?:need to|want to|have to)\b/gi,
    /\bby (?:doing|following|using|implementing) (?:this|these|the above)\b/gi,
  ];

  function enumerationSignal(sents, text, wordCount) {
    if (!wordCount) return 0;
    // Count sentences that open with an ordinal/sequence word.
    let ordinalStarts = 0;
    for (const s of sents) {
      const m = s.toLowerCase().match(/^[\s"']*([a-z]+)/);
      if (m && ORDINAL_OPENERS.includes(m[1])) ordinalStarts++;
    }
    // "1. ", "2) ", numbered list markers.
    const numbered = (text.match(/(?:^|\n)\s*\d+[.)]\s/g) || []).length;
    // 3+ ordinal openers (or numbered items) in a passage is a strong tell.
    const seqScore = clamp((ordinalStarts + numbered - 1) / Math.max(2, sents.length * 0.5), 0, 1);

    // Tutorial / instructional framing density.
    let tut = 0;
    for (const re of TUTORIAL_PATTERNS) tut += (text.match(re) || []).length;
    const tutScore = clamp((tut / wordCount) * 100 / 1.2, 0, 1);

    return clamp(Math.max(seqScore, tutScore * 0.9) * 0.6 + (seqScore + tutScore) * 0.2, 0, 1);
  }

  // ---- Human specificity (lowers false positives) ----
  // Human writing (especially factual/expository) is dense with concrete,
  // verifiable detail: proper nouns, numbers, dates, quotes. Generic AI prose
  // is abstract. High specificity is evidence AGAINST AI — returns 0..1 where
  // 1 = very specific/concrete (human-leaning). Used to DAMPEN the AI score.
  function specificity(text, wordCount) {
    if (!wordCount) return 0;
    const per100 = (n) => (n / wordCount) * 100;
    // Proper nouns: capitalized words not at sentence start (rough heuristic).
    const properNouns = (text.match(/(?<=[a-z,]\s)[A-Z][a-z]+/g) || []).length;
    const numbers = (text.match(/\b\d[\d,.]*\b/g) || []).length;
    const years = (text.match(/\b(1[5-9]\d\d|20\d\d)\b/g) || []).length;
    const quotes = (text.match(/["“][^"”]{6,}["”]/g) || []).length;
    const score = per100(properNouns) * 0.5 + per100(numbers) * 0.7 +
                  per100(years) * 1.5 + per100(quotes) * 2;
    return clamp(score / 6, 0, 1);
  }

  // ---- Participial / adverbial sentence openers ----
  // A distinctive GPT fingerprint is opening sentences with a participial or
  // prepositional-gerund phrase ("Leveraging X, you can...", "By doing Y,...",
  // "Having established Z,...", "When it comes to...") and with sentence-initial
  // stance adverbs ("Importantly,", "Notably,", "Ultimately,"). Humans do this
  // occasionally; AI stacks them. Returns 0..1 on the share of such openers.
  const PARTICIPIAL_OPENER =
    /^[\s"']*(?:by\s+\w+ing|when\s+it\s+comes\s+to|having\s+\w+ed|\w+ing\b[^,]{0,40},|with\s+\w+\s+in\s+mind)/i;
  const ADVERB_OPENER = new Set([
    "importantly", "notably", "ultimately", "essentially", "fundamentally",
    "interestingly", "crucially", "significantly", "remarkably", "undoubtedly",
    "arguably", "naturally", "clearly", "indeed", "moreover", "furthermore",
    "additionally", "consequently", "similarly", "specifically", "generally",
  ]);
  function openerStyleSignal(sents) {
    if (sents.length < 3) return 0;
    let hits = 0;
    for (const s of sents) {
      if (PARTICIPIAL_OPENER.test(s)) { hits++; continue; }
      const m = s.toLowerCase().match(/^[\s"']*([a-z]+),/);
      if (m && ADVERB_OPENER.has(m[1])) hits++;
    }
    // 2+ such openers in a passage is a strong, distinctive pattern.
    return clamp((hits - 0.5) / Math.max(2, sents.length * 0.45), 0, 1);
  }

  // ---- Uniform comma cadence ----
  // AI prose tends to place commas at a steady rate and build long, evenly
  // sub-claused sentences. Humans cluster commas (lists, asides) then go bare.
  // We measure the spread of commas-per-sentence: LOW spread + nonzero rate is
  // AI-like; high spread (some bare, some comma-heavy) is human-like.
  function commaCadence(sents) {
    if (sents.length < 4) return 0;
    const counts = sents.map((s) => (s.match(/,/g) || []).length);
    const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
    if (mean < 0.5) return 0;            // few commas overall — no signal
    const variance = counts.reduce((a, b) => a + (b - mean) ** 2, 0) / counts.length;
    const cv = Math.sqrt(variance) / mean;
    // Low CV (uniform comma use) with a meaningful rate reads AI. cv ~0.4 is
    // very uniform; cv ~1.0+ is human-clustered.
    return clamp((0.85 - cv) / 0.7, 0, 1);
  }

  // ---- Generic-advice abstraction ----
  // Structurally, smooth AI "advice/explainer" prose is indistinguishable from
  // formal human exposition: both lack contractions, use even rhythm, and lean
  // on formal punctuation. The real discriminator is CONCRETENESS. Human facts
  // name specific entities (glucose, Lehman Brothers, 1648); generic AI advice
  // stays abstract and motivational ("transform your life", "the key is", "over
  // time", "your future self"). This counts that abstract self-help register —
  // a correctly-signed tell that fires on the AI advice the structural signals
  // miss, and stays near zero on concrete human writing.
  // Tight list of self-help / motivational register markers. Deliberately
  // excludes phrases that also appear in concrete instructional or factual prose
  // ("over time", "regardless of", "long-term", "the key is") — those caused
  // false positives on recipes and science writing. Each entry here is a phrase
  // that, in clusters, signals abstract AI advice specifically.
  const ADVICE_PHRASES = [
    "transform your life", "transform your", "your future self", "your journey",
    "in countless ways", "countless ways", "worthwhile investment",
    "long-term success", "with the right approach", "anyone can become",
    "anyone can master", "boost your mood", "boost your energy",
    "investment in your", "improve your life", "sharpen your",
    "rewarding and enriching", "well worth the effort", "worth the effort",
    "powerful advantage", "benefits both the body", "both the body and the mind",
    "set aside time", "into your daily routine", "your daily routine",
    "you'll soon notice", "you'll soon", "simplest ways to improve",
    "one of the simplest", "enriches your",
    "opens doors to new", "your overall wellbeing", "a rewarding and",
  ];
  function adviceAbstraction(text, wordCount) {
    if (!wordCount) return 0;
    const hits = phraseHits(text, ADVICE_PHRASES);
    // A single advice phrase in a short passage isn't enough — these markers
    // appear once in ordinary writing too. Require the register to actually
    // cluster: the first hit is discounted, so the signal keys on 2+ markers (or
    // a high density). Pure phrase density, no generic second-person term (which
    // legitimately appears in concrete how-to writing like recipes/repairs).
    const effective = Math.max(0, hits - 0.5);
    return clamp((effective / wordCount) * 100 / 1.2, 0, 1);
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

    // Below ~12 words there's too little signal for any estimate.
    if (wordCount < 12) {
      return {
        score: null,
        label: "Need more text",
        note: "Paste at least ~12 words for an estimate.",
        signals: [],
      };
    }
    // 12–19 words: score it, but flag low confidence (fewer signals fire).
    const lowConfidence = wordCount < 20;

    const sents = sentences(t);

    // --- signals (each 0..1 where 1 = more AI-like) ---
    const burst = burstiness(sents);            // human-like high
    const sigBurst = 1 - burst;                 // AI-like when low burstiness

    const variety = ttr(ws);                    // human-like high
    // Normalize: typical human TTR for a paragraph ~0.55-0.7
    const sigVariety = clamp((0.62 - variety) / 0.25, 0, 1);

    // Cliché phrases + single-word AI tells, combined per 100 words.
    // Phrases learned by the retrospective loop are checked too, so the detector
    // catches more over time without a code change.
    const L = (typeof global !== "undefined" && global.Learnings) ||
              (typeof window !== "undefined" && window.Learnings) || null;
    const learned = L ? L.learnedPhrases() : [];
    const cliche = density(t, AI_PHRASES, wordCount) +
                   density(t, AI_WORDS, wordCount) * 0.6 +
                   density(t, learned, wordCount);
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

    // Enumeration + tutorial voice ("First,... Finally,...", "you'll need to...").
    const sigEnum = enumerationSignal(sents, t, wordCount);

    // Casual-AI stock phrases ("let's be real", "here's the thing") — catches
    // AI that mimics a relatable human voice and so defeats the contraction/
    // punctuation signals.
    const casualAI = phraseHits(t, CASUAL_AI_PHRASES);
    const sigCasualAI = clamp((casualAI / wordCount) * 100 / 1.5, 0, 1);

    // Human specificity (concrete nouns/numbers/dates/quotes) — used to dampen
    // the final score, not as an AI signal.
    const sigSpecific = specificity(t, wordCount);

    // Predictability + filler. The raw bigram-frequency signal turned out to be
    // weakly discriminative on its own (AI and human prose overlap heavily), so
    // it carries a small weight. The FILLER-construction density (vague modal
    // hedges, padded quantifiers) is the strong, precise part — it gets its own
    // signal. Weights below were tuned against tests/labeled.json by measuring
    // each signal's AI-vs-human separation.
    const P = (typeof global !== "undefined" && global.Predictability) ||
              (typeof window !== "undefined" && window.Predictability) || null;
    // Filler-construction density is the single best-separating data signal on
    // the labeled set (AI ~0.30 vs human ~0.00), so it carries real weight.
    // predictability() now == fillerDensity() (the bigram match was inverted and
    // dropped — see predictability.js), so we surface filler alone here.
    const sigFiller = P ? P.fillerDensity(t) : 0;
    const hasPredict = !!P;

    // Participial/adverbial sentence openers ("Leveraging X,...", "Notably,...")
    // and uniform comma cadence — two distinctive, correctly-signed AI tells.
    const sigOpenerStyle = openerStyleSignal(sents);
    const sigCommaCadence = commaCadence(sents);

    // Generic-advice abstraction: catches smooth, buzzword-free AI advice that
    // is structurally identical to formal human exposition. The discriminator
    // is concreteness — abstract motivational "advice" register vs. specific
    // entities/facts. Correctly signed (high on AI advice, ~0 on human facts).
    const sigAbstraction = adviceAbstraction(t, wordCount);

    const weights = [
      [sigCliche, 0.19, "AI cliché / buzzword density", cliche.toFixed(1) + " / 100 words"],
      [sigNoContractions, 0.13, "Contraction use", contractions + " found"],
      [sigBurst, 0.12, "Sentence rhythm", burst > 0.5 ? "varied (human-like)" : "uniform (AI-like)"],
      [sigFiller, 0.12, "Filler constructions", sigFiller > 0.3 ? "vague hedges (AI-like)" : "low filler"],
      [sigEnum, 0.10, "Enumeration / tutorial voice", sigEnum > 0.3 ? "lists/steps (AI-like)" : "low"],
      [sigCasualAI, 0.08, "Casual-AI phrases", casualAI + " (\"let's be real\"…)"],
      [sigOpenerStyle, 0.06, "Participial / adverb openers", sigOpenerStyle > 0.3 ? "\"Leveraging X,…\" (AI-like)" : "varied"],
      [sigAbstraction, 0.06, "Generic-advice abstraction", sigAbstraction > 0.3 ? "abstract self-help (AI-like)" : "concrete"],
      [sigHedge, 0.04, "Hedging / filler", hedge.toFixed(1) + " / 100 words"],
      [sigRepeat, 0.04, "Repeated phrasing", sigRepeat > 0.3 ? "reuses phrases (AI-like)" : "low repetition"],
      [sigFormulaic, 0.04, "Formulaic framing", formulaic + " openers/closers"],
      [sigThree, 0.03, "Rule-of-three lists", threes + " found"],
      [sigOpeners, 0.03, "Repeated sentence openers", sigOpeners > 0.3 ? "same openings repeat" : "varied openings"],
      [sigCommaCadence, 0.03, "Comma cadence", sigCommaCadence > 0.4 ? "uniform (AI-like)" : "clustered (human-like)"],
      [sigPunct, 0.02, "Punctuation profile", sigPunct > 0.4 ? "formal (AI-like)" : "informal (human-like)"],
      [sigAntithesis, 0.02, "Antithesis templates", antithesisHits + " (\"not X, but Y\")"],
      [sigVariety, 0.01, "Vocabulary variety", (variety * 100).toFixed(0) + "% unique"],
    ];

    // Drop the data-driven filler signal if the predictability module isn't
    // present, so a missing table doesn't skew the score.
    if (!hasPredict) {
      for (let i = weights.length - 1; i >= 0; i--) {
        if (weights[i][2] === "Filler constructions") weights.splice(i, 1);
      }
    }

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
    // Heavy filler constructions: fluent but contentless AI prose reads AI even
    // with no buzzwords. Require a corroborating structural signal so a plain-
    // but-human paragraph isn't flagged on filler alone.
    const corroborated = sigBurst >= 0.35 || sigOpeners >= 0.3 ||
                         sigCliche >= 0.15 || sigNoContractions >= 0.6;
    if (hasPredict && sigFiller >= 0.5 && corroborated) score = Math.max(score, 58);
    if (hasPredict && sigFiller >= 0.85 && corroborated) score = Math.max(score, 66);

    // Stacked moderate tells: no single signal is damning, but uniform rhythm +
    // formal punctuation + no contractions + some cliché together is a strong
    // AI fingerprint that a plain summed score under-counts. Count how many of
    // these "moderate" thresholds are crossed and floor accordingly.
    // No-contractions counts only at HALF weight: third-person factual prose
    // legitimately lacks contractions, so it's a weak tell on its own.
    let moderate =
      (sigBurst >= 0.6 ? 1 : 0) +
      (sigNoContractions >= 0.8 ? 0.5 : 0) +
      (sigPunct >= 0.35 ? 1 : 0) +
      (sigCliche >= 0.3 ? 1 : 0) +
      (sigHedge >= 0.3 ? 1 : 0) +
      (sigThree >= 0.5 ? 1 : 0) +
      (sigFiller >= 0.4 ? 1 : 0);
    // Concrete, specific writing (dates, proper nouns, quotes) is a hallmark of
    // real human prose — it discounts the stacked-tell count so factual human
    // essays aren't floored as AI. The genuine AI tells (filler, enumeration,
    // explicit clichés) are NOT discounted this way.
    if (sigSpecific >= 0.4) moderate -= 1;
    if (sigSpecific >= 0.7) moderate -= 1;
    // The stacked-tell floor keys on STRUCTURE (rhythm/punctuation/no-
    // contractions), which formal human exposition shares with AI. Only apply it
    // when at least one CONTENT tell is also present (cliché, filler, hedging,
    // or abstract self-help register) — otherwise a concrete factual human
    // paragraph gets floored purely for being formal. This is what keeps
    // expository human writing (photosynthesis, history, science) off the AI list.
    const hasContentTell = sigCliche >= 0.2 || sigFiller >= 0.3 ||
                           sigHedge >= 0.3 || sigAbstraction >= 0.3 ||
                           sigEnum >= 0.3;
    if (moderate >= 3 && hasContentTell) score = Math.max(score, 58);
    if (moderate >= 4 && hasContentTell) score = Math.max(score, 68);

    // Generic-advice abstraction: smooth, buzzword-free AI advice the structural
    // floor now (correctly) ignores still needs catching. Abstract self-help
    // register + formal structure (no contractions / even rhythm) is the
    // fingerprint. Require a corroborating structural signal so a concrete human
    // paragraph that happens to say "your" a few times isn't flagged.
    const abstractCorrob = sigNoContractions >= 0.6 || sigBurst >= 0.5 ||
                           sigPunct >= 0.35;
    if (sigAbstraction >= 0.4 && abstractCorrob && sigSpecific < 0.3) {
      score = Math.max(score, 58);
    }
    if (sigAbstraction >= 0.65 && abstractCorrob && sigSpecific < 0.3) {
      score = Math.max(score, 66);
    }

    // Enumeration / tutorial voice is a strong, distinctive AI tell.
    if (sigEnum >= 0.5) score = Math.max(score, 60);
    if (sigEnum >= 0.75) score = Math.max(score, 70);

    // Stacked participial/adverb openers ("Leveraging X,… Notably,…") rarely
    // happen in human prose — floor when the pattern is pronounced.
    if (sigOpenerStyle >= 0.6) score = Math.max(score, 60);
    if (sigOpenerStyle >= 0.85) score = Math.max(score, 68);

    // 2+ casual-AI stock phrases in a short passage is a strong tell that
    // survives casual styling.
    if (casualAI >= 2) score = Math.max(score, 62);
    if (casualAI >= 3) score = Math.max(score, 72);

    // Specificity damping: concrete human writing is evidence against AI. Pull
    // the score down when specificity is high and the STRONG AI tells (filler,
    // enumeration) are absent. We allow some cliché here because formal human
    // prose uses words like "fundamentally"/"established" too. Capped so real
    // AI can't hide behind a single statistic.
    if (sigSpecific > 0.35 && sigFiller < 0.4 && sigEnum < 0.4 && phraseCliche < 2) {
      const reduce = Math.min(26, sigSpecific * 34);
      score -= reduce;
    }

    // Short-text: with fewer signals, pull toward the middle (less confident).
    if (lowConfidence) score = Math.round(score * 0.85 + 8);

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

    return { score, label, signals, wordCount, perSentence, lowConfidence };
  }

  global.Detector = { detect };
})(typeof window !== "undefined" ? window : globalThis);
