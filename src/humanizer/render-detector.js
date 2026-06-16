/* Shared renderer for detector results — used by both the standalone app
   and the in-extension page. Expects window.Detector to be loaded. */
(function (global) {
  "use strict";

  function colorFor(score) {
    if (score >= 70) return "#ef4444";   // red — likely AI
    if (score >= 45) return "#f59e0b";   // amber — uncertain
    return "#22c55e";                    // green — likely human
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
    const signalsHtml = result.signals
      .map(
        (s) => `
        <li class="signal">
          <span class="signal-name">${s.name}</span>
          <span class="signal-detail">${s.detail}</span>
          <div class="signal-bar"><i style="--w:${s.contribution}%; background:${col}"></i></div>
        </li>`
      )
      .join("");

    // Per-sentence highlights: show the sentences that read most AI-like.
    const esc = (s) =>
      s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const sentColor = (s) =>
      s >= 60 ? "#ef4444" : s >= 35 ? "#f59e0b" : "#22c55e";
    let sentencesHtml = "";
    if (Array.isArray(result.perSentence) && result.perSentence.length) {
      const flagged = result.perSentence.filter((s) => s.score >= 35);
      if (flagged.length) {
        sentencesHtml = `
          <div class="sent-head">Most AI-like sentences</div>
          <ul class="sent-list">${flagged
            .sort((a, b) => b.score - a.score)
            .slice(0, 6)
            .map(
              (s) => `<li class="sent-item" style="--sc:${sentColor(s.score)}">
                <span class="sent-score" style="background:${sentColor(s.score)}">${s.score}</span>
                <span class="sent-text">${esc(s.text)}</span>
              </li>`
            )
            .join("")}</ul>`;
      } else {
        sentencesHtml = `<div class="sent-head sent-clean">No sentences stand out as AI-like ✓</div>`;
      }
    }

    el.innerHTML = `
      <div class="gauge-row">
        <div class="gauge" style="--val:${result.score}; --col:${col}">
          <span>${result.score}%</span>
          <small>AI</small>
        </div>
        <div class="gauge-info">
          <div class="gauge-label" style="color:${col}">${result.label}</div>
          <div class="gauge-sub">Estimated AI-likelihood across ${result.wordCount} words.
            Higher = reads more like AI. This is an estimate, not proof.</div>
        </div>
      </div>
      <ul class="signals">${signalsHtml}</ul>
      ${sentencesHtml}`;
  }

  global.renderDetector = renderDetector;
})(typeof window !== "undefined" ? window : globalThis);
