/* Shared renderer for detector results — used by both the standalone app
   and the in-extension page. Expects window.Detector to be loaded.

   Renders a ZeroGPT/GPTZero-style report: a percentage gauge, a graded verdict
   + confidence band, a metrics panel (counts / reading time / keyword density),
   plain-English "why" explanation tags, the per-signal breakdown, and full
   color-coded per-sentence highlighting (green → yellow → orange → red). */
(function (global) {
  "use strict";

  function colorFor(score) {
    if (score >= 70) return "#ef4444";   // red — likely AI
    if (score >= 45) return "#f59e0b";   // amber — uncertain
    return "#22c55e";                    // green — likely human
  }

  // Per-sentence tier -> color (ZeroGPT escalation: green→yellow→orange→red).
  const TIER_COLOR = {
    human: "#22c55e",   // green
    low: "#eab308",     // yellow
    mid: "#f97316",     // orange
    high: "#ef4444",    // red
  };
  const TIER_LABEL = {
    human: "Human-like", low: "Slightly AI", mid: "Likely AI", high: "Strongly AI",
  };

  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  function fmtTime(sec) {
    if (sec < 60) return sec + "s";
    const m = Math.floor(sec / 60), s = sec % 60;
    return s ? `${m}m ${s}s` : `${m}m`;
  }

  // Renders into `el` (an element). Returns nothing.
  function renderDetector(el, result) {
    if (!result || result.score == null) {
      el.innerHTML =
        '<p class="detector-empty">' +
        (result && result.note ? result.note : "No result.") +
        "</p>";
      return;
    }

    const col = colorFor(result.score);

    // --- Verdict + confidence band ---
    const conf = result.confidence || { level: "medium", note: "" };
    const polishedBadge = result.aiPolished
      ? `<span class="polished-badge" title="Looks human-written but cleaned up by AI">✎ AI-Polished</span>`
      : "";

    // --- Metrics panel (ZeroGPT-style) ---
    const m = result.metrics || {};
    const kwHtml = (m.keywords && m.keywords.length)
      ? `<div class="kw-row">${m.keywords
          .map((k) => `<span class="kw-chip">${esc(k.word)} <b>${k.count}</b></span>`)
          .join("")}</div>`
      : "";
    const metricsHtml = m.wordCount != null ? `
      <div class="metrics-grid">
        <div class="metric"><span class="metric-val">${m.wordCount}</span><span class="metric-lbl">words</span></div>
        <div class="metric"><span class="metric-val">${m.charsNoSpace}</span><span class="metric-lbl">chars</span></div>
        <div class="metric"><span class="metric-val">${m.sentenceCount}</span><span class="metric-lbl">sentences</span></div>
        <div class="metric"><span class="metric-val">${m.avgWordsPerSentence}</span><span class="metric-lbl">avg words/sent</span></div>
        <div class="metric"><span class="metric-val">${fmtTime(m.readingTimeSec)}</span><span class="metric-lbl">read time</span></div>
        <div class="metric"><span class="metric-val">${fmtTime(m.speakingTimeSec)}</span><span class="metric-lbl">speak time</span></div>
      </div>
      ${kwHtml ? `<div class="kw-head">Most-repeated words</div>${kwHtml}` : ""}` : "";

    // --- Explanation tags (why it reads AI / human) ---
    const tags = result.tags || { ai: [], human: [] };
    const tagList = (items, kind) => items.map((tObj) =>
      `<span class="why-tag why-${kind}" title="${esc(tObj.why)}">${esc(tObj.tag)}</span>`
    ).join("");
    let tagsHtml = "";
    if ((tags.ai && tags.ai.length) || (tags.human && tags.human.length)) {
      tagsHtml = `
        <div class="why-head">Why this verdict</div>
        ${tags.ai && tags.ai.length ? `<div class="why-row"><span class="why-side">Reads AI</span>${tagList(tags.ai, "ai")}</div>` : ""}
        ${tags.human && tags.human.length ? `<div class="why-row"><span class="why-side">Reads human</span>${tagList(tags.human, "human")}</div>` : ""}
        <p class="why-hint">Hover a tag to see what triggered it.</p>`;
    }

    // --- Per-signal breakdown bars ---
    const signalsHtml = result.signals
      .filter((s) => s.contribution > 0)
      .map(
        (s) => `
        <li class="signal">
          <span class="signal-name">${esc(s.name)}</span>
          <span class="signal-detail">${esc(s.detail)}</span>
          <div class="signal-bar"><i style="--w:${s.contribution}%; background:${col}"></i></div>
        </li>`
      )
      .join("");

    // --- Full color-coded sentence highlighting (ZeroGPT signature) ---
    let highlightHtml = "";
    if (Array.isArray(result.perSentence) && result.perSentence.length) {
      const body = result.perSentence
        .map((s) => {
          const c = TIER_COLOR[s.tier] || TIER_COLOR.human;
          return `<mark class="hl hl-${s.tier}" style="--hl:${c}" title="${TIER_LABEL[s.tier]} · ${s.score}% AI">${esc(s.text)}</mark>`;
        })
        .join(" ");
      const legend = `
        <div class="hl-legend">
          <span><i style="background:${TIER_COLOR.human}"></i>Human-like</span>
          <span><i style="background:${TIER_COLOR.low}"></i>Slightly AI</span>
          <span><i style="background:${TIER_COLOR.mid}"></i>Likely AI</span>
          <span><i style="background:${TIER_COLOR.high}"></i>Strongly AI</span>
        </div>`;
      highlightHtml = `
        <div class="hl-head">Sentence-by-sentence</div>
        ${legend}
        <div class="hl-body">${body}</div>`;
    }

    el.innerHTML = `
      <div class="gauge-row">
        <div class="gauge" style="--val:${result.score}; --col:${col}">
          <span>${result.score}%</span>
          <small>AI</small>
        </div>
        <div class="gauge-info">
          <div class="gauge-label" style="color:${col}">${esc(result.verdict || result.label)} ${polishedBadge}</div>
          <div class="conf-band conf-${conf.level}">
            <span class="conf-dot"></span>${esc(conf.note)}
          </div>
          <div class="gauge-sub">Estimated AI-likelihood across ${m.wordCount || result.wordCount} words.
            This is a probability the text reads like AI — an estimate, not proof.</div>
        </div>
      </div>
      ${metricsHtml}
      ${tagsHtml}
      <details class="signal-details"><summary>Signal breakdown</summary>
        <ul class="signals">${signalsHtml}</ul>
      </details>
      ${highlightHtml}`;
  }

  global.renderDetector = renderDetector;
})(typeof window !== "undefined" ? window : globalThis);
