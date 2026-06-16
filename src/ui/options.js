const key = document.getElementById("key");
const status = document.getElementById("status");

chrome.storage.local.get("openrouterKey").then(({ openrouterKey }) => {
  if (openrouterKey) key.value = openrouterKey;
});

document.getElementById("save").onclick = async () => {
  await chrome.storage.local.set({ openrouterKey: key.value.trim() });
  status.textContent = "Saved ✓";
  setTimeout(() => (status.textContent = ""), 2000);
};
