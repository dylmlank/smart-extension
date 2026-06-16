const key = document.getElementById("key");
const codemode = document.getElementById("codemode");
const status = document.getElementById("status");

chrome.storage.local.get(["openrouterKey", "codeModeEnabled"]).then((s) => {
  if (s.openrouterKey) key.value = s.openrouterKey;
  codemode.checked = !!s.codeModeEnabled;
});

document.getElementById("save").onclick = async () => {
  await chrome.storage.local.set({
    openrouterKey: key.value.trim(),
    codeModeEnabled: codemode.checked
  });
  status.textContent = "Saved ✓";
  setTimeout(() => (status.textContent = ""), 2000);
};
