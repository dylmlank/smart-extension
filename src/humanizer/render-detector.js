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
      <ul class="signals">${signalsHtml}</ul>`;
  }

  global.renderDetector = renderDetector;
})(typeof window !== "undefined" ? window : globalThis);
