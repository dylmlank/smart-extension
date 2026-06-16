/* Local rule-based humanizer.
   Targets common "AI tells": bloated phrases, hedging, transition spam,
   uniform sentence rhythm, em-dash overuse, and corporate filler.
   Runs instantly, offline, with no API. */

(function (global) {
  "use strict";

  // Wordy phrase -> simpler replacement. Case-insensitive, applied first.
  const PHRASES = [
    [/\bin order to\b/gi, "to"],
    [/\bdue to the fact that\b/gi, "because"],
    [/\bin the event that\b/gi, "if"],
    [/\bfor the purpose of\b/gi, "to"],
    [/\bwith regard to\b/gi, "about"],
    [/\bwith respect to\b/gi, "about"],
    [/\bin terms of\b/gi, "for"],
    [/\ba large number of\b/gi, "many"],
    [/\ba majority of\b/gi, "most"],
    [/\bin the realm of\b/gi, "in"],
    [/\bat this point in time\b/gi, "now"],
    [/\bin today's world\b/gi, "today"],
    [/\bin the modern era\b/gi, "today"],
    [/\bit is important to note that\b/gi, ""],
    [/\bit is worth noting that\b/gi, ""],
    [/\bit should be noted that\b/gi, ""],
    [/\bneedless to say,?\s*/gi, ""],
    [/\bplays? a (?:crucial|vital|key|pivotal|significant) role in\b/gi, "matters for"],
    [/\bis a testament to\b/gi, "shows"],
    [/\bserves as a\b/gi, "is a"],
    [/\bwhen it comes to\b/gi, "with"],
    [/\bnavigate the complexities of\b/gi, "handle"],
    [/\bin the grand scheme of things\b/gi, "overall"],
    [/\ba wide range of\b/gi, "many"],
    [/\b(?:a|the)\s+plethora of\b/gi, "plenty of"],
    [/\butilize\b/gi, "use"],
    [/\butilizing\b/gi, "using"],
    [/\bleverage\b/gi, "use"],
    [/\bleveraging\b/gi, "using"],
    [/\bfacilitate\b/gi, "help"],
    [/\bcommence\b/gi, "start"],
    [/\bendeavor\b/gi, "try"],
    [/\bsubsequently\b/gi, "then"],
    [/\bprior to\b/gi, "before"],
    [/\bnumerous\b/gi, "many"],
    [/\bdemonstrate\b/gi, "show"],
    [/\bencompasses\b/gi, "includes"],
    [/\bmultifaceted\b/gi, "complex"],
  ];

  // Sentence-initial transition words that AI overuses. We thin these out.
  const TRANSITIONS = [
    "moreover", "furthermore", "additionally", "consequently",
    "nevertheless", "nonetheless", "thus", "hence", "therefore",
    "indeed", "notably", "importantly", "ultimately", "overall",
  ];

  // Casual openers used (sparingly) in casual mode to break stiff rhythm.
  const CASUAL_OPENERS = ["Honestly, ", "Look, ", "The thing is, ", "Truth is, "];

  function clean(text) {
    return text
      .replace(/—/g, "-")      // em dash -> hyphen
      .replace(/–/g, "-")      // en dash -> hyphen
      .replace(/‘|’/g, "'")
      .replace(/“|”/g, '"')
      .replace(/[ \t]+/g, " ");
  }

  function applyPhrases(text) {
    let out = text;
    for (const [re, rep] of PHRASES) out = out.replace(re, rep);
    // Fix capitalization / spacing left by removed lead-ins.
    out = out.replace(/\s{2,}/g, " ");
    out = out.replace(/(^|[.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
    return out;
  }

  function splitSentences(text) {
    // Keep the delimiter attached to each sentence.
    const parts = text.match(/[^.!?]+[.!?]*\s*/g);
    return parts ? parts.map(s => s.trim()).filter(Boolean) : [];
  }

  // Deterministic pseudo-random based on string + index, so output is stable.
  function seeded(i, n) {
    const x = Math.sin((i + 1) * 12.9898 + n * 78.233) * 43758.5453;
    return x - Math.floor(x);
  }

  function thinTransitions(sentences) {
    let removed = 0;
    return sentences.map((s, i) => {
      const lower = s.toLowerCase();
      for (const t of TRANSITIONS) {
        if (lower.startsWith(t + ",") || lower.startsWith(t + " ")) {
          // Remove ~70% of transition openers to break the pattern.
          if (seeded(i, removed) < 0.7) {
            removed++;
            let rest = s.slice(t.length).replace(/^[,\s]+/, "");
            return rest.charAt(0).toUpperCase() + rest.slice(1);
          }
        }
      }
      return s;
    });
  }

  // Break overly long sentences at conjunctions to vary rhythm.
  function varyLength(sentences) {
    const out = [];
    sentences.forEach((s, i) => {
      const words = s.split(/\s+/);
      if (words.length > 28) {
        const m = s.match(/^(.*?\b\w[^,]*?),\s+(and|but|which|while|so)\s+(.*)$/i);
        if (m && m[1].split(/\s+/).length > 6) {
          let a = m[1].replace(/[.!?]*$/, "") + ".";
          let b = m[3];
          b = b.charAt(0).toUpperCase() + b.slice(1);
          out.push(a, b);
          return;
        }
      }
      out.push(s);
    });
    return out;
  }

  // Light contractions make text read less formal/robotic.
  function contract(text) {
    const map = [
      [/\bit is\b/g, "it's"], [/\bIt is\b/g, "It's"],
      [/\bthat is\b/g, "that's"], [/\bThat is\b/g, "That's"],
      [/\bdo not\b/g, "don't"], [/\bDo not\b/g, "Don't"],
      [/\bdoes not\b/g, "doesn't"], [/\bcannot\b/g, "can't"],
      [/\bwill not\b/g, "won't"], [/\bare not\b/g, "aren't"],
      [/\bis not\b/g, "isn't"], [/\byou are\b/g, "you're"],
      [/\bthey are\b/g, "they're"], [/\bwe are\b/g, "we're"],
      [/\bthere is\b/g, "there's"], [/\bThere is\b/g, "There's"],
      [/\bwould not\b/g, "wouldn't"], [/\bshould not\b/g, "shouldn't"],
      [/\bhave not\b/g, "haven't"], [/\bhas not\b/g, "hasn't"],
    ];
    let out = text;
    for (const [re, rep] of map) out = out.replace(re, rep);
    return out;
  }

  function casualTouch(sentences) {
    return sentences.map((s, i) => {
      if (i > 0 && i % 5 === 2 && seeded(i, 3) < 0.5 && /^[A-Z]/.test(s)) {
        const opener = CASUAL_OPENERS[i % CASUAL_OPENERS.length];
        return opener + s.charAt(0).toLowerCase() + s.slice(1);
      }
      return s;
    });
  }

  function tidy(text) {
    return text
      .replace(/\s+([.,!?;:])/g, "$1")
      .replace(/([.,!?;:])(?=[^\s"')\]])/g, "$1 ")
      .replace(/\s{2,}/g, " ")
      .replace(/\.{2,}/g, ".")
      .replace(/^\s+|\s+$/g, "");
  }

  // mode: "balanced" | "simple" | "casual"
  function humanize(text, mode) {
    if (!text || !text.trim()) return "";
    mode = mode || "balanced";

    let t = clean(text);
    t = applyPhrases(t);

    let sentences = splitSentences(t);
    sentences = thinTransitions(sentences);

    if (mode !== "casual") sentences = varyLength(sentences);
    if (mode === "casual") sentences = casualTouch(sentences);

    t = sentences.join(" ");

    if (mode === "casual" || mode === "balanced") t = contract(t);
    // Simple mode keeps it plain but still de-bloated.

    return tidy(t);
  }

  const SAMPLE =
    "In today's world, it is important to note that artificial intelligence " +
    "plays a crucial role in numerous industries. Moreover, organizations " +
    "utilize these technologies in order to facilitate growth and leverage " +
    "a wide range of opportunities. Furthermore, due to the fact that the " +
    "modern era demands efficiency, companies must navigate the complexities " +
    "of digital transformation, and they cannot ignore the plethora of tools " +
    "available to them, which is a testament to how rapidly the field evolves.";

  global.Humanizer = { humanize, SAMPLE };
})(typeof window !== "undefined" ? window : globalThis);
