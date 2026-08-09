// Tokin AutoPedido - documento offscreen (MV3)
// Mantiene la sesión del pedido viva en segundo plano mientras el popup está
// cerrado. Aquí corre el OCR (parseDocument) y la carga al carrito. El popup
// solo muestra; este documento guarda estado en chrome.storage.session y
// transmite progreso al popup cuando está abierto.
//
// Chrome cierra un offscreen tras ~30s de inactividad: se envía un heartbeat
// al service worker cada 20s y se escribe progreso en storage.session, que
// cuenta como actividad para mantener el documento vivo.

import { parseDocument, summarize } from "../core/agent.js";

// pdf.js programa el render de cada página con requestAnimationFrame, que NUNCA
// se dispara en un documento offscreen (no recibe frames) y cuelga el OCR.
// Se reemplaza por setTimeout para que el render avance.
if (typeof window !== "undefined") {
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 16);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
}

const state = {
  status: "idle", // idle|parsing|parsed|loading_cart|done|canceled|error
  step: 1,
  progress: "",
  filename: "",
  error: "",
  doc: null,
  summary: null,
  line_items: [],
  cart: null,
  cartProgress: null,
  cancelRequested: false,
  cancellingCart: false,
};

function sessionView() {
  return {
    status: state.status,
    step: state.step,
    progress: state.progress,
    filename: state.filename,
    error: state.error,
    summary: state.summary,
    line_items: state.line_items,
    cart: state.cart,
    cartProgress: state.cartProgress,
  };
}

// Un sendMessage con callback vacío sin leer chrome.runtime.lastError dispara
// "Unchecked runtime.lastError: The message port closed before a response was
// received." cuando el popup está cerrado o el service worker se suspende.
// Este helper consume el lastError para silenciar el aviso.
function safeSend(msg) {
  try {
    chrome.runtime.sendMessage(msg, () => { void chrome.runtime.lastError; });
  } catch (e) {}
}

// El offscreen no expone chrome.storage: la persistencia la hace el service
// worker (que sí tiene storage). La fuente viva de la sesión es este estado.
function persist() {
  safeSend({ target: "sw", type: "PERSIST", state: sessionView() });
}

function emitState() {
  safeSend({ target: "popup", type: "STATE", state: sessionView() });
}

function setStatus(status, progress, step) {
  state.status = status;
  if (progress !== undefined) state.progress = progress;
  if (step) state.step = step;
  state.error = status === "error" ? state.error : "";
  persist();
  emitState();
}

function resetState() {
  state.status = "idle";
  state.step = 1;
  state.progress = "";
  state.filename = "";
  state.error = "";
  state.doc = null;
  state.summary = null;
  state.line_items = [];
  state.cart = null;
  state.cartProgress = null;
  state.cancelRequested = false;
  state.cancellingCart = false;
}

// Los mensajes de chrome.runtime se serializan como JSON: los binarios deben
// viajar como base64 (un Uint8Array llegaría como objeto plano).
function b64ToBytes(b64) {
  const bin = atob(String(b64 || ""));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// El offscreen solo expone chrome.runtime (sin chrome.tabs ni chrome.storage):
// el carrito y la persistencia los resuelve el service worker.
function sendSw(msg) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ ...msg, target: "sw" }, (res) => {
        if (chrome.runtime.lastError) resolve({ ok: false, message: chrome.runtime.lastError.message });
        else resolve(res || { ok: false, message: "Sin respuesta" });
      });
    } catch (e) {
      resolve({ ok: false, message: String(e) });
    }
  });
}

// ------------------------------------------------------------------ parse

function summarizeMsg(doc) {
  const kv = (doc.kv_pairs || []).length;
  const items = (doc.line_items || []).length;
  const base = kv + " dato(s) · " + items + " línea(s) de pedido.";
  return (doc.error ? "Con advertencias: " + doc.error + " · " : "") + base;
}

async function runParse(filename, data) {
  // Entrar un documento nuevo frena cualquier automatización de carrito que
  // haya quedado corriendo de una tarea anterior.
  if (state.status === "loading_cart") {
    sendSw({ type: "CANCEL_CART" });
    state.cart = null;
    state.cartProgress = null;
  }
  state.cancelRequested = false;
  state.filename = filename;
  state.error = "";
  setStatus("parsing", "Enviando archivo…", 1);
  let lastPersist = 0;
  try {
    const doc = await parseDocument(
      filename,
      data,
      (msg) => {
        state.progress = msg;
        const now = Date.now();
        if (now - lastPersist > 1500) {
          lastPersist = now;
          persist();
        }
        try {
          safeSend({ target: "popup", type: "PROGRESS", message: msg });
        } catch (e) {}
      },
      () => state.cancelRequested
    );
    state.doc = doc;
    state.line_items = doc.line_items || [];
    state.summary = summarize(doc);
    state.error = doc.error || "";
    setStatus("parsed", summarizeMsg(doc), 2);
    playBeep(!doc.error);
  } catch (e) {
    if (e && e.name === "CancelError") {
      setStatus("canceled", "Proceso cancelado.", 1);
    } else {
      state.error = String((e && e.message) || e);
      setStatus("error", state.error, 1);
    }
  } finally {
    state.cancelRequested = false;
  }
}

// ---------------------------------------------------------------- carrito

function cartItems() {
  return (state.line_items || [])
    .map((it) => ({
      producto: it.producto || "",
      cantidad: it.cantidad || "",
      unidad: it.unidad || "",
      categoria: it.categoria || "",
      sku: it.sku || "",
    }))
    .filter((it) => (it.producto || it.sku || "").trim());
}

async function runCart() {
  state.cancellingCart = false;
  const items = cartItems();
  if (!items.length) {
    setStatus("error", "No hay líneas de pedido para cargar.", 2);
    return;
  }
  setStatus("loading_cart", "Cargando carrito (" + items.length + " líneas)…", 3);
  state.cart = { total: items.length, ok: 0, results: [] };
  state.cartProgress = null;
  state.cartCanceled = false;
  persist();
  try {
    // El content script corre un lote resumible (navega por cada búsqueda) y va
    // reportando CART_PROGRESS; al terminar envía CART_DONE, que aplica el estado.
    const out = await sendSw({ type: "ADD_TO_CART", items });
    if (!out || !out.ok) throw new Error((out && out.message) || "El store no respondió.");
  } catch (e) {
    if (state.cancellingCart) {
      setStatus("canceled", "Carga del carrito cancelada.", 3);
    } else {
      state.error = String((e && e.message) || e);
      setStatus("error", state.error, 3);
    }
  } finally {
    state.cancellingCart = false;
  }
}

function applyCartDone(msg) {
  // Si ya se ingresó otro documento mientras corría el lote, el resultado
  // viejo NO pisa la sesión nueva.
  if (state.status !== "loading_cart") return;
  if (!msg || !msg.canceled) {
    const results = (msg && msg.results) || [];
    state.cart = {
      total: (msg && msg.total) || results.length,
      ok: results.filter((r) => r.ok).length,
      results,
    };
    // Las líneas que NO se agregaron al carrito quedan en las filas para
    // corregir y reintentar; solo se quitan las confirmadas (message empieza
    // con "agregado"), porque reenviarlas las duplicaría. Quedan las falladas,
    // las "sin stock" y las "no se confirmó". Los resultados llegan en el mismo
    // orden que cartItems() (líneas no vacías).
    const all = state.line_items || [];
    const pending = [];
    let idx = 0;
    for (const it of all) {
      if (!(it.producto || it.sku || "").trim()) {
        pending.push(it);
        continue;
      }
      const r = results[idx];
      idx++;
      const added = !!(r && r.ok && String(r.message || "").indexOf("agregado") === 0);
      if (!added) pending.push(it);
    }
    state.line_items = pending;
    setStatus(
      "done",
      "Pedido cargado en el carrito: " + state.cart.ok + " de " + state.cart.total + "." +
        (pending.length ? " Quedaron " + pending.length + " líneas para revisar." : ""),
      4
    );
    playBeep(true);
  } else {
    const results = (msg && msg.results) || [];
    state.cart = {
      total: (msg && msg.total) || results.length,
      ok: results.filter((r) => r.ok).length,
      results,
    };
    setStatus("canceled", "Carga del carrito cancelada.", 3);
  }
}

function cancelCart() {
  state.cancellingCart = true;
  setStatus("loading_cart", "Cancelando carga del carrito…", 3);
  sendSw({ type: "CANCEL_CART" });
}

// ---------------------------------------------------------------- sonido

function playBeep(ok) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
    if (ctx.state === "suspended") ctx.resume();
    const notes = ok ? [880, 1174.7] : [440, 330];
    let t = ctx.currentTime + 0.05;
    for (const f of notes) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = f;
      osc.connect(gain);
      gain.connect(ctx.destination);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.22);
      osc.start(t);
      osc.stop(t + 0.24);
      t += 0.26;
    }
    setTimeout(() => {
      try { ctx.close(); } catch (e) {}
    }, t + 200);
  } catch (e) {}
}

// ------------------------------------------------------------ debug

async function debugPdfOpen(b64) {
  const data = b64ToBytes(b64);
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
  const pdf = await pdfjs.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const tc = await page.getTextContent();
  return { pages: pdf.numPages, page1Items: tc.items.length };
}

async function debugOcrWorker() {
  const steps = [];
  if (!window.Tesseract) return { error: "no Tesseract", steps };
  const base = chrome.runtime.getURL("lib/tesseract/");
  let worker = null;
  try {
    steps.push("createWorker");
    worker = await window.Tesseract.createWorker({
      workerBlobURL: false,
      workerPath: base + "worker.min.js",
      corePath: base + "tesseract-core.wasm.js",
      langPath: base + "lang/",
      logger: () => {},
    });
    steps.push("created");
    steps.push("loadLanguage");
    await worker.loadLanguage("spa");
    steps.push("language_ok");
    steps.push("initialize");
    await worker.initialize("spa");
    steps.push("init_ok");
  } catch (e) {
    return { steps, error: String((e && e.stack) || e) };
  } finally {
    if (worker) { try { await worker.terminate(); } catch (e) {} }
  }
  return { steps };
}

async function debugParse(filename, data) {
  const milestones = [];
  const doc = await parseDocument(
    filename,
    data,
    (msg) => {
      milestones.push(msg);
      if (milestones.length > 60) throw new Error("demasiados milestones");
    },
    () => false
  );
  return {
    milestones,
    kv: (doc.kv_pairs || []).length,
    items: (doc.line_items || []).length,
  };
}

async function debugRender(b64) {
  const data = b64ToBytes(b64);
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
  const pdf = await pdfjs.getDocument({ data }).promise;
  const page = await pdf.getPage(1);
  const vp = page.getViewport({ scale: 2 });
  const canvas = document.createElement("canvas");
  canvas.width = vp.width;
  canvas.height = vp.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
  return { w: canvas.width, h: canvas.height };
}

async function debugRaf() {
  const out = { hasRaf: typeof requestAnimationFrame === "function" };
  if (!out.hasRaf) return out;
  let fired = 0;
  const end = new Promise((res) => {
    const raf = (t) => {
      fired++;
      if (fired < 3) requestAnimationFrame(raf);
      else res();
    };
    requestAnimationFrame(raf);
    setTimeout(() => res(), 1500);
  });
  await end;
  return { ...out, firedIn1_5s: fired };
}

async function debugRecognize() {
  const steps = [];
  if (!window.Tesseract) return { error: "no Tesseract", steps };
  const base = chrome.runtime.getURL("lib/tesseract/");
  let worker = null;
  try {
    steps.push("createWorker");
    worker = await window.Tesseract.createWorker({
      workerBlobURL: false,
      workerPath: base + "worker.min.js",
      corePath: base + "tesseract-core.wasm.js",
      langPath: base + "lang/",
      logger: () => {},
    });
    steps.push("created");
    await worker.loadLanguage("spa");
    steps.push("language_ok");
    await worker.initialize("spa");
    steps.push("init_ok");
    const canvas = document.createElement("canvas");
    canvas.width = 160;
    canvas.height = 40;
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, 160, 40);
    g.fillStyle = "#000";
    g.font = "18px sans-serif";
    g.fillText("hola 123", 8, 28);
    steps.push("recognize");
    const { data: d } = await worker.recognize(canvas);
    steps.push("recognized");
    return { steps, len: (d.text || "").length, conf: Math.round(d.confidence || 0) };
  } catch (e) {
    return { steps, error: String((e && e.stack) || e) };
  } finally {
    if (worker) { try { await worker.terminate(); } catch (e) {} }
  }
}

// --------------------------------------------------------- mensajes y vida

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return false;
  switch (msg.type) {
    case "PARSE":
      runParse(msg.filename || "archivo", b64ToBytes(msg.b64))
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
      return true;
    case "CANCEL":
      if (state.status === "loading_cart") {
        cancelCart();
      } else {
        state.cancelRequested = true;
      }
      sendResponse({ ok: true });
      break;
    case "ADD_TO_CART":
      runCart()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
      return true;
    case "UPDATE_LINE_ITEMS":
      // El popup permitió editar las filas (doble clic): se persisten los
      // cambios en la sesión para que la carga al carrito use los valores
      // corregidos por el usuario.
      if (Array.isArray(msg.items) && state.status !== "loading_cart") {
        state.line_items = msg.items;
        persist();
        emitState();
      }
      sendResponse({ ok: true });
      break;
    case "GET_STATE":
      sendResponse({ ok: true, state: sessionView() });
      break;
    case "CART_PROGRESS":
      if (state.status === "loading_cart" || msg.message) {
        state.progress = msg.message || state.progress;
        if (typeof msg.index === "number") {
          state.cartProgress = { index: msg.index, total: msg.total, ok: !!msg.ok };
        }
        persist();
        emitState();
      }
      sendResponse({ ok: true });
      break;
    case "CART_STOP":
      // El lote quedó huérfano (pestaña o sesión cerrada): vuelve al paso de
      // líneas capturadas. La tarea no terminó con confirmación del usuario,
      // así que NO se marca "canceled" y NO se limpia la sesión.
      if (state.status === "loading_cart") {
        state.cart = null;
        state.cartProgress = null;
        state.cartCanceled = false;
        setStatus("idle", "", 1);
        persist();
        emitState();
      }
      sendResponse({ ok: true });
      break;
    case "CART_DONE":
      applyCartDone(msg);
      persist();
      emitState();
      sendResponse({ ok: true });
      break;
    case "CLEAR":
      resetState();
      sendSw({ type: "CLEAR_PERSIST" });
      emitState();
      sendResponse({ ok: true });
      setTimeout(() => {
        sendSw({ type: "CLOSE_OFFSCREEN" });
      }, 400);
      break;
    case "DEBUG_PDF":
      debugPdfOpen(msg.b64)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
      return true;
    case "DEBUG_OCR":
      debugOcrWorker()
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
      return true;
    case "DEBUG_PARSE":
      debugParse(msg.filename || "debug.pdf", b64ToBytes(msg.b64))
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
      return true;
    case "DEBUG_RAF":
      debugRaf()
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
      return true;
    case "DEBUG_RENDER":
      debugRender(msg.b64)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
      return true;
    case "DEBUG_RECOGNIZE":
      debugRecognize()
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
      return true;
    default:
      sendResponse({ ok: false, message: "Tipo de mensaje desconocido" });
  }
  return false;
});

// Mantener el documento vivo: Chrome cierra un offscreen tras ~30s sin
// actividad. Un sendMessage al service worker cada 20s cuenta como actividad.
setInterval(() => {
  safeSend({ target: "sw", type: "HEARTBEAT" });
}, 20000);

// Al recrear el offscreen (Chrome lo cierra y se vuelve a abrir) se restaura la
// sesión previa: el formulario queda en el paso donde estaba. Un lote a medias
// no se resume: si la sesión persistida quedó "cargando", vuelve a "idle"
// (las líneas capturadas quedan y "Enviar a carrito" queda disponible).
function restoreSession() {
  sendSw({ type: "GET_STATE" }).then((res) => {
    try {
      const s = (res && res.ok && res.state) || null;
      if (!s) return;
      if (s.status === "loading_cart") {
        state.status = "idle";
        state.step = 1;
        state.progress = "";
        state.cart = null;
        state.cartProgress = null;
      } else {
        state.status = s.status || "idle";
        state.step = s.step || 1;
        state.progress = s.progress || "";
        state.filename = s.filename || "";
        state.error = s.error || "";
        state.summary = s.summary || null;
        state.line_items = Array.isArray(s.line_items) ? s.line_items : [];
        state.cart = s.cart || null;
        state.cartProgress = s.cartProgress || null;
      }
      persist();
      emitState();
    } catch (e) {}
  });
}
restoreSession();

// Hook de depuracion para tests automatizados (solo con ?debug=1).
if (new URLSearchParams(location.search).get("debug") === "1") {
  window.__OFFDEBUG__ = {
    env: () => ({
      Tesseract: !!window.Tesseract,
      pdfjsLib: !!window.pdfjsLib,
      XLSX: !!window.XLSX,
      mammoth: !!window.mammoth,
      chrome: typeof chrome !== "undefined",
    }),
    pdfOpen: debugPdfOpen,
    ocrWorker: debugOcrWorker,
    parse: debugParse,
  };
}
