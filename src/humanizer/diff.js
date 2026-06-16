/* Word-level diff between original and humanized text.
   Produces an HTML string for the output panel where the parts that changed
   from the original are highlighted. Tokenizes on words + whitespace +
   punctuation so highlights land on meaningful units, not characters.

   diffWords(original, revised) -> { html, changedWords, totalWords, changePct }
   - html: revised text with <mark> around inserted/changed runs
   - changedWords: number of revised word-tokens that are new/changed
   - totalWords: number of revised word-tokens
   - changePct: 0..100, share of the output that differs from the input
*/
(function (global) {
  "use strict";

  // Split into tokens, keeping whitespace and punctuation as their own tokens
  // so we can re-join losslessly.
  function tokenize(text) {
    return (text.match(/\s+|[^\s\w]+|[\w']+/g) || []);
  }

  const isWord = (t) => /[\w']/.test(t);
  const esc = (s) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Classic LCS over token arrays. Inputs are paragraph-sized, so the O(n*m)
  // table is fine.
  function lcs(a, b) {
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i][j] =
          a[i] === b[j]
            ? dp[i + 1][j + 1] + 1
            : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    // Walk back to an op list: 'same' | 'add' (token from b) | 'del' (from a).
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) { ops.push({ t: "same", v: b[j] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "del", v: a[i] }); i++; }
      else { ops.push({ t: "add", v: b[j] }); j++; }
    }
    while (i < n) ops.push({ t: "del", v: a[i++] });
    while (j < m) ops.push({ t: "add", v: b[j++] });
    return ops;
  }

  function diffWords(original, revised) {
    const a = tokenize(original || "");
    const b = tokenize(revised || "");
    const ops = lcs(a, b);

    let html = "";
    let buf = "";          // run of added tokens awaiting a <mark>
    let changedWords = 0;

    const flush = () => {
      if (buf) { html += `<mark>${esc(buf)}</mark>`; buf = ""; }
    };

    for (const op of ops) {
      if (op.t === "same") {
        flush();
        html += esc(op.v);
      } else if (op.t === "add") {
        buf += op.v;
        if (isWord(op.v)) changedWords++;
      }
      // 'del' tokens are part of the original only — not shown in the output,
      // but the surrounding 'add'/'same' boundary already marks the change.
    }
    flush();

    const totalWords = b.filter(isWord).length;
    const changePct = totalWords ? Math.round((changedWords / totalWords) * 100) : 0;

    return { html, changedWords, totalWords, changePct };
  }

  global.Diff = { diffWords };
})(typeof window !== "undefined" ? window : globalThis);
