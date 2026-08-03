// Tokin AutoPedido - service worker (MV3)
// Mantiene la config minima; todo el procesamiento ocurre en el popup,
// 100% local en el navegador (sin servidor y sin OAuth embebido).

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["tokin_installed_v2"], (data) => {
    if (!data.tokin_installed_v2) {
      chrome.storage.local.set({ tokin_installed_v2: chrome.runtime.getManifest().version }, () => {});
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "GET_MANIFEST") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return true;
  }
  return false;
});
