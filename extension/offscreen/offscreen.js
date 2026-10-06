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
  status: "idle", // idle|parsing|parsed|loading_cart|block_done|done|canceled|error
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
  // v2.0.55: estado del carrito por BLOQUES de 19 líneas ("parada"). El pedido
  // completo se guarda acá (origItems, una copia fiel del orden original) con
  // un resultado por línea original (results, alineado por índice). Cada
  // «Enviar 19 a carrito» manda el próximo bloque nunca intentado; al terminar
  // se rearma la vista con lo que falta (no confirmadas + no intentadas).
  // batchIdx = índices originales de las líneas del bloque en vuelo, para que
  // CART_DONE matchee resultados contra las líneas correctas aunque el
  // offscreen se haya recreado a mitad de lote.
  cartApi: null,
  // v2.0.75: lotes cuya COMPRA se confirmó de verdad (checkout completo: el
  // carrito quedó vacío / pantalla de éxito). Solo esos pueden decir
  // «pedido realizado» en la UI y en el Excel. Clave = número de lote.
  lotChecks: {},
  // v2.0.82: tanda de ajustes manuales en vuelo. Las líneas corregidas a mano
  // se reprocesan con su propio número de tanda ("A1", "A2"…) para que el
  // checkout NO se saltee por el guardia de lote ya confirmado (los lotes
  // numéricos del pedido ya están comprados y nunca deben volver a comprarse).
  cartIsManual: false,
  manualRun: 0,
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
    cartApi: state.cartApi,
    lotChecks: state.lotChecks,
    // v2.0.82: memoria de grupos con la foto del carrito previa a cada
    // checkout (carrito vacío => "no verificable", nunca inventado).
    grupos: (state.cartApi && state.cartApi.grupos) || {},
    cartIsManual: state.cartIsManual,
    manualRun: state.manualRun,
    // v2.0.96: el lote cuyo checkout está en vuelo. Sin esto, si Chrome recrea
    // este documento a mitad del lote (o se reinicia), el checkout perdedor se
    // quedaba esperando un CHECKOUT_DONE que quizá nunca llegaba, el temporizador
    // de seguridad se perdía con el documento y el primer envío NUNCA terminaba:
    // la tarea quedaba clavada en «cargando carrito» sin error. Además, el
    // CHECKOUT_DONE que llegara tarde tomaba lote=1 por defecto y marcaba como
    // confirmado un lote que no era.
    checkoutLote: state.checkoutLote || 0,
  };
}

// v2.0.96: red de seguridad del checkout de un lote. Si el content script no
// confirma en ~3 min (página caída, botones distintos, extensión descargada a
// medio camino), se continúa igual y no se clava el flujo. Es idempotente: la
// vuelve a armar el offscreen al recrearse, con el lote que tenía en vuelo.
function armCheckoutTimer() {
  clearTimeout(state.checkoutTimer || 0);
  state.checkoutTimer = 0;
  if (!state.checkoutLote) return;
  const loteT = state.checkoutLote;
  state.checkoutTimer = setTimeout(function () {
    if (state.checkoutLote !== loteT) return;
    state.checkoutLote = 0;
    continueAfterCheckout(loteT, "checkout sin confirmación — continuando", true);
  }, 180000);
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
  // v2.0.86: mientras hay trabajo largo (parseo/OCR y carga al carrito, que
  // pueden tardar minutos SIN mensajes hacia este documento) se toma un Web
  // Lock: Chrome no auto-cierra un documento offscreen que tiene un lock
  // activo, y eso evita el corte a mitad de lote. Reemplaza al oscilador de
  // 60 Hz de la v2.0.60, que ademas de gastar CPU era audible en algunos
  // equipos. El beep de aviso de fin de lote se mantiene (playBeep).
  if (status === "parsing" || status === "loading_cart" || status === "paused") startKeepAlive();
  else stopKeepAlive();
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
  state.cartApi = null;
  state.lotChecks = {};
  state.cartIsManual = false;
  state.manualRun = 0;
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
    // v2.0.56: cada línea guarda el número de fila de la INGESTA original
    // (nro), para que la vista mantenga la numeración aunque las filas se
    // vayan quitando por bloques de 19 al cargar al carrito.
    state.line_items = (doc.line_items || []).map((it, i) =>
      Object.assign({}, it, { nro: i + 1 })
    );
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
      // v2.0.69: preservar el nro de ingesta también en el job del carrito,
      // así la vista del popup (y su encabezado «Bloque N — líneas X a Y»)
      // sigue al bloque real aunque se reconstruya desde el job persistido.
      nro: it.nro,
      producto: it.producto || "",
      cantidad: it.cantidad || "",
      unidad: it.unidad || "",
      categoria: it.categoria || "",
      sku: it.sku || "",
      // v2.0.84: "1 unidad" no existe en el pedido: el parser marca la línea y,
      // si el re-OCR no la corrigió, el content script bloquea la carga. El flag
      // tiene que viajar al job o el bloqueo nunca se aplica.
      unidadSospechosa: it.unidadSospechosa === true,
      // v2.0.84: los factores de pack declarados en el encabezado del pedido
      // ("1 Bulto = 24 Unidad(s)") llegaban hasta acá pero se perdían en este
      // whitelist: el content script los usa como fuente de conversión y caía
      // siempre al pack del título, que es menos confiable.
      pack_factors: it.pack_factors || null,
    }))
    .filter((it) => (it.producto || it.sku || "").trim());
}

// v2.0.55: el pedido se carga al carrito EN BLOQUES de 19 líneas por parada.
// Un solo botón «Enviar 19 a carrito» manda el próximo bloque; cuando ese
// bloque termina se entrega el reporte parcial y se espera al usuario.
const CART_BLOCK = 19;

async function runCart() {
  state.cancellingCart = false;
  const view = (state.line_items || []).filter((it) => (it.producto || it.sku || "").trim());
  if (!state.cartApi || !state.cartApi.started) {
    // Primer bloque de la tanda: snapshot del pedido completo (orden original).
    if (!view.length) {
      setStatus("error", "No hay líneas de pedido para cargar.", 2);
      return;
    }
    state.cartApi = {
      started: true,
      // v2.0.69: el nro de INGESTA sale siempre (original + 1): sin él el popup
      // no sabe qué lote está en proceso y títula todo como «Bloque 1».
      origItems: view.map((it, i) => Object.assign({}, it, { nro: i + 1 })),
      idxOfView: view.map((_, i) => i),
      results: [],
      nextOrig: 0,
      orderTotal: view.length,
      batchIdx: [],
      // v2.0.82: memoria de GRUPOS. Cada grupo es un momento de compra: los
      // lotes del pedido ("1".."N") y las tandas de ajustes manuales ("A1".."An").
      // Guardamos la foto del carrito en el instante previo al checkout de cada
      // grupo (es el único momento en que se puede responder qué había cargado) y
      // si la compra quedó confirmada de verdad.
      grupos: {},
    };
  } else {
    // Entre bloques el usuario pudo editar filas pendientes (UPDATE_LINE_ITEMS):
    // refrescar en origItems las líneas que todavía no se intentaron o fallaron.
    const idx = state.cartApi.idxOfView || [];
    for (let k = 0; k < view.length && k < idx.length; k++) {
      const oi = idx[k];
      if (oi == null || oi >= state.cartApi.origItems.length) continue;
      state.cartApi.origItems[oi] = Object.assign({}, state.cartApi.origItems[oi], view[k]);
    }
  }
  // v2.0.82: COLA DE AJUSTES MANUALES. Cuando el cliente toca «Enviar al
  // carrito» sobre las filas de "Requiere revisión manual", el offscreen arma
  // una cola con los índices originales de las líneas que NO quedaron cargadas y
  // las reprocesa (con las cantidades/unidades que el cliente haya editado). El
  // snapshot del pedido (origItems/results/orderTotal) NO se toca, así que el
  // informe sigue mostrando el pedido completo y las líneas corregidas pisan su
  // resultado anterior en vez de duplicarse.
  const api = state.cartApi;
  const cola = api && Array.isArray(api.retryIdx) && api.retryIdx.length ? api.retryIdx : null;
  const finPedido = () => {
    const done = api.results.filter(Boolean);
    const added = done.filter((r) => !!(r && r.ok && String(r.message || "").indexOf("agregado") === 0)).length;
    const man = done.length - added;
    setStatus(
      "done",
      "Todas las líneas del pedido ya fueron procesadas (" + added + " de " + api.orderTotal + " en el carrito" +
        (man ? ", " + man + " para revisión manual" : "") + ").",
      4
    );
    playBeep(true);
  };
  if (api.nextOrig >= api.orderTotal && !cola) {
    // Sin líneas nuevas por intentar: todo el pedido ya se procesó.
    finPedido();
    return;
  }
  let batch = [];
  let batchIdx = [];
  let batchStartAbs = 0;
  if (cola) {
    // Tanda manual: solo las líneas en cola, aunque estén dispersas en el
    // pedido (no se reprocesa nada que ya haya quedado cargado).
    state.cartIsManual = true;
    const take = cola.slice(0, CART_BLOCK);
    batch = take.map((i) => api.origItems[i]).filter(Boolean);
    batchIdx = take.slice(0, batch.length);
    batchStartAbs = batchIdx.length ? batchIdx[0] : 0;
    api.retryIdx = cola.slice(batch.length);
  } else {
    state.cartIsManual = false;
    batch = api.origItems.slice(api.nextOrig, api.nextOrig + CART_BLOCK);
    if (!batch.length) {
      finPedido();
      return;
    }
    batchStartAbs = api.nextOrig;
    for (let i = 0; i < batch.length; i++) batchIdx.push(api.nextOrig + i);
    api.nextOrig += batch.length;
  }
  if (!batch.length) {
    finPedido();
    return;
  }
  state.cartApi.batchIdx = batchIdx;
  state.cartApi.batchItems = batch;
  state.cart = {
    total: state.cartApi.orderTotal,
    ok: 0,
    results: [],
    batchTotal: batch.length,
    batchStart: batchStartAbs,
    batchResults: [],
    batch: { ok: 0, total: batch.length, sinStock: 0, notFound: 0, notConfirmed: 0 },
    docName: state.filename || "",
  };
  state.cartProgress = null;
  state.cartCanceled = false;
  // Persistir ANTES de mandar el mensaje: si el offscreen se recrea a mitad del
  // lote, la sesión restaurada conoce el bloque (batchIdx) y al volver el
  // CART_DONE matchea los resultados a las líneas correctas.
  setStatus(
    "loading_cart",
    (state.cartIsManual ? "Cargando ajustes manuales" : "Cargando carrito") +
      " (bloque de " + batch.length + " líneas)…",
    3
  );
  try {
    // El content script corre un lote resumible por bloque (navega por cada
    // búsqueda) y reporta CART_PROGRESS; al terminar envía CART_DONE.
    // v2.0.60: junto al bloque se envían batchIdx / orderTotal / lastBatch para
    // que el content script persista su reporte con la identidad del bloque
    // (recuperable si este offscreen se cierra a mitad de lote).
    const lastBatch = state.cartApi.nextOrig >= state.cartApi.orderTotal;
    const out = await sendSw({
      type: "ADD_TO_CART", items: batch, filename: state.filename || "",
      batchIdx, orderTotal: state.cartApi.orderTotal, lastBatch,
      manual: state.cartIsManual,
    });
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

// v2.0.82: TANDA DE AJUSTES MANUALES. El popup manda las filas de «Requiere
// revisión manual» con las cantidades/unidades corregidas a mano (por su nro
// original). Se reprocesan SÓLO esas: las que ya quedaron cargadas no se tocan
// (no se duplican productos en el carrito) y su resultado en el informe se
// pisa con el de la corrección. El snapshot del pedido (origItems, results,
// orderTotal) se mantiene, así que el Excel y los lotes siguen describiendo el
// pedido completo.
async function startManualBatch(msg) {
  if (state.status === "loading_cart" || state.status === "paused") {
    return { ok: false, message: "Hay una carga en curso. Esperá a que termine." };
  }
  const api = state.cartApi;
  if (!api || !api.started || !Array.isArray(api.origItems) || !api.origItems.length) {
    return { ok: false, message: "Primero hay que procesar el pedido al carrito." };
  }
  const isAdded = (r) => !!(r && r.ok && String(r.message || "").indexOf("agregado") === 0);

  // 1) Aplicar los ajustes del popup sobre el snapshot original, por nro.
  const ajustes = Array.isArray(msg && msg.items) ? msg.items : [];
  let aplicados = 0;
  for (const a of ajustes) {
    const nro = parseInt(a && a.nro, 10);
    if (!(nro >= 1 && nro <= api.origItems.length)) continue;
    const it = api.origItems[nro - 1];
    if (!it) continue;
    if (a.cantidad != null && a.cantidad !== "") it.cantidad = a.cantidad;
    if (a.categoria != null && a.categoria !== "") it.categoria = a.categoria;
    else if (a.unidad != null && a.unidad !== "") it.unidad = a.unidad;
    if (a.producto != null && a.producto !== "") it.producto = a.producto;
    it.nro = nro;
    aplicados++;
  }

  // 2) Cola = índices originales PENDIENTES DE AJUSTE. Tiene que replicar el
  //    filtro del popup (esPendienteDeAjuste, popup.js). Antes acá solo se
  //    miraba si la línea estaba CARGADA, así que la tanda reencolaba también
  //    los SIN STOCK (un hecho del store: no hay stock que el cliente pueda
  //    corregir) y las líneas que ya pasaron por una tanda de ajustes, cuyo
  //    resultado es DEFINITIVO. Eso era justamente la re-búsqueda de un sin
  //    stock que ya había pasado, y contradecía la "ronda única" del popup.
  //    v2.0.90: el filtro de sin stock es por MENSAJE, para que quede afuera
  //    también el "encontrado pero sin stock" que no se pudo verificar entero.
  const esSinStock = (r) => !!(r && !isAdded(r) && /sin stock|por falta de stock/i.test(String(r.message || "")));
  const esAjusteDefinitivo = (r) => !!(r && r.manualRound);
  const esPendienteDeAjuste = (r) => !isAdded(r) && !esSinStock(r) && !esAjusteDefinitivo(r);
  const cola = [];
  let sinCodigo = 0;
  for (let i = 0; i < api.origItems.length; i++) {
    const r = api.results[i];
    if (r && !esPendienteDeAjuste(r)) continue;
    if (!(api.origItems[i] && api.origItems[i].sku || "").trim()) sinCodigo++;
    cola.push(i);
  }
  if (!cola.length) {
    return { ok: true, message: "No hay líneas pendientes de revisión manual." };
  }
  const descartadas = cola.filter((i) => !String((api.origItems[i] && api.origItems[i].sku) || "").trim());
  const colaReal = cola.filter((i) => String((api.origItems[i] && api.origItems[i].sku) || "").trim());
  if (!colaReal.length) {
    return {
      ok: false,
      message:
        "Las " + descartadas.length + " líneas pendientes no tienen código ARC, así que la extensión no las " +
        "puede cargar: cargalas a mano en el store (marcadas en la hoja «Requiere revisión manual» del Excel).",
    };
  }

  // 3) Limpiar el resultado SOLO de las que se van a reintentar: si el popup se
  //    abre durante la tanda, la vista de trabajo debe ser la lista de pendientes.
  //    Las sin código ARC NO se tocan: su resultado ("no se encontró" / "revisión
  //    manual") es la evidencia de que no hay match de código y tiene que seguir
  //    en el Excel final; borrarlo las haría desaparecer del reporte.
  for (const i of colaReal) api.results[i] = null;
  api.retryIdx = colaReal;
  state.manualRun = (state.manualRun || 0) + 1;
  state.cartIsManual = true;
  state.line_items = colaReal.map((i) => Object.assign({}, api.origItems[i], { nro: i + 1 }));
  state.cartApi.idxOfView = colaReal.slice();
  persist();
  emitState();
  runCart();
  return {
    ok: true,
    message:
      "Cargando " + colaReal.length + " ajuste(s) manual(es)" +
      (descartadas.length ? " · " + descartadas.length + " sin código ARC quedan para carga a mano" : "") + "…",
  };
}

function applyCartDone(msg) {
  if (state.status !== "loading_cart" && state.status !== "paused") return;
  const results = (msg && msg.results) || [];
  // "Agregado" = lo que REALMENTE quedó en el carrito (message empieza con
  // "agregado"). "sin stock" / "no se encontró" / "no se confirmó" no suman al
  // conteo de cargado (el informe refleja el carrito, no las líneas ok).
  const isAdded = (r) => !!(r && r.ok && String(r.message || "").indexOf("agregado") === 0);
  const SIN_STOCK_RE =
    /sin stock|por falta de stock|no alcanza para|solo tiene\s+\d+\s+(unidad|unidades|un|uds|display|displays|bulto|bultos)|stock max/i;
  // "En el carrito: N productos" por la IDENTIDAD del carrito (código ARC de la
  // card donde cayó cada línea), no por el texto: dos líneas en la misma card
  // son UN producto (SET). Caso real CUENCA: código 14800 en "SANDIA x500" y
  // "FRUTILLA x500" (error del proveedor) -> ambas en ARC-1014800.
  const prodKey = (r) => {
    const m = String(r.storeText || "").match(/ARC-?(\d+)/i);
    return m ? "c:" + m[1] : "t:" + String(r.producto || "").trim();
  };
  const api = state.cartApi;
  // v2.0.82: identidad del grupo que termina de cargarse. Los lotes del pedido
  // son "1".."N"; las tandas de ajustes manuales, "A1".."An".
  const grupo = state.cartIsManual
    ? "A" + Math.max(1, state.manualRun || 1)
    : String(Math.floor(((api && api.batchIdx && api.batchIdx[0]) || 0) / CART_BLOCK) + 1);
  if (api && api.started && Array.isArray(api.batchIdx)) {
    for (let k = 0; k < results.length; k++) {
      const oi = api.batchIdx[k];
      if (oi == null || oi < 0 || oi >= api.origItems.length) continue;
      const rr = results[k];
      if (rr && typeof rr === "object") {
        // En qué grupo se resolvió la línea y cuánta cantidad quedó realmente
        // en el carrito: el Excel responde con estos dos datos, sin recalcular.
        rr.grupo = grupo;
        rr.cantCargada = isAdded(rr) ? (Number(rr.added) || 0) : 0;
        // marcar el resultado si viene de una tanda de ajustes manuales, para
        // que el informe diga que esa línea se corrigió a mano (y con qué
        // número de tanda) en lugar de parecer cargada en la primera pasada.
        if (state.cartIsManual) rr.manualRound = state.manualRun || 1;
      }
      api.results[oi] = rr;
    }
  }
  if (!api || !api.started) return;
  // Vista de trabajo: quedan SOLO las líneas que todavía no se intentaron (sin
  // resultado). Las falladas (sin stock / no encontrado / no cargado) ya
  // quedaron reportadas en results y NO vuelven a la lista: los bloques avanzan
  // de corrido 1-19, 20-38 ... sin acumular fallidos en el lote.
  const kept = [];
  const keptIdx = [];
  for (let i = 0; i < api.origItems.length; i++) {
    if (!api.results[i]) {
      const it = api.origItems[i];
      // v2.0.57: forzar el número de INGESTA original en cada fila que queda en
      // la lista, para que el próximo bloque siga numerando desde la línea 20
      // y no reinicie en 1 aunque la fila haya viajado por copias/mensajes.
      it.nro = i + 1;
      kept.push(it);
      keptIdx.push(i);
    }
  }
  state.line_items = kept;
  state.cartApi.idxOfView = keptIdx;
  // Conteos acumulados de TODO el pedido (por línea original).
  const done = api.results.filter(Boolean);
  const added = done.filter(isAdded).length;
  const sinStock = done.filter((r) => !isAdded(r) && SIN_STOCK_RE.test(r.message || "")).length;
  const notFound = done.filter((r) => !isAdded(r) && /no se encontró/i.test(r.message || "")).length;
  const notConfirmed = done.filter((r) => !isAdded(r) && String(r.message || "").indexOf("no se confirmó") === 0).length;
  const prodAdded = new Set(done.filter(isAdded).map(prodKey)).size;
  // Resultados del bloque recién terminado (reporte parcial de la parada).
  const batchResults = [];
  for (const oi of api.batchIdx || []) {
    const r = api.results[oi];
    if (r) batchResults.push(r);
  }
  const batchAdded = batchResults.filter(isAdded).length;
  const batchSin = batchResults.filter((r) => !isAdded(r) && SIN_STOCK_RE.test(r.message || "")).length;
  const batchNotF = batchResults.filter((r) => !isAdded(r) && /no se encontró/i.test(r.message || "")).length;
  const batchNotC = batchResults.filter((r) => !isAdded(r) && String(r.message || "").indexOf("no se confirmó") === 0).length;
  const allAttempted = api.nextOrig >= api.orderTotal;
  state.allAttempted = allAttempted;
  // v2.0.82: FOTO DEL GRUPO en el instante previo al checkout. Se guarda tal cual
  // la leyó el content script del drawer del store. Si vino vacía, el reporte la
  // muestra como "carrito no verificable" en vez de suponer un estado.
  // Una tanda manual puede necesitar más de un checkout (se parte en bloques de
  // 19), así que el grupo se ACUMULA: mismo grupo, varias fotos en distintos
  // instantes, que es exactamente lo que pasó.
  api.grupos = api.grupos || {};
  const foto = Array.isArray(msg && msg.carrito) ? msg.carrito : [];
  const lineasGrupo = api.batchIdx.map((oi) => {
    const r = api.results[oi];
    return {
      nro: oi + 1,
      sku: (r && (r.sku || r.code)) || (api.origItems[oi] && api.origItems[oi].sku) || "",
      producto: (r && r.producto) || (api.origItems[oi] && api.origItems[oi].producto) || "",
      cantCargada: r && r.cantCargada != null ? r.cantCargada : (isAdded(r) ? Number(r.added) || 0 : 0),
      cargada: isAdded(r),
      estado: (r && r.message) || "",
    };
  });
  const gPrevio = api.grupos[grupo];
  if (gPrevio) {
    // mismo grupo, segundo checkout: se agregan las líneas nuevas (por nro, la
    // última versión manda) y se acumulan fotos y contadores.
    const byNro = {};
    for (const l of gPrevio.lineas || []) byNro[l.nro] = l;
    for (const l of lineasGrupo) byNro[l.nro] = l;
    const todasFotos = (gPrevio.foto || []).slice();
    for (const c of foto) {
      const k = (c.code || "") + "|" + (c.nombre || "") + "|" + (c.qty != null ? c.qty : "");
      if (!todasFotos.some((x) => ((x.code || "") + "|" + (x.nombre || "") + "|" + (x.qty != null ? x.qty : "")) === k)) {
        todasFotos.push(c);
      }
    }
    gPrevio.lineas = Object.keys(byNro).map((k) => byNro[k]).sort((a, b) => a.nro - b.nro);
    gPrevio.cargadas = (gPrevio.cargadas || 0) + batchAdded;
    gPrevio.totalLineas = (gPrevio.lineas || []).length;
    gPrevio.productosEnCarrito = (msg && msg.prodAdded != null) ? msg.prodAdded : gPrevio.productosEnCarrito;
    gPrevio.checkouts = (gPrevio.checkouts || 1) + 1;
    gPrevio.foto = todasFotos;
    gPrevio.verificado = gPrevio.verificado || todasFotos.length > 0;
    gPrevio.confirmado = false;
    gPrevio.ultimoCheckout = new Date().toISOString();
  } else {
    api.grupos[grupo] = {
      grupo: grupo,
      manual: !!state.cartIsManual,
      fecha: new Date().toISOString(),
      lineas: lineasGrupo,
      cargadas: batchAdded,
      totalLineas: lineasGrupo.length,
      productosEnCarrito: (msg && msg.prodAdded != null) ? msg.prodAdded : prodAdded,
      // carrito vacío = no se pudo leer el drawer en ese instante.
      verificado: foto.length > 0,
      foto: foto,
      checkouts: 1,
      confirmado: false,
    };
  }
  state.cart = {
    total: api.orderTotal,
    ok: added,
    prodAdded: (msg && msg.prodAdded != null) ? msg.prodAdded : prodAdded,
    // v2.0.58: productos únicos del PEDIDO (para comparar igual contra el
    // carrito real en el informe final: "N de M productos").
    totalProducts: (msg && msg.totalProducts) || api.orderTotal,
    sinStock,
    notFound,
    notConfirmed,
    results: api.results.slice(),
    batchTotal: batchResults.length,
    batchResults,
    batch: {
      ok: batchAdded,
      total: batchResults.length,
      sinStock: batchSin,
      notFound: batchNotF,
      notConfirmed: batchNotC,
    },
    docName: (msg && msg.docName) || state.filename || "",
    allLineItems: api.origItems.slice(),
  };
  if (!msg || !msg.canceled) {
    // v2.0.67: después de CADA bloque se confirma la compra de ese lote
    // (Revisar pedido → Siguiente → Realizar pedido) desde el content script,
    // y al terminar el último lote, queda todo comprado. El usuario pulsa
    // «Enviar a carrito» UNA sola vez: el flujo avanza lote a lote solo.
    // v2.0.82: las tandas de ajustes manuales llevan clave propia ("A1", "A2"…):
    // los lotes numéricos del pedido ya están comprados y su guardia los saltaría
    // — sin clave nueva, el checkout de lo corregido a mano NUNCA se dispara y
    // esas líneas quedarían en el carrito sin comprar.
    // v2.0.92: la clave del checkout manual es por BLOQUE, no por tanda. Una
    // tanda se parte en bloques de 19: con la clave "A1" para todos, el segundo
    // bloque encontraba lotChecks["A1"]=true (ya confirmado por el primero) y se
    // saltaba el checkout, dejando sus líneas en el carrito sin comprar y
    // reportando la tanda como completa. El primer índice original del bloque es
    // único y creciente dentro de la tanda, así que distingue cada checkout y
    // sobrevive a un reinicio del offscreen (batchIdx se persiste).
    const lote = state.cartIsManual
      ? "A" + Math.max(1, state.manualRun || 1) + "." + ((api.batchIdx && api.batchIdx[0]) || 0)
      : Math.floor(((api.batchIdx || [])[0] || 0) / CART_BLOCK) + 1;
    // v2.0.79: guardia contra el CHECKOUT duplicado. Si ya hay un checkout en
    // vuelo para mismo lote (un CART_DONE rejugado por tryRecoverReport o un
    // mensaje duplicado), NO se re-envía; tampoco un lote ya confirmado.
    state.lotChecks = state.lotChecks || {};
    if (state.checkoutLote === lote) {
      try { console.log("[Tokin] CART_DONE rejugado sin duplicar checkout de lote " + lote); } catch (e) {}
      persist();
      emitState();
      return;
    }
    if (state.lotChecks[lote]) {
      // Este lote ya quedó confirmado: no re-comprar. Avanzar al siguiente.
      continueAfterCheckout(lote, "", false);
      return;
    }
    state.checkoutLote = lote;
    setStatus("loading_cart", "Lote " + lote + " cargado al carrito — confirmando el pedido en el store (Revisar pedido → Siguiente → Realizar pedido)…", 3);
    persist();
    emitState();
    // v2.0.94: las CANTIDADES que este lote espera encontrar en el carrito
    // viajan con el checkout. El content script las usa para comparar, en la
    // ventana de «Revisar pedido» y antes de tocar «Siguiente», cada fila del
    // carrito contra la del PDF: un refresh de fondo del store puede dejar una
    // línea en 1 y el pedido se confirmaría corto sin que nadie lo viera.
    // Solo van las líneas que quedaron cargadas (ok con cantidad > 0): las
    // demás no están en el carrito y no hay nada que comparar.
    const checkoutExpect = batchResults
      .filter((r) => isAdded(r) && Number(r.added) > 0)
      .map((r) => ({
        nro: r.nro,
        producto: String(r.producto || "").slice(0, 80),
        storeText: String(r.storeText || "").slice(0, 140),
        want: Number(r.added) || 0,
        unit: String(r.usedUnit || "").trim(),
      }));
    sendSw({ type: "CHECKOUT_BATCH", lote, expect: checkoutExpect }).catch(() => {});
    // Red de seguridad: si el content script no confirma en ~3 min (página de
    // checkout caída o botones distintos), continuar igual y no clavar el flujo.
    armCheckoutTimer();
    return;
  }
  setStatus("canceled", "Carga del carrito cancelada.", 3);
}

// v2.0.67: continuar tras el checkout de un lote. Si ya se intentaron todas
// las líneas, reporte final del pedido entero (compra completada); si restan,
// dispara el siguiente bloque de 19 sin esperar al usuario (flujo automático
// de un solo «Enviar a carrito»).
function continueAfterCheckout(lote, _note, degraded) {
  const api = state.cartApi;
  clearTimeout(state.checkoutTimer || 0);
  state.checkoutTimer = 0;
  if (!api || !api.started) return;
  // v2.0.92: la clave interna del checkout manual es por bloque ("A1.20"); para
  // los mensajes se muestra la tanda ("A1"), que es lo que el usuario reconoce.
  const loteLabel = state.cartIsManual ? "A" + Math.max(1, state.manualRun || 1) : String(lote);
  // v2.0.71: si el checkout del lote NO confirmó (el carrito sigue cargado en
  // el store), NO lanzar el siguiente lote: cargaría líneas encima del lote
  // sin comprar y arruinaría la compra siguiente. Frenar con error claro.
  if (degraded) {
    setStatus(
      "error",
      "No se pudo confirmar la compra del lote " + loteLabel + " en el store (el carrito sigue cargado). " +
        "Revisá la pestaña de tokintienda y confirmá el pedido a mano; después tocá «Terminar».",
      3
    );
    playBeep(false);
    persist();
    emitState();
    return;
  }
  const isAdded = (r) => !!(r && r.ok && String(r.message || "").indexOf("agregado") === 0);
  const done = api.results.filter(Boolean);
  const added = done.filter(isAdded).length;
  const SIN = /sin stock|por falta de stock|no alcanza para|solo tiene\s+\d+\s+(unidad|unidades|un|uds|display|displays|bulto|bultos)|stock max/i;
  const sinStock = done.filter((r) => !isAdded(r) && SIN.test(r.message || "")).length;
  const notFound = done.filter((r) => !isAdded(r) && /no se encontró/i.test(r.message || "")).length;
  const notConfirmed = done.filter((r) => !isAdded(r) && String(r.message || "").indexOf("no se confirmó") === 0).length;
  const allAttempted = api.nextOrig >= api.orderTotal;
  if (allAttempted && !(api.retryIdx && api.retryIdx.length)) {
    const parts = [];
    if (sinStock) parts.push(sinStock + " sin stock");
    if (notFound) parts.push(notFound + " no encontrados");
    if (notConfirmed) parts.push(notConfirmed + " pendientes de confirmación");
    const other = Math.max(0, api.orderTotal - added - sinStock - notFound - notConfirmed);
    if (other) parts.push(other + " con error");
    const docNote = state.cart && state.cart.docName ? " Documento: " + state.cart.docName + "." : "";
    setStatus(
      "done",
      "Pedido completo: todas las compras realizadas por lote. En el carrito quedaron " + added + " de " + api.orderTotal + " líneas" +
        docNote + (parts.length ? " (" + parts.join(", ") + ")" : "") +
        (_note ? " · " + _note : ""),
      4
    );
    playBeep(true);
  } else {
    const quedan = (api.retryIdx || []).length;
    setStatus(
      "loading_cart",
      (state.cartIsManual
        ? "Ajustes manuales tanda " + loteLabel + " pedido realizado. Quedan " + quedan + " líneas por confirmar…"
        : "lote " + lote + " pedido realizado" + ". Continuando con el lote " + (lote + 1) + "…"),
      3
    );
    playBeep(true);
    runCart();
  }
  persist();
  emitState();
}

function cancelCart() {
  state.cancellingCart = true;
  clearTimeout(state.checkoutTimer || 0);
  state.checkoutTimer = 0;
  state.checkoutLote = 0;
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



// v2.0.86: Chrome puede cerrar un offscreen por inactividad. La v2.0.60 lo
// resolvía con un oscilador de 60 Hz "inaudible" (reason AUDIO_PLAYBACK), que
// en la práctica se oía como un zumbido grave y quemaba CPU de forma continua.
// Ahora se usa un Web Lock: el chequeo de autocierre de un offscreen no cierra
// documentos con un lock tomado, sin emitir un solo sonido.
let releaseKeep = null;
function startKeepAlive() {
  if (releaseKeep || !navigator.locks) return;
  try {
    navigator.locks
      .request("tokin-offscreen-keepalive", () => new Promise((res) => { releaseKeep = res; }))
      .catch(() => { releaseKeep = null; });
  } catch (e) { releaseKeep = null; }
}
function stopKeepAlive() {
  // navigator.locks no tiene unlock: el lock se suelta resolviendo la promesa
  // que se paso al callback.
  if (releaseKeep) { try { releaseKeep(); } catch (e) {} }
  releaseKeep = null;
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
    case "START_MANUAL_BATCH":
      startManualBatch(msg)
        .then((r) => sendResponse(r))
        .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
      return true;
    case "ADD_TO_CART":
      runCart()
        .then(() => sendResponse({ ok: true }))
        .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
      return true;
    case "UPDATE_LINE_ITEMS":
      // El popup permitió editar las filas (doble clic): se persisten los
      // cambios en la sesión para que la carga al carrito use los valores
      // corregidos por el usuario. Entre bloques, los cambios también se
      // aplican a las líneas pendientes del pedido original (lo hace runCart
      // al refrescar origItems antes del próximo bloque).
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
          // v2.0.76: batchStart viaja en cada progreso desde el content script;
          // sin esto el popup solo veía posiciones 0–18 y títulaba siempre
          // "Bloque 1" durante cualquier lote.
          state.cartProgress = { index: msg.index, total: msg.total, ok: !!msg.ok, batchStart: typeof msg.batchStart === "number" ? msg.batchStart : 0 };
          if (typeof msg.batchStart === "number" && state.cart) state.cart.batchStart = msg.batchStart;
        }
        persist();
        emitState();
      }
      sendResponse({ ok: true });
      break;
    case "CART_STOP":
      // El lote quedó huérfano (pestaña o sesión cerrada): vuelve al paso de
      // líneas capturadas. La tarea no terminó con confirmación del usuario,
      // así que NO se marca "canceled" y NO se limpia la sesión. La tanda de
      // bloques se reinicia desde cero para no arrastrar resultados viejos.
      if (state.status === "loading_cart") {
        state.cart = null;
        state.cartProgress = null;
        state.cartCanceled = false;
        state.cartApi = null;
        setStatus("idle", "", 1);
        persist();
        emitState();
      }
      sendResponse({ ok: true });
      break;
    case "CART_PAUSE":
      // v2.0.23: pausa por interrupción (internet). NO limpia nada:
      // conserva line_items, cart y cartResults para que el usuario
      // pueda reanudar desde donde se quedó.
      if (state.status === "loading_cart") {
        setStatus("paused", "Tarea pausada — se reanuda sola cuando vuelva la señal.", 3);
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
    case "CHECKOUT_DONE": {
      // v2.0.67: el content script terminó el checkout del lote (o falló). Se
      // continúa con el siguiente bloque o se cierra el pedido completo.
      const lote = state.checkoutLote || 1;
      state.checkoutLote = 0;
      // v2.0.75: registrar si la compra de ESTE lote quedó confirmada de verdad
      state.lotChecks = state.lotChecks || {};
      state.lotChecks[lote] = !!(msg && msg.ok);
      // v2.0.92: la clave del checkout manual es por bloque ("A1.20"), pero los
      // GRUPOS del informe se agrupan por tanda ("A1"). Se mapea de vuelta para
      // que el separador del Excel siga diciendo PEDIDO REALIZADO.
      const grupoLote = (state.cartIsManual && /^A\d+\./.test(String(lote)))
        ? String(lote).split(".")[0]
        : String(lote);
      // v2.0.82: mismo dato en la memoria de grupos (que además tiene la foto del
      // carrito previa al checkout). Si el grupo no existe —carrito ya
      // confirmado por otra vía— se ignora en vez de inventarlo.
      try {
        const api = state.cartApi;
        if (api && api.grupos && api.grupos[grupoLote]) {
          api.grupos[grupoLote].confirmado = !!(msg && msg.ok);
          api.grupos[grupoLote].confirmadoFecha = new Date().toISOString();
        }
      } catch (e) {}
      // Anotar adentro del reporte persistido (storage.local) para que un
      // popup que se abre con la sesión muerta igual sepa qué lotes fueron
      // de verdad confirmados.
      try {
        chrome.storage.local.get(["tokinCartReport"], (d) => {
          const rep = d && d.tokinCartReport;
          if (rep) {
            rep.lotChecks = state.lotChecks;
            // v2.0.82: los grupos con su foto del carrito viajan al reporte
            // persistido para que el Excel se arme igual aunque el offscreen
            // ya haya muerto.
            rep.grupos = (state.cartApi && state.cartApi.grupos) || {};
            chrome.storage.local.set({ tokinCartReport: rep }, () => { void chrome.runtime.lastError; });
          }
        });
      } catch (e) {}
      // v2.0.97: los avisos del checkout (desajustes de cantidades) se anexan
      // al mensaje que muestra el popup; no cambian el hecho de que el pedido
      // de ese lote quedó realizado.
      const avisos = Array.isArray(msg && msg.avisosCheckout) ? msg.avisosCheckout : [];
      let noteFinal = msg && msg.message ? String(msg.message) : "";
      if (avisos.length) {
        noteFinal = (noteFinal ? noteFinal + " · " : "") + avisos.join(" · ");
        try {
          const api = state.cartApi;
          if (api) {
            api._avisosCheckout = (api._avisosCheckout || []).concat(avisos);
            if (state.cart) state.cart._avisosCheckout = (state.cart._avisosCheckout || []).concat(avisos);
          }
        } catch (e) {}
      }
      continueAfterCheckout(lote, noteFinal, !(msg && msg.ok));
      sendResponse({ ok: true });
      break;
    }
    case "CLEAR":
      resetState();
      sendSw({ type: "CLEAR_PERSIST" });
      emitState();
      sendResponse({ ok: true });
      break;
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

// v2.0.60: si Chrome cerró este documento a mitad de un bloque mientras el
// content script terminaba, el CART_DONE se perdió. El content script persiste
// su reporte en storage.local (tokinCartReport) al terminar el bloque: al
// recrear el offscreen, si la sesión restaurada está en loading_cart con un
// batchIdx que coincide con el del reporte, se aplica el CART_DONE idempotente
// y la tarea avanza a block_done/done aunque el mensaje original se haya
// perdido.
function tryRecoverReport() {
  chrome.storage.local.get(["tokinCartReport"], function (d) {
    try {
      if (state.status !== "loading_cart" && state.status !== "paused") return;
      var rep = d && d.tokinCartReport;
      if (!rep || !Array.isArray(rep.results) || !rep.results.length) return;
      var api = state.cartApi;
      if (!api || !api.started || !Array.isArray(api.batchIdx)) return;
      var rb = rep.batchIdx || [];
      if (rb.length !== api.batchIdx.length) return;
      for (var i = 0; i < rb.length; i++) {
        if (Number(rb[i]) !== Number(api.batchIdx[i])) return;
      }
      applyCartDone(rep);
      persist();
      emitState();
      try { console.log("[Tokin] reporte de bloque recuperado del storage (" + rep.results.length + " líneas)"); } catch (e) {}
    } catch (e) {}
  });
}

// Al recrear el offscreen (Chrome lo cierra y se vuelve a abrir) se restaura la
// sesión previa: el formulario queda en el paso donde estaba. Si había un lote
// en curso (v2.0.27: corriendo O pausado), la sesión vuelve a ese estado para
// que el popup refleje la tarea restaurada; solo se vuelve a idle si ya no hay
// job vivo (la tarea terminó mientras el offscreen estaba muerto).
function restoreSession() {
  sendSw({ type: "GET_STATE" }).then((res) => {
    try {
      const s = (res && res.ok && res.state) || null;
      if (!s) return;
      if (s.status === "loading_cart" || s.status === "paused") {
        chrome.storage.local.get(["tokinCartJob", "tokinCartReport"], function(d) {
          var job = d && d.tokinCartJob;
          var rep = d && d.tokinCartReport;
          var liveJob = job && job.phase && job.phase !== "done";
          var contentDone = !!(job && job.phase === "done");
          // v2.0.91: el job pudo liberarse (el content lo borra recién tras
          // mandar el CART_DONE), pero si el reporte persistido del bloque tiene
          // el MISMO batchIdx que la sesión restaurada, ese bloque todavía puede
          // tener el checkout sin disparar. En ese caso NO se borra la sesión:
          // tryRecoverReport() reprocesa el CART_DONE perdido (idempotente).
          var repMatches = !!(rep && Array.isArray(rep.results) && rep.results.length &&
            Array.isArray(rep.batchIdx) && s.cartApi && Array.isArray(s.cartApi.batchIdx) &&
            rep.batchIdx.length === s.cartApi.batchIdx.length &&
            rep.batchIdx.every(function(x, i) { return Number(x) === Number(s.cartApi.batchIdx[i]); }));
          if (liveJob || contentDone || repMatches) {
            var paused = !!(job && job.phase === "paused");
            state.status = paused ? "paused" : "loading_cart";
            state.step = 3;
            state.progress = paused
              ? "Tarea pausada — se reanuda sola cuando vuelva la señal."
              : (s.progress || "Cargando carrito…");
            state.line_items = Array.isArray(s.line_items) ? s.line_items : [];
            state.cart = s.cart || null;
            state.cartProgress = s.cartProgress || null;
            state.cartApi = s.cartApi || null;
            // v2.0.92: sin esto, un reinicio del offscreen a mitad de una tanda
            // manual perdía la identidad ("A1"/"A2") y el bloque se recalculaba
            // con clave numérica de lote (ya confirmada) → checkout salteado.
            state.cartIsManual = !!s.cartIsManual;
            state.manualRun = Number(s.manualRun) || 0;
            state.lotChecks = (s && s.lotChecks) || state.lotChecks || {};
            if (rep && rep.lotChecks) state.lotChecks = Object.assign({}, state.lotChecks, rep.lotChecks);
            // v2.0.96: recuperar el lote con el checkout en vuelo y volver a armar
            // su temporizador de seguridad. Si no, el offscreen recreado se
            // quedaba esperando un CHECKOUT_DONE que no iba a llegar y el lote no
            // terminaba nunca (la tarea clavada en «cargando carrito»).
            state.checkoutLote = Number(s.checkoutLote) || 0;
            if (state.checkoutLote) {
              try { console.log("[Tokin] offscreen recreado con el checkout del lote " + state.checkoutLote + " en vuelo: rearmo la red de seguridad"); } catch (e) {}
              armCheckoutTimer();
            }
            try {
              if (state.cartApi) {
                state.cartApi.grupos = state.cartApi.grupos || {};
                if (rep && rep.grupos) state.cartApi.grupos = Object.assign({}, state.cartApi.grupos, rep.grupos);
              }
            } catch (eG) {}
            // v2.0.60/91: si este offscreen murió a mitad del bloque (o se recreó
            // antes de procesar el CART_DONE), recuperar el reporte persistido.
            tryRecoverReport();
          } else {
            state.status = "idle";
            state.step = 1;
            state.progress = "";
            state.cart = null;
            state.cartProgress = null;
            state.cartApi = null;
          }
          persist();
          emitState();
        });
        return;
      }
      state.status = s.status || "idle";
      state.step = s.step || 1;
      state.progress = s.progress || "";
      state.filename = s.filename || "";
      state.error = s.error || "";
      state.summary = s.summary || null;
      state.line_items = Array.isArray(s.line_items) ? s.line_items : [];
      state.cart = s.cart || null;
      state.cartProgress = s.cartProgress || null;
      state.cartApi = s.cartApi || null;
      state.cartIsManual = !!s.cartIsManual;
      state.manualRun = Number(s.manualRun) || 0;
      state.lotChecks = s.lotChecks || {};
      persist();
      emitState();
    } catch (e) {}
  });
}
restoreSession();

