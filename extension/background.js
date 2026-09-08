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

// ------------------------------------------------------------- watchdog (v2.0.27)
// Recuperación AUTÓNOMA del lote tras un corte de señal, sin que el usuario
// refresque nada. El service worker se despierta dos veces por minuto y:
//   1. Si no hay job vivo, no hace nada.
//   2. Le pega un PING al content script de la pestaña del lote.
//   3. Si responde: el content script gestiona su propia recuperación
//      (watchdog interno + reintento del evento online). Nada que hacer.
//   4. Si NO responde, es que la pestaña está muerta para la extensión:
//      página de error de Chrome (se cortó la señal justo al navegar), renderer
//      colgado o pestaña descartada por el ahorro de memoria. En ese caso,
//      cuando HAY señal de verdad (fetch HEAD desde el SW), se RECARGA la
//      pestaña: al bootear, resumeCart() encuentra el job y continúa donde
//      quedó (el lote está diseñado para sobrevivir navegaciones).
const TOK_STORE_URL = "https://tokintienda.com.ar/store";
const TOK_JOB_MAX_MS = 60 * 60 * 1000;   // vida máxima del job (igual que content)
const TOK_PAUSE_MAX_MS = 30 * 60 * 1000; // pausa auto-reanudable (igual que content)

try {
  chrome.alarms.create("tokin-watchdog", { periodInMinutes: 0.5 });
} catch (e) {}

function tokSwNetOk() {
  return new Promise((resolve) => {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 8000);
      fetch(TOK_STORE_URL, { method: "HEAD", mode: "no-cors", cache: "no-store", signal: ctrl.signal })
        .then(() => { clearTimeout(t); resolve(true); })
        .catch(() => { clearTimeout(t); resolve(false); });
    } catch (e) { resolve(false); }
  });
}

function tokPingTab(tabId) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (!done) { done = true; resolve(v); }
    };
    // Si el renderer está colgado (no muerto) el callback puede no llegar
    // nunca: timeout corto y se considera pestaña irrecuperable.
    const t = setTimeout(() => finish(false), 4000);
    try {
      chrome.tabs.sendMessage(tabId, { type: "TOKIN_PING" }, (res) => {
        clearTimeout(t);
        void chrome.runtime.lastError;
        finish(!!(res && res.ok));
      });
    } catch (e) { clearTimeout(t); finish(false); }
  });
}

function tokStoreGetAsync(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get(key, (d) => resolve(d || {}));
    } catch (e) { resolve({}); }
  });
}

// El job todavía merece recuperación automática: no vencido y, si está en
// pausa, dentro de la ventana de auto-reanudación.
async function tokJobRecoverable() {
  const d = await tokStoreGetAsync(CART_JOB_KEY);
  const job = d[CART_JOB_KEY];
  if (!job || job.phase === "done") return false;
  if (job.started && Date.now() - job.started > TOK_JOB_MAX_MS) return false;
  if (job.phase === "paused" && job.pausedAt && Date.now() - job.pausedAt > TOK_PAUSE_MAX_MS) return false;
  return true;
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== "tokin-watchdog") return;
  (async () => {
    if (!(await tokJobRecoverable())) return;
    const d = await tokStoreGetAsync(CART_RUNNING_TAB_KEY);
    const tabId = d[CART_RUNNING_TAB_KEY];
    if (!tabId) return;
    let tab = null;
    try { tab = await chrome.tabs.get(tabId); } catch (e) {}
    if (!tab) {
      // La pestaña del lote ya no existe: frenar limpio (red de seguridad por
      // si el evento onRemoved no alcanzó a correr).
      stopRunningCart();
      return;
    }
    if (await tokPingTab(tabId)) return; // viva: se recupera sola en la página
    // Pestaña sin content script. Solo recargar si hay red REAL ahora mismo y
    // el job sigue vivo (podría haber cambiado durante el ping).
    if (!(await tokSwNetOk())) return;
    if (!(await tokJobRecoverable())) return;
    try {
      chrome.tabs.reload(tabId, {}, () => { void chrome.runtime.lastError; });
    } catch (e) {}
  })().catch(() => {});
});

// La pestaña del lote terminó de cargar (recarga manual, vuelta de una página
// de error, SPA remontada): darle un nudge al content script para que retome
// el job enseguida, sin esperar el próximo tick del watchdog.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== "complete") return;
  chrome.storage.local.get(CART_RUNNING_TAB_KEY, (d) => {
    if (!d || d[CART_RUNNING_TAB_KEY] !== tabId) return;
    try {
      chrome.tabs.sendMessage(tabId, { type: "TOKIN_RESUME_NUDGE" }, () => { void chrome.runtime.lastError; });
    } catch (e) {}
  });
});

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
            const errMsg = chrome.runtime.lastError.message || "";
            if (errMsg.indexOf("Receiving end does not exist") !== -1 || errMsg.indexOf("Could not establish connection") !== -1) {
              sendResponse({ ok: false, message: "Presioná F5 en la pestaña del store y volvé a intentar." });
            } else {
              sendResponse({ ok: false, message: errMsg });
            }
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
