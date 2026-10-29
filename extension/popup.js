const thresholdInput = document.getElementById("threshold");

(async () => {
  const all = await chrome.storage.local.get(null);
  const settings = all.settings || {};
  thresholdInput.value = settings.discountThreshold ?? 15;
  const count = Object.keys(all).filter((key) => key.startsWith("listing:")).length;
  document.getElementById("savedCount").textContent = `${count} anuncios salvos localmente`;
})();

document.getElementById("save").addEventListener("click", async () => {
  const settings = {
    discountThreshold: Math.max(0, Math.min(80, Number.isFinite(Number(thresholdInput.value)) ? Number(thresholdInput.value) : 15))
  };
  await chrome.storage.local.set({ settings });
  document.getElementById("status").textContent = "Configuracao salva. Atualize a busca aberta.";
});

document.getElementById("openSaved").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("saved.html") });
});
