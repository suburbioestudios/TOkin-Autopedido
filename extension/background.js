// Tokin AutoPedido - service worker (MV3)
// Orquesta el documento offscreen: lo crea cuando hace falta y responde a los
// heartbeats que lo mantienen vivo. Todo el procesamiento del pedido corre en
// el offscreen, 100% local en el navegador (sin servidor y sin OAuth embebido).

const OFFLINE_URL = "offscreen/offscreen.html";
const CART_JOB_KEY = "tokinCartJob";
const CART_CANCEL_KEY = "tokinCartCancel";
const CART_RUNNING_TAB_KEY = "tokinCartRunningTab";
let ensuring = null;

// Frena toda la automatización de carrito por interrupción del sistema
// (pestaña cerrada, sesión cerrada): marca cancelado con motivo "stop" (el
// content script aborta en su siguiente chequeo sin marcar "canceled") y avisa
// al offscreen para que vuelva al paso de líneas capturadas (la tarea no
// terminó con confirmación del usuario).
function stopRunningCart() {
  chrome.storage.local.set({ [CART_CANCEL_KEY]: "stop" }, () => { void chrome.runtime.lastError; });
  try {
    chrome.runtime.sendMessage({ target: "offscreen", type: "CART_STOP" }, () => { void chrome.runtime.lastError; });
  } catch (e) {}
}

// Si la pestaña que corría el lote se cierra, la tarea se detiene.
chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.local.get([CART_RUNNING_TAB_KEY], (d) => {
    if (d && d[CART_RUNNING_TAB_KEY] === tabId) {
      stopRunningCart();
      chrome.storage.local.remove(CART_RUNNING_TAB_KEY, () => { void chrome.runtime.lastError; });
    }
  });
});

// Si la sesión se cierra (navegación a /store/login) durante un lote, se detiene.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  const url = String(changeInfo.url || "");
  if (url.indexOf("/store/login") === -1) return;
  chrome.storage.local.get([CART_RUNNING_TAB_KEY], (d) => {
    if (d && d[CART_RUNNING_TAB_KEY] === tabId) stopRunningCart();
  });
});

// Cuando el job desaparece (terminó/canceló/abortó), se deja de rastrear la pestaña.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[CART_JOB_KEY] && !changes[CART_JOB_KEY].newValue) {
    chrome.storage.local.remove(CART_RUNNING_TAB_KEY, () => { void chrome.runtime.lastError; });
  }
});

function tokMainBridge() {
  try {
    if (window.__TOKIN_AUTOPEDIDO__) return;
    window.__TOKIN_RES__ = null;
    window.addEventListener("message", function (ev) {
      var d = ev.data;
      if (!d || d.__tok !== "cart-res") return;
      window.__TOKIN_RES__ = d.payload || {};
    });
    window.__TOKIN_AUTOPEDIDO__ = {
      startCart: function (items) {
        window.__TOKIN_RES__ = null;
        window.postMessage({ __tok: "cart-req", payload: { probe: "start", items: items } }, "*");
        return { ok: true, dispatched: true };
      },
      cartJob: function () {
        return new Promise(function (resolve) {
          function h(ev) {
            var d = ev.data;
            if (!d || d.__tok !== "cart-res") return;
            window.removeEventListener("message", h);
            resolve(d.payload);
          }
          window.addEventListener("message", h);
          window.postMessage({ __tok: "cart-req", payload: { probe: "cartJob" } }, "*");
        });
      },
    };
  } catch (e) {}
}

async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] });
  if (contexts.length) return { ok: true };
  await chrome.offscreen.createDocument({
    url: OFFLINE_URL,
    reasons: [chrome.offscreen.Reason.WORKERS, chrome.offscreen.Reason.AUDIO_PLAYBACK],
    justification:
      "Procesa el pedido (OCR del PDF) en segundo plano mientras el popup está cerrado y avisa con un sonido al finalizar.",
  });
  return { ok: true };
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(["tokin_installed_v2"], (data) => {
    if (!data.tokin_installed_v2) {
      chrome.storage.local.set({ tokin_installed_v2: chrome.runtime.getManifest().version }, () => { void chrome.runtime.lastError; });
    }
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.target === "sw") {
    if (msg.type === "HEARTBEAT") {
      sendResponse({ ok: true });
      return true;
    }
    if (msg.type === "ENSURE_OFFSCREEN") {
      ensuring = ensuring || ensureOffscreen().finally(() => { ensuring = null; });
      ensuring.then((r) => sendResponse(r)).catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
      return true;
    }
    if (msg.type === "GET_STATE") {
      chrome.storage.session.get("tokin_session", (data) => {
        sendResponse({ ok: true, state: data["tokin_session"] || null });
      });
      return true;
    }
    if (msg.type === "PERSIST" && msg.state) {
      chrome.storage.session.set({ tokin_session: msg.state }, () => {
        sendResponse({ ok: true });
      });
      return true;
    }
    if (msg.type === "CLEAR_PERSIST") {
      chrome.storage.session.remove("tokin_session", () => {
        sendResponse({ ok: true });
      });
      return true;
    }
    if (msg.type === "ADD_TO_CART") {
      chrome.tabs.query({}, (tabs) => {
        const store = tabs.find(
          (t) => t.id && t.url && t.url.indexOf("tokintienda.com.ar/store") !== -1
        );
        if (!store || !store.id) {
          sendResponse({ ok: false, message: "Abrí la pestaña del store para cargar el carrito." });
          return;
        }
        chrome.storage.local.set({ [CART_RUNNING_TAB_KEY]: store.id }, () => { void chrome.runtime.lastError; });
        chrome.tabs.sendMessage(store.id, { type: "ADD_TO_CART", tabId: store.id, items: msg.items || [], filename: msg.filename || "" }, (res) => {
          if (chrome.runtime.lastError) {
            sendResponse({ ok: false, message: chrome.runtime.lastError.message });
          } else {
            sendResponse({ ok: true, ...(res || {}) });
          }
        });
      });
      return true;
    }
    if (msg.type === "CANCEL_CART") {
      chrome.storage.local.set({ tokinCartCancel: "user" }, () => { void chrome.runtime.lastError; });
      chrome.tabs.query({}, (tabs) => {
        const store = tabs.find(
          (t) => t.id && t.url && t.url.indexOf("tokintienda.com.ar/store") !== -1
        );
        if (store && store.id) {
          try {
            chrome.tabs.sendMessage(store.id, { type: "CANCEL_CART" }, () => { void chrome.runtime.lastError; });
          } catch (e) {}
        }
        sendResponse({ ok: true });
      });
      return true;
    }
    if (msg.type === "CLOSE_OFFSCREEN") {
      chrome.offscreen.closeDocument(() => sendResponse({ ok: true }));
      return true;
    }
  }
  if (msg && msg.type === "INJECT_MAIN_BRIDGE") {
    const tabId = (sender && sender.tab && sender.tab.id) || msg.tabId;
    if (tabId) {
      try {
        chrome.scripting
          .executeScript({ target: { tabId }, world: "MAIN", func: tokMainBridge })
          .catch(() => {});
      } catch (e) {}
    }
    sendResponse({ ok: true });
    return true;
  }
  if (msg && msg.type === "GET_MANIFEST") {
    sendResponse({ ok: true, version: chrome.runtime.getManifest().version });
    return true;
  }
  if (msg && msg.type === "GET_TAB_ID") {
    sendResponse({ ok: true, tabId: sender && sender.tab ? sender.tab.id : null });
    return true;
  }
  return false;
});
