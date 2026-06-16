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
    // Casual-AI stock phrases — strip the conversational scaffolding.
    [/\blet'?s be (?:real|honest)\b,?\s*/gi, ""],
    [/\bhere'?s the (?:thing|deal)\b:?\s*/gi, ""],
    [/\blet'?s face it\b,?\s*/gi, ""],
    [/\bmake no mistake\b,?\s*/gi, ""],
    [/\bat the end of the day\b,?\s*/gi, ""],
    [/\bthe (?:truth|reality) is\b,?\s*/gi, ""],
    [/\bwe'?ve got to\b/gi, "we should"],
    [/\bisn'?t going anywhere\b/gi, "is here"],
    [/\bit'?s pretty wild\b/gi, "it's strange"],
    [/\btrust me\b,?\s*/gi, ""],
    [/\bbelieve me\b,?\s*/gi, ""],
    [/\bbuckle up\b,?\s*/gi, ""],
    [/\band honestly\b,?/gi, ""],
    [/\bhonestly\b,\s*/gi, ""],
    // More AI buzzwords -> plain words.
    [/\bdelve into\b/gi, "look at"],
    [/\bdelving into\b/gi, "looking at"],
    [/\bdive into\b/gi, "get into"],
    [/\bdiving into\b/gi, "getting into"],
    [/\bembark on\b/gi, "start"],
    [/\bembark upon\b/gi, "start"],
    [/\bharnessing\b/gi, "using"],
    [/\bharnesses\b/gi, "uses"],
    [/\bharnessed\b/gi, "used"],
    [/\bharness\b/gi, "use"],
    [/\bunlocking\b/gi, "opening up"],
    [/\bunlocks\b/gi, "opens up"],
    [/\bunlocked\b/gi, "opened up"],
    [/\bunlock\b/gi, "open up"],
    [/\bunleashing\b/gi, "releasing"],
    [/\bunleashes\b/gi, "releases"],
    [/\bunleashed\b/gi, "released"],
    [/\bunleash\b/gi, "release"],
    [/\belevates\b/gi, "raises"],
    [/\belevating\b/gi, "raising"],
    [/\belevate\b/gi, "raise"],
    [/\bempowers\b/gi, "helps"],
    [/\bempowering\b/gi, "helping"],
    [/\bempower\b/gi, "help"],
    [/\boptimize\b/gi, "improve"],
    [/\bstreamlines\b/gi, "simplifies"],
    [/\bstreamlined\b/gi, "simplified"],
    [/\bstreamlining\b/gi, "simplifying"],
    [/\bstreamline\b/gi, "simplify"],
    [/\bshowcases\b/gi, "shows"],
    [/\bshowcased\b/gi, "showed"],
    [/\bshowcasing\b/gi, "showing"],
    [/\bshowcase\b/gi, "show"],
    [/\bspearheading\b/gi, "leading"],
    [/\bspearheads\b/gi, "leads"],
    [/\bspearheaded\b/gi, "led"],
    [/\bspearhead\b/gi, "lead"],
    [/\bfosters\b/gi, "builds"],
    [/\bfostering\b/gi, "building"],
    [/\bfoster\b/gi, "build"],
    [/\bdynamic\b/gi, "fast-moving"],
    [/\bunderscores\b/gi, "shows"],
    [/\bunderscored\b/gi, "showed"],
    [/\bunderscoring\b/gi, "showing"],
    [/\bunderscore\b/gi, "show"],
    [/\bcornerstone\b/gi, "basis"],
    [/\ba myriad of\b/gi, "many"],
    [/\bmyriad\b/gi, "many"],
    [/\ba game[- ]changer\b/gi, "a big deal"],
    [/\bcutting[- ]edge\b/gi, "modern"],
    [/\bstate[- ]of[- ]the[- ]art\b/gi, "modern"],
    [/\bever[- ](?:evolving|changing|growing)\b/gi, "changing"],
    [/\bseamlessly\b/gi, "smoothly"],
    [/\bseamless\b/gi, "smooth"],
    [/\bholistic\b/gi, "complete"],
    [/\btransformative\b/gi, "major"],
    [/\bunprecedented\b/gi, "rare"],
    [/\bvibrant\b/gi, "lively"],
    [/\bintricate\b/gi, "detailed"],
    [/\bnuanced\b/gi, "subtle"],
    [/\bprofound\b/gi, "deep"],
    [/\bparamount\b/gi, "key"],
    [/\binvaluable\b/gi, "useful"],
    [/\bindispensable\b/gi, "essential"],
    [/\bboasts?\b/gi, "has"],
    [/\bboasting\b/gi, "with"],
    [/\bshed(?:s|ding)? light on\b/gi, "explains"],
    [/\bstand the test of time\b/gi, "last"],
    [/\bat the end of the day\b/gi, ""],
    [/\bthe bottom line is\b/gi, ""],
    [/\brest assured,?\s*/gi, ""],
    [/\bthat being said,?\s*/gi, "still, "],
    [/\bwith that said,?\s*/gi, "still, "],
    [/\bin essence,?\s*/gi, ""],
    [/\ball in all,?\s*/gi, ""],
    [/\bthe (?:rich )?tapestry of\b/gi, "the mix of"],
    [/\bin the (?:ever[- ]changing )?(?:world|realm|landscape) of\b/gi, "in"],
    [/\blandscape\b/gi, "field"],
    [/\brealm\b/gi, "area"],
    [/\bplay(?:s|ed)? a significant role in\b/gi, "matters for"],
    [/\bvaluable insights?\b/gi, "useful points"],
    [/\bcomprehensive (?:understanding|overview|guide)\b/gi, "full picture"],
    // Abstract self-help / motivational register — the strongest tell in smooth,
    // buzzword-free AI advice. Rewrite to plainer, more concrete phrasing so the
    // detector's "generic-advice abstraction" signal stops firing.
    [/\bcan transform your life in countless ways\b/gi, "changes a lot for you"],
    [/\btransform your life in countless ways\b/gi, "changes a lot for you"],
    [/\bcan transform your life\b/gi, "changes things for you"],
    [/\btransform your life\b/gi, "changes things"],
    [/\bin countless ways\b/gi, "in lots of ways"],
    [/\bcountless ways\b/gi, "lots of ways"],
    [/\byour future self\b/gi, "you later"],
    [/\ba worthwhile investment in\b/gi, "good for"],
    [/\bworthwhile investment\b/gi, "good move"],
    [/\bis a worthwhile (?:choice|goal|pursuit)\b/gi, "is worth it"],
    [/\bworthwhile\b/gi, "worth it"],
    [/\bfor long[- ]term success\b/gi, "to last"],
    [/\blong[- ]term success\b/gi, "lasting results"],
    [/\bwith the right approach,?\s*/gi, ""],
    [/\banyone can (become|master|learn|achieve)\b/gi, "you can $1"],
    [/\bboost(s|ing)? your (?:mood|energy|productivity)\b/gi, "lift$1 your mood"],
    [/\bbenefits both the body and (?:the )?mind\b/gi, "is good for body and head"],
    [/\bboth the body and (?:the )?mind\b/gi, "body and head"],
    [/\bsharpen(s|ing)? your\b/gi, "improve$1 your"],
    [/\brewarding and enriching\b/gi, "rewarding"],
    [/\ban? rewarding and enriching experience\b/gi, "really rewarding"],
    [/\benriches your (?:mind|life)\b/gi, "is good for you"],
    [/\bwell worth the effort\b/gi, "worth it"],
    [/\bworth the effort\b/gi, "worth it"],
    [/\bset aside time each day\b/gi, "do a bit each day"],
    [/\bset aside time\b/gi, "make time"],
    [/\binto your daily routine\b/gi, "into your day"],
    [/\bopens? doors to new\b/gi, "leads to new"],
    [/\byou'?ll soon notice\b/gi, "you'll notice"],
    [/\bone of the simplest ways to\b/gi, "an easy way to"],
    [/\bthe simplest ways? to\b/gi, "an easy way to"],
    [/\bplays? a central role in\b/gi, "matters a lot for"],
    [/\ba powerful advantage\b/gi, "a real edge"],
    [/\bto improve your life\b/gi, "to feel better"],
    [/\bimprove your life\b/gi, "make life better"],
    [/\ba rewarding (?:and \w+ )?experience\b/gi, "really rewarding"],
    [/\brewarding experience\b/gi, "fun to do"],
  ];

  // Antithesis templates AI overuses: "not just X, but Y", "It's not X, it's Y".
  // We collapse them to the affirmative half so the rhythm stops repeating.
  function breakAntithesis(text) {
    let out = text;
    // "It's not (just) X, it's Y" -> "It's Y"
    out = out.replace(
      /\bit'?s not (?:just |merely |only |simply )?[^.,;!?]{1,60}?,\s*it'?s\b/gi,
      "it's"
    );
    // "not just/only/merely X, but (also) Y" -> "X, and Y" (keep both halves,
    // drop the templated framing).
    out = out.replace(
      /\bnot (?:just|only|merely|simply)\s+([^.,;!?]{1,60}?),?\s+but(?: also)?\s+/gi,
      "$1, and "
    );
    // "more than just X" -> "more than X"
    out = out.replace(/\bmore than (?:just|simply)\b/gi, "more than");
    // "isn't just X" -> "isn't only X" reads less templated... actually drop "just".
    out = out.replace(/\bisn'?t (?:just|only|merely|simply)\b/gi, "isn't");
    return out;
  }

  // Formulaic openers/closers AI bolts onto paragraphs. Strip the framing word
  // and let the real sentence stand on its own.
  function dropFormulaic(text) {
    let out = text;
    const leads = [
      "in conclusion", "to conclude", "in summary", "to summarize",
      "all in all", "in essence", "at its core", "first and foremost",
      "to begin with", "needless to say", "it goes without saying that",
    ];
    for (const lead of leads) {
      const re = new RegExp("(^|[.!?]\\s+)" + lead.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ",?\\s+", "gi");
      out = out.replace(re, "$1");
    }
    // "Here are N tips/ways/steps for X." opener — drop the framing sentence.
    out = out.replace(/(^|[.!?]\s+)here are \w+ (?:tips|ways|steps|reasons|things|strategies|methods)\b[^.!?]*[.!?]\s*/gi, "$1");
    // Tutorial closer: "This (practice) ensures/guarantees X." — drop it.
    out = out.replace(/\b(?:this|that|these|the above)(?:\s+\w+){0,2}\s+(?:ensures?|guarantees?|provides?|delivers?)\s+[^.!?]*[.!?]/gi, "");
    // "you'll want/need/have to" tutorial hedge -> plain imperative.
    out = out.replace(/\byou'?ll (?:want|need|have) to\b/gi, "");
    // Re-capitalize sentence starts we may have exposed.
    out = out.replace(/(^|[.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
    return out;
  }

  // De-enumerate: strip the explicit "First,/Second,/Next,/Finally,/Lastly,"
  // scaffolding and "1./2)" numbering that makes listicles read as AI. The
  // content stays; only the mechanical sequence markers go, which lets the
  // sentences flow as prose. Connectors vary so it doesn't read templated.
  const SEQUENCE_OPENERS =
    /^(first(?:ly)?|second(?:ly)?|third(?:ly)?|fourth(?:ly)?|fifth(?:ly)?|next|then|finally|lastly|to begin with|to start)\b[,:]?\s*/i;
  // Connectors used when stripping "First,/Second,/Next," scaffolding. We avoid
  // "After that,"/"Then," here because the detector (correctly) reads them as
  // sequence/ordinal openers — re-introducing them would just trade one
  // enumeration tell for another. Bare drops + an occasional "And " keep flow.
  const FLOW_CONNECTORS = ["", "", "", "And ", "Plus "];
  function deEnumerate(sentences, rnd) {
    let seq = 0;
    let prevConn = null;            // avoid repeating the same connector in a row
    return sentences.map((s, i) => {
      let out = s.replace(/^\s*\d+[.)]\s+/, ""); // drop "1. " / "2) "
      if (SEQUENCE_OPENERS.test(out)) {
        out = out.replace(SEQUENCE_OPENERS, "");
        // Occasionally weave in a light connector instead of a bare drop, so a
        // long stripped list doesn't become a flat run of identical openings.
        // Re-roll if we'd repeat the previous connector back-to-back.
        let conn = FLOW_CONNECTORS[Math.floor((rnd ? rnd(i) : 0) * FLOW_CONNECTORS.length)];
        if (conn && conn === prevConn) {
          conn = FLOW_CONNECTORS[Math.floor((rnd ? rnd(i + 37) : 0) * FLOW_CONNECTORS.length)];
        }
        prevConn = conn || prevConn;
        out = conn + (conn ? out.charAt(0).toLowerCase() + out.slice(1)
                           : out.charAt(0).toUpperCase() + out.slice(1));
        seq++;
      }
      return out;
    });
  }

  // De-participialize AI's favorite sentence openers: "Having established X, Y",
  // "By doing X, Y", "Leveraging X, Y", "When it comes to X, Y". These read as a
  // strong GPT fingerprint. We rewrite the leading participial/gerund phrase into
  // a plain clause so the sentence starts with its real subject.
  function deParticipialize(sentences) {
    return sentences.map((s) => {
      let out = s;
      // "By doing X, <clause>" -> turn the gerund phrase into the subject.
      // If the trailing clause already has its own subject ("organizations can…"),
      // just promote the gerund ("Doing X helps organizations…" would need a verb,
      // so keep it simple: "Doing X. <clause>" reads wrong) — instead drop "By"
      // and join with "and": "Doing X, and organizations can…" still clunky, so
      // we special-case: bare-verb clause -> "lets you"; subject-led clause ->
      // keep the gerund as subject and connect with a comma + the clause as-is.
      out = out.replace(/^(\s*)by\s+(\w+ing\b[^,]*),\s+(.*)$/i, (m, sp, phrase, tail) => {
        // If the tail is a full clause with its own subject, move the "by …"
        // phrase to the END (always grammatical): "By X, S can Y" -> "S can Y by X".
        const subjectLed = /^(?:you|we|they|it|this|that|these|those|he|she|i|the\s+\w+|\w+s)\s+\w/i.test(tail);
        if (subjectLed) {
          const t = tail.replace(/[.!?]+$/, "");
          return `${sp}${t.charAt(0).toUpperCase() + t.slice(1)} by ${phrase}. `;
        }
        // Bare-verb tail ("By X, do Y") -> "Xing … lets you do Y".
        const G = phrase.charAt(0).toUpperCase() + phrase.slice(1);
        return `${sp}${G} lets you ${tail}`;
      });
      // "Having <verbed> X, Y" -> "Once you <verb> X, Y" (rough but plainer).
      out = out.replace(/^(\s*)having\s+(\w+?)(?:ed|en)\b([^,]*),\s+/i,
        (m, sp, verb, rest) => `${sp}Once you ${verb}${rest}, `);
      // "Leveraging/Using/Focusing X, Y" -> "With X, Y" when the gerund is a
      // generic vehicle verb; otherwise leave it.
      out = out.replace(/^(\s*)(?:leveraging|utilizing|using|harnessing|employing)\s+([^,]{2,40}),\s+/i,
        (m, sp, obj) => `${sp}With ${obj}, `);
      // "When it comes to X, Y" -> "For X, Y"
      out = out.replace(/^(\s*)when it comes to\s+([^,]{2,40}),\s+/i,
        (m, sp, obj) => `${sp}For ${obj}, `);
      return out;
    });
  }

  // De-duplicate repeated sentence openers: if several sentences in a row start
  // with the same word ("This...", "These...", "Additionally,"), drop or swap
  // the lead-in on the repeats so the rhythm varies.
  function varyOpeners(sentences) {
    const SWAP = {
      "additionally": "", "moreover": "", "furthermore": "",
      "consequently": "So ", "therefore": "So ", "thus": "So ",
      "however": "But ", "nevertheless": "Still ", "nonetheless": "Still ",
    };
    let prevOpener = "";
    return sentences.map((s) => {
      const m = s.match(/^([A-Za-z']+)\b/);
      const first = m ? m[1].toLowerCase() : "";
      if (first && first === prevOpener) {
        // Same opener as the previous sentence — vary it.
        if (first in SWAP) {
          const rep = SWAP[first];
          let rest = s.replace(/^[A-Za-z']+,?\s*/, "");
          let next = rep + (rep ? rest.charAt(0).toLowerCase() + rest.slice(1)
                                 : rest.charAt(0).toUpperCase() + rest.slice(1));
          prevOpener = (next.match(/^([A-Za-z']+)/) || ["", ""])[1].toLowerCase();
          return next;
        }
      }
      prevOpener = first;
      return s;
    });
  }

  // Tighten vague AI "filler constructions": modal hedges that add no content
  // ("can handle" -> "handles"), padded quantifiers, and possessive doubling.
  // This is what lowers the perplexity/filler signal on fluent-but-empty text.
  function tightenFiller(text) {
    let out = text;
    // "X can/will <verb>" -> "X <verb>s" for vague modals. We convert the modal
    // + base verb into a plain present-tense verb to cut the hedge.
    const VERB3 = {
      handle: "handles", adapt: "adapts", help: "helps", provide: "provides",
      ensure: "ensures", make: "makes", allow: "allows", improve: "improves",
      offer: "offers", serve: "serves", vary: "varies", differ: "differs",
      process: "processes", find: "finds", lead: "leads", create: "creates",
      support: "supports", enhance: "improves", learn: "learns", grow: "grows",
    };
    out = out.replace(
      /\b(it|they|this|that|the\s+\w+|users?|system|model|tool|we|you)\s+(?:can|will|may)\s+(\w+)\b/gi,
      (m, subj, verb) => {
        const key = verb.toLowerCase();
        if (!(key in VERB3)) return m;
        const plural = /^(they|we|you|users)$/i.test(subj.trim());
        return subj + " " + (plural ? key : VERB3[key]);
      }
    );
    // Elided subject after a conjunction: "and can adapt" -> "and adapts".
    out = out.replace(
      /\b(and|but|or|that|which)\s+(?:can|will|may)\s+(\w+)\b/gi,
      (m, conj, verb) => {
        const key = verb.toLowerCase();
        return key in VERB3 ? conj + " " + VERB3[key] : m;
      }
    );
    // "continue to <verb>" -> "keeps <verb>ing"? Too fragile — just drop the
    // hedge: "will continue to improve" -> "keeps improving".
    out = out.replace(/\b(?:will\s+)?continue\s+to\s+(\w+)\b/gi, (m, v) => {
      const ing = v.replace(/e$/, "") + "ing";
      return "keeps " + ing;
    });
    // "users will find that it makes" -> "it makes" (drop the framing).
    out = out.replace(/\b\w+\s+find(?:s)?\s+that\s+it\b/gi, "it");
    // Padded quantifiers.
    out = out.replace(/\ba\s+(?:wide|broad|diverse|vast)\s+(?:range|array|variety|spectrum)\s+of\b/gi, "many");
    // Possessive doubling: "its own X and its own Y" -> "X and Y".
    out = out.replace(/\bits?\s+own\s+(\w+)\s+and\s+its?\s+own\s+(\w+)\b/gi, "$1 and $2");
    out = out.replace(/\beach\s+(\w+)\s+has\s+its\s+own\b/gi, "each $1 has");
    // "there are many ways to" -> "you can"
    out = out.replace(/\bthere\s+are\s+(?:many|several|various|numerous|countless)\s+ways?\s+to\b/gi, "you can");
    // "the best way to X is to Y" -> "to X, Y"
    out = out.replace(/\bthe\s+best\s+way\s+to\b/gi, "to");
    // "this will help ensure" -> "this ensures"
    out = out.replace(/\bthis\s+will\s+help\s+ensure\b/gi, "this ensures");
    return out;
  }

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
      .replace(/‘|’/g, "'")
      .replace(/“|”/g, '"')
      .replace(/[ \t]+/g, " ");
  }

  // Remove every hyphen and dash. Dashes used as clause breaks become a
  // comma; hyphens joining words become a space; stray dashes are dropped.
  function removeHyphens(text) {
    let out = text;
    // Em/en dash (with optional surrounding spaces) acting as a clause break.
    out = out.replace(/\s*[—–]\s*/g, ", ");
    // Double hyphen used as a dash.
    out = out.replace(/\s*--\s*/g, ", ");
    // Hyphen joining two word characters -> space (well-known -> well known).
    out = out.replace(/(\w)-(\w)/g, "$1 $2");
    // Any leftover hyphen with spaces or at edges -> drop / normalize.
    out = out.replace(/\s*-\s*/g, " ");
    // A comma right before end punctuation reads wrong: ", ." -> "."
    out = out.replace(/,\s*([.!?])/g, "$1");
    return out.replace(/\s{2,}/g, " ");
  }

  function applyPhrases(text) {
    let out = text;
    for (const [re, rep] of PHRASES) out = out.replace(re, rep);
    out = applyLearned(out);   // replacements learned by the retrospective loop
    // Fix capitalization / spacing left by removed lead-ins.
    out = out.replace(/\s{2,}/g, " ");
    out = out.replace(/(^|[.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
    return out;
  }

  // Apply replacements the retrospective loop has learned. Each is matched as a
  // case-insensitive whole-phrase swap; bad regexes are skipped defensively.
  function applyLearned(text) {
    const L = (typeof window !== "undefined" && window.Learnings) ||
              (typeof globalThis !== "undefined" && globalThis.Learnings) || null;
    if (!L) return text;
    let out = text;
    for (const r of L.learnedReplacements()) {
      try {
        const re = new RegExp("\\b" + r.from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "gi");
        out = out.replace(re, r.to);
      } catch { /* skip malformed */ }
    }
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

  // The strongest AI tells — always strip these at a sentence start.
  const ALWAYS_DROP = new Set([
    "moreover", "furthermore", "additionally", "consequently",
    "indeed", "notably", "importantly", "ultimately",
  ]);

  function thinTransitions(sentences) {
    let removed = 0;
    return sentences.map((s, i) => {
      const lower = s.toLowerCase();
      for (const t of TRANSITIONS) {
        if (lower.startsWith(t + ",") || lower.startsWith(t + " ")) {
          // Always remove the worst offenders; thin the rest ~70%.
          if (ALWAYS_DROP.has(t) || seeded(i, removed) < 0.7) {
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

  // Real burstiness needs BOTH long and short sentences. varyLength() only
  // splits; this merges some adjacent short sentences with a connector so the
  // rhythm isn't a flat run of medium-length lines.
  const MERGE_JOINS = [", and ", ", so ", ", then ", ", but "];
  function mergeShort(sentences, rnd) {
    const out = [];
    let lastMerged = false;        // don't merge two pairs back-to-back
    for (let i = 0; i < sentences.length; i++) {
      const a = sentences[i], b = sentences[i + 1];
      const aLen = a ? a.split(/\s+/).length : 0;
      const bLen = b ? b.split(/\s+/).length : 0;
      // Merge two consecutive short/medium sentences. Higher probability and a
      // slightly larger window than before so flat runs of step-by-step lines
      // (a strong enumeration tell) get woven into longer, bursty sentences.
      // Skip if the previous pair was just merged, so we still keep SOME short
      // sentences (real burstiness needs both long and short).
      if (b && aLen <= 12 && bLen <= 13 && !lastMerged && rnd(i) < 0.7) {
        const join = MERGE_JOINS[Math.floor(rnd(i + 100) * MERGE_JOINS.length)];
        const head = a.replace(/[.!?]+$/, "");
        const tail = b.charAt(0).toLowerCase() + b.slice(1);
        out.push(head + join + tail);
        lastMerged = true;
        i++; // consumed b
      } else {
        out.push(a);
        lastMerged = false;
      }
    }
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
      // Pronoun + auxiliary contractions (no-contraction text is a strong tell).
      [/\bI am\b/g, "I'm"],
      [/\b([Tt]hey|[Ww]e|[Yy]ou) have\b/g, "$1've"],
      [/\b([Tt]hey|[Ww]e|[Yy]ou|[Ii]) will\b/g, "$1'll"],
      [/\b([Tt]hey|[Ww]e|[Yy]ou|[Ii]) would\b/g, "$1'd"],
      [/\b([Hh]e|[Ss]he|[Ii]t) is\b/g, "$1's"],
      [/\b([Hh]e|[Ss]he|[Ii]t|[Tt]hat|[Tt]here) will\b/g, "$1'll"],
      [/\bmust not\b/g, "mustn't"], [/\bcould not\b/g, "couldn't"],
      [/\bwere not\b/g, "weren't"], [/\bwas not\b/g, "wasn't"],
    ];
    let out = text;
    for (const [re, rep] of map) out = out.replace(re, rep);
    return out;
  }

  // Soften AI-formal punctuation: trim serial/Oxford commas in short lists and
  // demote some mid-sentence colons. This lowers the "punctuation profile" tell.
  function informalizePunct(text) {
    let out = text;
    // "X, Y, and Z" -> "X, Y and Z" (drop the Oxford comma humans often skip).
    out = out.replace(/(\w),(\s+(?:and|or)\s+)/g, "$1$2");
    // Mid-sentence colon used to introduce a clause -> comma.
    out = out.replace(/(\w):\s+([a-z])/g, "$1, $2");
    // Semicolons read formal -> split into two sentences or use a comma.
    out = out.replace(/\s*;\s*/g, ", ");
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

  // Concise pass: drop redundant intensifiers/filler words that add length
  // without meaning. Keeps the output short and plain.
  const FILLER_WORDS = [
    "very", "really", "quite", "rather", "actually", "basically",
    "essentially", "simply", "just", "truly", "literally", "definitely",
    "certainly", "absolutely", "completely", "totally", "highly",
    "extremely", "incredibly", "particularly", "especially", "somewhat",
    "in fact", "of course", "as well", "that said",
  ];
  function concise(text) {
    let out = text;
    for (const w of FILLER_WORDS) {
      out = out.replace(new RegExp("\\b" + w + "\\b\\s*", "gi"), "");
    }
    // Fix capitalization after any word we stripped at a sentence start.
    out = out.replace(/(^|[.!?]\s+)([a-z])/g, (m, p, c) => p + c.toUpperCase());
    return out.replace(/\s{2,}/g, " ").replace(/\s+([.,!?;:])/g, "$1");
  }

  // Fix "a"/"an" after our word swaps (e.g. "an changing" -> "a changing",
  // "a opportunity" -> "an opportunity"). Vowel-sound heuristic.
  function fixArticles(text) {
    return text.replace(/\b(a|an)\s+([A-Za-z]+)/g, (m, art, word) => {
      const vowel = /^[aeiou]/i.test(word) ||
        /^(hour|honest|honor|heir)/i.test(word);
      const want = vowel ? "an" : "a";
      // Preserve original capitalization of the article.
      const fixed = art[0] === art[0].toUpperCase()
        ? want.charAt(0).toUpperCase() + want.slice(1) : want;
      return fixed + " " + word;
    });
  }

  // Clean up connector collisions our passes can leave when a merge join (", so ")
  // lands next to a de-enumeration connector ("Also, "/"Then "), or when two
  // connectors stack. e.g. ", so also," / ", and also," / "Also, also," -> one.
  function fixConnectors(text) {
    let out = text;
    // ", so also," / ", and also," / ", but also," -> drop the redundant "also,"
    out = out.replace(/,\s*(so|and|but)\s+also,\s*/gi, ", $1 ");
    // "X and also, Y" / "X, and also Y" -> "X and Y" (merge-join + connector).
    out = out.replace(/\s+and\s+also,?\s+/gi, " and ");
    // Sentence-initial "Also," that our merge/transition passes can leave -> drop
    // when it directly follows another short connector-led sentence; otherwise
    // soften a leading "Also," to "Plus," occasionally is overkill — just keep one.
    out = out.replace(/([.!?]\s+)Also,\s+(?=[A-Z])/g, "$1");
    // Stacked leading connectors: "Also, Then" / "Then, also" -> first only.
    out = out.replace(/\b(Also|Then|Plus|After that),\s+(also|then|plus),?\s+/gi, "$1, ");
    // A bare ", also, X" mid-sentence reads clumsy -> ", and X".
    out = out.replace(/,\s*also,\s*/gi, ", and ");
    // "so also " at a sentence start -> "So ".
    out = out.replace(/(^|[.!?]\s+)so\s+also\b,?\s*/gi, "$1So ");
    // Merge-join + flow-connector collisions: ", so plus ", ", and plus ",
    // ", but plus ", ", so and " -> keep the first connector only.
    out = out.replace(/,\s*(so|and|but|then)\s+(plus|and|then)\b\s*/gi, ", $1 ");
    // De-dup a run of identical sentence-initial "And "/"Plus " openers: if two
    // sentences in a row start with the same connector, drop it on the second.
    out = out.replace(/((?:^|[.!?]\s+)(And|Plus|Then|So)\s)([^.!?]*[.!?]\s+)\2\s/g,
      (m, first, conn, mid) => first + mid);
    return out;
  }

  function tidy(text) {
    return fixConnectors(fixArticles(text))
      .replace(/\s+([.,!?;:])/g, "$1")
      .replace(/([.,!?;:])(?=[^\s"')\]])/g, "$1 ")
      .replace(/\s{2,}/g, " ")
      .replace(/\.{2,}/g, ".")
      .replace(/,\s*,/g, ",")
      .replace(/^\s+|\s+$/g, "");
  }

  // Synonym rotation: common words get several human alternatives, chosen by a
  // per-run seed so the humanizer doesn't ALWAYS make the identical swap (a
  // constant substitution is itself a detectable fingerprint). Picks vary run
  // to run and across occurrences within a run.
  // Only words whose alternatives are grammatically interchangeable in place
  // (no change to the following preposition/argument structure).
  const SYNONYMS = {
    important: ["key", "big", "central"],
    however: ["but", "still", "though"],
    many: ["lots of", "plenty of", "tons of"],
    "for example": ["for instance", "say"],
    because: ["since", "as"],
    really: ["pretty", "quite", "genuinely"],
    "a lot of": ["lots of", "plenty of", "loads of"],
    significant: ["big", "major", "real"],
    "in addition": ["also", "on top of that", "plus"],
  };
  function rotateSynonyms(text, rnd) {
    let out = text;
    let k = 0;
    for (const [word, alts] of Object.entries(SYNONYMS)) {
      const re = new RegExp("\\b" + word.replace(/ /g, "\\s+") + "\\b", "gi");
      out = out.replace(re, (m) => {
        const pick = alts[Math.floor(rnd(k++) * alts.length)];
        // Preserve leading capitalization of the original word.
        return /^[A-Z]/.test(m) ? pick.charAt(0).toUpperCase() + pick.slice(1) : pick;
      });
    }
    return out;
  }

  // Per-run seed: a quick hash of the input plus a salt so successive runs on
  // the same text vary, but a single run stays internally consistent.
  let runSalt = 0;
  function makeRnd(text) {
    const salt = runSalt++;
    let h = 2166136261;
    for (let i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const base = (h >>> 0) % 100000;
    return (i) => {
      // Fold the run salt in directly so successive runs diverge.
      let x = Math.sin((base + salt * 49.137 + (i + 1) * 12.9898)) * 43758.5453;
      return x - Math.floor(x);
    };
  }

  // mode: "balanced" | "simple" | "casual"
  function humanize(text, mode) {
    if (!text || !text.trim()) return "";
    mode = mode || "balanced";
    const rnd = makeRnd(text);

    let t = clean(text);
    t = applyPhrases(t);
    t = breakAntithesis(t);     // kill "not just X, but Y" templates
    t = dropFormulaic(t);       // strip "In conclusion", "First and foremost"…
    t = tightenFiller(t);       // cut vague modal hedges / contentless filler
    t = rotateSynonyms(t, rnd); // vary common-word swaps run to run

    let sentences = splitSentences(t);
    sentences = deEnumerate(sentences, rnd); // strip First,/Second,/numbering
    sentences = deParticipialize(sentences); // "By doing X,…"/"Having X,…" -> plain
    sentences = thinTransitions(sentences);
    sentences = varyOpeners(sentences);   // break repeated sentence openers

    if (mode !== "casual") sentences = varyLength(sentences);
    sentences = mergeShort(sentences, rnd); // merge some short lines (burstiness)
    if (mode === "casual") sentences = casualTouch(sentences);

    t = sentences.join(" ");

    // Contractions are a strong human tell — apply in every mode (simple mode
    // gets the plain ones; balanced/casual get the fuller set already in map).
    t = contract(t);
    t = informalizePunct(t); // soften AI-formal punctuation (commas/colons/semis)

    t = concise(t);          // trim filler — keep it short and simple
    t = removeHyphens(t);    // no hyphens or dashes in the output
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
