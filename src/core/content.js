// Content script: relays the current text selection on demand.
chrome.runtime.onMessage.addListener((msg, _s, send) => {
  if (msg.type === "getSelection") {
    send({ selection: window.getSelection().toString() });
  }
  return true;
});
