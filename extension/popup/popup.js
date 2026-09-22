// Tokin AutoPedido - popup logic (100% local, sin servidor, sin OAuth)
// El popup solo muestra y dirige: el procesamiento (OCR) y la carga al carrito
// corren en el documento offscreen, que sigue vivo aunque este popup se cierre
// al minimizar la pestaña. Al reabrir, se restaura la sesión desde allí.
import { parseDocument, mapFields, summarize } from "../core/agent.js";
import { getAllowedUsers, isAllowed, grantAccess, checkCachedAccess, revokeAccess } from "../core/access.js";
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const ui = {
    doc: null,
    session: null,
    allowed: null,
    sessionState: null,
    lineItems: [],
    cart: null,
  };

  // ----------------------------------------------------------- mensajes

  function send(target, msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ ...msg, target }, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, message: chrome.runtime.lastError.message });
        resolve(res || { ok: false, message: "Sin respuesta" });
      });
    });
  }

  function toSw(msg) { return send("sw", msg); }
  function toOff(msg) { return send("offscreen", msg); }

  // ------------------------------------------------------------- util

  function setStatus(text, kind) {
    const el = $("#status");
    el.textContent = text;
    el.className = "status" + (kind ? " " + kind : "");
  }

  function setBadge(kind, text, title) {
    const el = $("#access-badge");
    el.textContent = text;
    el.className = "badge" + (kind ? " " + kind : "");
    el.title = title || "";
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function bufferToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  function getStoreTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({}, (tabs) => {
        const active = tabs.find((t) => t.active && t.id);
        if (active && active.url && active.url.indexOf("tokintienda.com.ar/store") !== -1) {
          resolve(active);
          return;
        }
        const store = tabs.find(
          (t) => t.id && t.url && t.url.indexOf("tokintienda.com.ar/store") !== -1
        );
        resolve(store || active || null);
      });
    });
  }

  async function pingWithRetry(tabId, tries) {
    for (let i = 0; i < (tries || 4); i++) {
      const pong = await pingTab(tabId);
      if (pong && pong.ok) return pong;
      await new Promise((r) => setTimeout(r, 400));
    }
    return null;
  }

  function pingTab(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: "PING" }, (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res);
      });
    });
  }

  function sendTab(tabId, msg) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, message: chrome.runtime.lastError.message });
        resolve(res || { ok: false, message: "Sin respuesta" });
      });
    });
  }

  // ------------------------------------------------------------- estado

  function showEl(sel, show) {
    const el = $(sel);
    if (el) el.classList.toggle("hidden", !show);
  }

  function setAction(which) {
    // «Enviar a carrito» vuelve habilitado salvo que el estado lo vuelva
    // obsoleto (post-cancelación: reenviar duplicaría lo que ya quedó cargado).
    const btnCart = $("#btn-cart");
    if (btnCart) btnCart.disabled = false;
    showEl("#btn-cancel", which === "cancel");
    showEl("#btn-cart", which === "cart" || which === "blocks");
    showEl("#btn-cancel-cart", which === "cancelCart");
    showEl("#btn-open-store", which === "done" || which === "blocks");
    showEl("#btn-excel", which === "done" || which === "blocks");
    showEl("#btn-clear", which === "done" || which === "blocks");
  }

  // v2.0.67: el flujo es automático de punta a punta (lotes de 19 + checkout
  // por lote) y arranca con UNA sola pulsación: el botón siempre dice
  // "Enviar al carrito", sin importar cuántas líneas queden.
  function updateCartBtn() {
    const btn = $("#btn-cart");
    if (!btn) return;
    btn.textContent = "Enviar al carrito";
  }

  function resetPanels() {
    showEl("#items-box", false);
    showEl("#done-summary", false);
    showEl("#cart-results-final", false);
    showEl("#done-hint", false);
    setAction("none");
  }

  function statusKind(st) {
    if (!st) return "";
    if (st.status === "error") return "err";
    if (st.status === "parsed" || st.status === "done" || st.status === "block_done") return "ok";
    if (st.status === "canceled" || st.status === "paused") return "warn";
    return "";
  }

  function showDropzoneFile(name) {
    if (!name) return;
    $("#file-name").textContent = name;
    $("#file-name").classList.add("big");
    $("#dropzone").classList.add("has-file");
  }

  function applyState(st) {
    if (!st || st.status === "idle") {
      resetPanels();
      setStatus("Esperando el archivo del pedido…");
      return;
    }
    ui.sessionState = st;
    ui.lineItems = st.line_items || [];
    ui.cart = st.cart || null;

    // El documento de la sesión activa se ve cargado en la dropzone en todos
    // los estados (parseando, reconocido, cargando carrito, terminado,
    // cancelado y error): denota sobre qué archivo se está trabajando.
    showDropzoneFile((st.cart && st.cart.docName) || st.filename || "");

    if (st.status === "parsing") {
      resetPanels();
      setAction("cancel");
      setStatus(st.progress || "Procesando…", "");
    } else if (st.status === "parsed") {
      resetPanels();
      renderItems();
      showEl("#items-box", true);
      setAction(ui.lineItems.length ? "cart" : "none");
      updateCartBtn(ui.lineItems.length);
      setStatus(
        "Pedido reconocido: " + ui.lineItems.length + " líneas. Revisá las filas y tocá «Enviar al carrito».",
        "ok"
      );
    } else if (st.status === "loading_cart") {
      showEl("#items-box", true);
      showEl("#done-summary", false);
      showEl("#cart-results-final", false);
      showEl("#done-hint", false);
      setAction("cancelCart");
      renderCartItems(st.cartProgress, st.cart && (st.cart.batchTotal || st.cart.total));
    } else if (st.status === "block_done") {
      // v2.0.67: estado legado (los lotes avanzan SOLOS con checkout por lote).
      // Se mantiene el render por compatibilidad si alguna sesión vieja lo
      // persistió, pero ya no hay botón "siguiente bloque".
      showEl("#items-box", true);
      showEl("#done-summary", true);
      showEl("#cart-results-final", true);
      showEl("#done-hint", false);
      setAction("blocks");
      renderItems();
      updateCartBtn();
      renderBlockSummary(st);
      renderCartResults(st.cart && st.cart.batchResults, $("#cart-results-final"));
      setStatus(
        st.progress || "Bloque cargado — el flujo continúa solo con el siguiente lote.",
        "ok"
      );
    } else if (st.status === "done") {
      showEl("#items-box", false);
      showEl("#done-summary", true);
      showEl("#cart-results-final", true);
      showEl("#done-hint", true);
      setAction("done");
      renderDone(st);
      const c = st.cart || { ok: 0, total: 0 };
      setStatus("Pedido cargado en el carrito: " + (c.ok || 0) + " de " + (c.total || 0) + ".", "ok");
    } else if (st.status === "canceled") {
      if (st.step === 3) {
        showEl("#items-box", false);
        showEl("#done-summary", true);
        showEl("#cart-results-final", true);
        showEl("#done-hint", false);
        showEl("#btn-excel", true);
        setAction("cart");
        // Tras cancelar, lo que se cargó queda en el carrito del store y solo
        // se vacía con «Reanudar» o «Terminar»: reenviar acá duplicaría
        // productos. El botón queda visible pero obsoleto (gris, sin acción).
        const btnCart = $("#btn-cart");
        if (btnCart) btnCart.disabled = true;
        renderDone(st);
        const c = st.cart || { ok: 0, total: 0 };
        setStatus("Carga cancelada: " + (c.ok || 0) + " de " + (c.total || 0) + " en el carrito.", "warn");
      } else {
        resetPanels();
        setStatus(st.progress || "Proceso cancelado.", "warn");
      }
    } else if (st.status === "paused") {
      showEl("#items-box", true);
      showEl("#done-summary", false);
      showEl("#cart-results-final", false);
      showEl("#done-hint", false);
      setAction("cancelCart");
      renderCartItems(st.cartProgress, st.cart && st.cart.total);
      setStatus(st.progress || "Tarea pausada — se reanuda sola cuando vuelva la señal.", "warn");
    } else if (st.status === "error") {
      resetPanels();
      setStatus(st.error || st.progress || "Ocurrió un error.", "err");
      if (st.step === 3 && ui.lineItems.length) {
        showEl("#items-box", true);
        setAction("cart");
      }
    }
  }

  // Separador de "Bloque N — líneas X a Y" (v2.0.55/58). El número de bloque y
  // las líneas salen del nro de INGESTA original, no de la posición, para que
  // los lotes no se re-numeren mientras se van cargando. Acepta también filas
  // envueltas ({it}) como las que usa renderCartItems.
  const GROUP = 19;
  function blockRow(items, i, cols) {
    const get = (el) => el && (el.nro != null ? el.nro : (el.it && el.it.nro));
    const firstIt = items[i];
    const end = Math.min(i + GROUP, items.length) - 1;
    const lastIt = items[end];
    const firstN = get(firstIt) || (i + 1);
    const lastN = get(lastIt) || (end + 1);
    const blockN = get(firstIt) ? Math.floor((get(firstIt) - 1) / GROUP) + 1 : Math.floor(i / GROUP) + 1;
    return '<tr class="bloque"><td colspan="' + cols + '">Bloque ' + blockN +
      " — líneas " + firstN + " a " + lastN + "</td></tr>";
  }

  function renderItems() {
    const items = ui.lineItems || [];
    const box = $("#items-box");
    if (!items.length) {
      box.innerHTML = '<p class="hint">No se detectaron líneas de pedido.</p>';
      return;
    }
    let html =
      '<table><thead><tr><th>#</th><th>Código</th><th>Producto</th><th>Cant.</th><th>Unidad</th></tr></thead><tbody>';
    items.forEach((it, i) => {
      if (i % GROUP === 0) html += blockRow(items, i, 5);
      const unidad = it.categoria || it.unidad || "";
      html +=
        "<tr>" +
        // v2.0.56: el # es el número de INGESTA original, estable por línea
        // aunque se vayan quitando filas con cada bloque de 19.
        '<td class="mono">' + (it.nro || (i + 1)) + "</td>" +
        '<td class="mono editable" data-i="' + i + '" data-field="sku" title="Doble clic para editar">' + esc(it.sku || "") + "</td>" +
        '<td class="editable" data-i="' + i + '" data-field="producto" title="Doble clic para editar">' + esc(it.producto) + "</td>" +
        '<td class="editable" data-i="' + i + '" data-field="cantidad" title="Doble clic para editar">' + esc(it.cantidad) + "</td>" +
        '<td class="editable" data-i="' + i + '" data-field="unidad" title="Doble clic para editar">' + esc(unidad) + "</td>" +
        "</tr>";
    });
    html += "</tbody></table>";
    box.innerHTML = html;
  }

  // Doble clic sobre una celda de la tabla: el casillero pasa a editable como
  // texto; Enter/Enter fuera confirma y Escape cancela. Los cambios se persisten
  // en la sesión del offscreen (UPDATE_LINE_ITEMS) para que la carga al carrito
  // use los valores corregidos.
  function startCellEdit(td) {
    const i = Number(td.dataset.i);
    const field = td.dataset.field;
    const items = ui.lineItems || [];
    if (!(i >= 0) || !items[i] || td.querySelector("input")) return;
    const current = String(items[i][field] == null ? "" : items[i][field]);
    const input = document.createElement("input");
    input.type = "text";
    input.className = "cell-input";
    input.value = current;
    td.textContent = "";
    td.appendChild(input);
    input.focus();
    input.select();
    let finished = false;
    const commit = (save) => {
      if (finished) return;
      finished = true;
      if (save) {
        const v = input.value;
        if (v !== current) {
          items[i][field] = v;
          if (field === "unidad") items[i].categoria = v;
          pushItems();
        }
      }
      renderItems();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        commit(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        commit(false);
      }
    });
    input.addEventListener("blur", () => commit(true));
  }

  function pushItems() {
    toOff({ type: "UPDATE_LINE_ITEMS", items: ui.lineItems });
  }

  function renderCartResults(results, box) {
    const res = (results || []).filter(Boolean);
    if (!res.length) {
      box.innerHTML = '<p class="hint">Cargando…</p>';
      return;
    }
    // "Agregado" = lo que REALMENTE quedó en el carrito (message empieza con
    // "agregado"); "sin stock" y "no se confirmó" no cuentan como cargados.
    const isAdded = (r) => r.ok && String(r.message || "").indexOf("agregado") === 0;
    const added = res.filter(isAdded).length;
    let html =
      '<p class="hint">Agregados al carrito: ' + added + " de " + res.length + ". Revisá el carrito en el store para confirmar.</p>";
    // v2.0.73: el REPORTE FINAL se divide en bloques de 19 líneas (en el orden
    // de ingesta): cada uno arranca con el separador «Lote N pedido realizado»
    // para poder ver de un vistazo qué lote se compró completo y qué juntó más
    // faltantes.
    html += res
      .map((r, i) => {
        const nro = (r && (r.nro != null ? r.nro : (r.itemNro != null ? r.itemNro : null))) || (i + 1);
        const blockN = Math.floor((nro - 1) / GROUP) + 1;
        const isFirstOfBlock = (i === 0) ||
          Math.floor(((res[i - 1] && (res[i - 1].nro != null ? res[i - 1].nro : (res[i - 1].itemNro != null ? res[i - 1].itemNro : i))) - 1) / GROUP) + 1 !== blockN;
        const cls = isAdded(r) ? "ok" : r.ok ? "warn" : "err";
        const sep = isFirstOfBlock
          ? '<div class="bloque-sep" style="font-weight:600;padding:6px 0;border-bottom:1px solid #cbd5e1;margin-top:8px">Lote ' + blockN + " pedido realizado</div>"
          : "";
        return sep + '<div class="cart-row ' + cls + '"><b>' + esc(r.producto) + "</b><span>" + esc(r.message) + "</span></div>";
      })
      .join("");
    box.innerHTML = html;
  }

  function renderCartItems(progress, total) {
    const box = $("#items-box");
    const list = ui.lineItems || [];
    const done = progress && typeof progress.index === "number" ? progress.index : -1;
    const cart = ui.cart || {};
    // v2.0.73: el bloque en proceso se calcula desde batchStart ABSOLUTO que
    // emite el offscreen (número de ingesta), no del índice del slice visible.
    const batchStart = typeof cart.batchStart === "number" ? cart.batchStart : 0;
    const batchSize = cart.batchTotal || total || 0;
    const curBlock = Math.floor(batchStart / GROUP) + 1;
    const curFirst = batchStart + 1;
    const curLast = batchStart + (batchSize || GROUP);
    const progressInBatch = Math.min(Math.max(done + 1, 0), batchSize || 1);
    if (total || list.length) {
      setStatus("Bloque " + curBlock + " — líneas " + curFirst + " a " + curLast + " · cargando " + progressInBatch + " de " + (batchSize || total || list.length) + "…", "");
    }
    const rest = list
      .map((it, i) => ({ it, orig: i }))
      .filter((r) => r.orig > done);
    // Lotes ya REALIZADOS, acumulados arriba: cada bloque que ya confirmó la
    // compra queda como una fila «Lote N pedido realizado» en la parte
    // superior — se lee el pedido completo procesado mientras avanza.
    let html = "";
    for (let b = 1; b < curBlock; b++) {
      html += '<tr class="bloque"><td colspan="4">Lote ' + b + " pedido realizado</td></tr>";
    }
    if (!rest.length) {
      box.innerHTML = html ? "<table><tbody>" + html + "</tbody></table>" : "";
      return;
    }
    html += '<table><thead><tr><th>#</th><th>Producto</th><th>Cant.</th><th>Unidad</th></tr></thead><tbody>';
    let lastBlockN = -1;
    rest.forEach((r) => {
      const nro = (r.it && r.it.nro) || (batchStart + r.orig + 1);
      const blockN = Math.floor((nro - 1) / GROUP) + 1;
      if (blockN !== lastBlockN) {
        html += '<tr class="bloque"><td colspan="4">Bloque ' + blockN +
          " — líneas " + ((blockN - 1) * GROUP + 1) + " a " + (blockN * GROUP) + "</td></tr>";
        lastBlockN = blockN;
      }
      const unidad = r.it.categoria || r.it.unidad || "";
      html +=
        "<tr>" +
        '<td class="mono">' + nro + "</td>" +
        "<td>" + esc(r.it.producto) + "</td>" +
        "<td>" + esc(r.it.cantidad) + "</td>" +
        "<td>" + esc(unidad) + "</td>" +
        "</tr>";
    });
    html += "</tbody></table>";
    box.innerHTML = html;
  }

  // Reporte parcial de la parada entre bloques (v2.0.55): qué pasó con las 19
  // líneas del bloque recién cargado y cuánto queda del pedido.
  // v2.0.57: NO existe "sin confirmar" ni acumulados parciales: las líneas que
  // fallaron ya quedaron reportadas (no vuelven a la lista) y los bloques
  // avanzan de corrido; el número que queda es lo que falta por intentar.
  function renderBlockSummary(st) {
    const b = ((st && st.cart) || {}).batch || {};
    let html = "Bloque cargado: " + (b.ok || 0) + " de " + (b.total || 0) + " líneas en este bloque.";
    const parts = [];
    if (b.sinStock) parts.push("Sin stock: " + b.sinStock);
    if (b.notFound) parts.push("No encontrados: " + b.notFound);
    if (parts.length) html += "\n" + parts.join(" · ");
    const pending = ((st && st.line_items) || []).length;
    html += "\nQuedan " + pending + " líneas del pedido por cargar" + (pending ? "." : "");
    $("#done-summary").textContent = html;
  }

  function renderDone(st) {
    const c = (st && st.cart) || ui.cart || { results: [], total: 0, ok: 0 };
    const wasCanceled = st && st.status === "canceled";
    let html = wasCanceled
      ? "Carga cancelada. Lo que alcanzó a procesarse quedó en el carrito del store."
      : "El pedido quedó cargado en el carrito del store.";
    if (c.docName) html += "\nDocumento procesado: " + c.docName + ".";
    if (c.total) {
      // v2.0.55/58: la cifra principal del informe sale del CARRITO REAL
      // (cards únicas verificadas al cierre), no de las líneas: el usuario
      // compara contra lo que ve en el carrito del store ("cargaron 16 y hay
      // 17"). Las "líneas del pedido" quedan como dato secundario (una misma
      // card puede recibir varias líneas por la semántica SET del store).
      const headN = c.prodAdded != null ? c.prodAdded : c.ok;
      const headM = c.totalProducts || c.total;
      html += "\nEn el carrito (verificado al cierre): " + headN + " de " + headM + " productos del pedido.";
      if (c.ok !== headN || c.total !== headM) {
        html += "\nLíneas del pedido confirmadas: " + c.ok + " de " + c.total + ".";
      }
    }
    const parts = [];
    if (c.sinStock) parts.push("Sin stock: " + c.sinStock);
    if (c.notFound) parts.push("No encontrados: " + c.notFound);
    // v2.0.57: no existe "sin confirmar" en el informe final.
    if (parts.length) html += "\n" + parts.join(" · ");
    $("#done-summary").textContent = html;
    renderCartResults(c.results, $("#cart-results-final"));
  }

  // ------------------------------------------------------------- init

  // v2.0.27: sincronización del popup con el JOB REAL del store. La sesión del
  // offscreen puede estar limpia (idle) mientras en chrome.storage.local vive
  // un lote corriendo o pausado (ej.: se cortó la señal, se limpió el
  // formulario, cambió el renderer). En ese caso el popup muestra la tarea
  // restaurada (documento, líneas restantes, progreso), nunca un formulario
  // vacío que esconde una tarea activa.
  const JOB_KEY = "tokinCartJob";

  function jobToState(job) {
    const paused = job.phase === "paused";
    const idx = typeof job.index === "number" ? Math.max(0, job.index) : 0;
    return {
      status: paused ? "paused" : "loading_cart",
      step: 3,
      filename: job.docName || "",
      progress: paused
        ? "Sin conexión — tarea pausada en línea " + (idx + 1) + "/" + (job.total || 0) +
          ". Se reanuda sola cuando vuelva la señal."
        : "",
      line_items: (job.items || []).map((it) => ({
        // v2.0.57: preservar el número de INGESTA original. Antes se dropaba acá
        // (jobToState) y, al restaurar la vista desde el job entre bloques, las
        // filas del segundo lote volvían a numerarse desde 1 en vez de seguir
        // desde el 20.
        nro: it.nro || undefined,
        producto: it.producto || "",
        cantidad: it.cantidad || "",
        unidad: it.unidad || "",
        categoria: it.categoria || "",
        sku: it.sku || "",
      })),
      cart: { total: job.total || 0, docName: job.docName || "" },
      // Igual semántica que CART_PROGRESS: index = última línea intentada.
      cartProgress: { index: Math.max(0, idx - 1), total: job.total || 0 },
    };
  }

  async function syncFromJob() {
    let res;
    try {
      res = await new Promise((r) => chrome.storage.local.get([JOB_KEY, "tokinCartReport"], (x) => r(x || {})));
    } catch (e) {
      return false;
    }
    const job = res[JOB_KEY];
    if (job && job.phase && job.phase !== "done") {
      ui.synthFromJob = true;
      applyState(jobToState(job));
      return true;
    }
    // v2.0.60: sin job vivo pero con reporte del último bloque persistido por
    // el content script (el offscreen estaba cerrado cuando terminó). Se
    // reconstruye la vista parcial/final desde el reporte para que el usuario
    // igual vea el resultado del lote y pueda exportar el Excel. Solo cuando NO
    // hay una sesión real del offscreen contando el estado (si el offscreen
    // vive, su STATE block_done/done es más rico y manda).
    const report = res["tokinCartReport"];
    const st = ui.sessionState;
    const realSessionLive = !ui.synthFromJob && st &&
      (st.status === "block_done" || st.status === "done" || st.status === "loading_cart" || st.status === "paused");
    if (!realSessionLive && report && Array.isArray(report.results) && (report.results.length || report.batch)) {
      ui.synthFromJob = true;
      applyState(reportToState(report));
      return true;
    }
    if (ui.synthFromJob) {
      // El job desapareció mientras el popup mostraba la vista sintetizada:
      // la tarea terminó en el store (el offscreen suele avisar antes con su
      // propio STATE done; esto cubre el caso sin offscreen).
      ui.synthFromJob = false;
      resetPanels();
      $("#file-name").textContent = "";
      $("#dropzone").classList.remove("has-file");
      setStatus("La tarea del store terminó. Revisá el carrito o cargá otro pedido.", "ok");
    }
    return false;
  }

  // Estado sintético construido desde el reporte persistido del bloque
  // (tokinCartReport). Usado cuando el offscreen se cerró y no pudo asentar el
  // CART_DONE: el reporte del content script basta para mostrar el lote.
  function reportToState(report) {
    const lastBatch = !!report.lastBatch;
    const status = lastBatch ? "done" : "block_done";
    const c = {
      total: report.orderTotal || report.total || 0,
      ok: report.added || 0,
      prodAdded: report.prodAdded != null ? report.prodAdded : (report.added || 0),
      totalProducts: report.totalProducts || report.orderTotal || report.total || 0,
      sinStock: report.sinStock || 0,
      notFound: report.notFound || 0,
      notConfirmed: report.notConfirmed || 0,
      results: report.results || [],
      batchResults: report.results || [],
      batch: report.batch || { ok: 0, total: 0 },
      docName: report.docName || "",
      allLineItems: [],
      fromReport: true,
    };
    return {
      status,
      step: lastBatch ? 4 : 3,
      filename: report.docName || "",
      progress: lastBatch
        ? "Pedido cargado en el carrito: " + c.prodAdded + " de " + c.totalProducts +
          " productos del pedido (reporte recuperado)."
        : "Bloque listo: " + (c.batch && c.batch.ok || 0) + " de " +
          ((c.batch && c.batch.total) || c.batchResults.length) +
          " líneas en este bloque (reporte recuperado).",
      line_items: [],
      cart: c,
    };
  }

  // v2.0.56: si hay una tarea ya en curso en el store (bloque cargando al
  // carrito, o pausada por señal), el popup se restaura tal cual SIN pasar por
  // las compuertas de acceso ni el cartel de "Refrescá (F5)". Minimizar o
  // cambiar de ventana no rompe la sesión: el job sigue corriendo solo.
  async function maybeRestoreRunningTask() {
    let res;
    try {
      res = await new Promise((r) => chrome.storage.local.get(JOB_KEY, (x) => r(x || {})));
    } catch (e) {
      return false;
    }
    const job = res[JOB_KEY];
    if (!job || !job.phase || job.phase === "done") return false;
    ui.allowed = { ok: true, emails: (ui.allowed && ui.allowed.emails) || [], cached: true };
    setBadge("ok", "Tarea en curso", "");
    $("#access-screen").classList.add("hidden");
    $("#main-screen").classList.remove("hidden");
    $("#cfg-session").textContent = "Tarea en curso: " + (job.docName || "pedido en el store");
    syncFromJob();
    return true;
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    // v2.0.60: también el reporte persistido por el content script (tokinCartReport)
    // dispara la sincronización: cubre el caso en que el offscreen no existe y el
    // job ya se borró — el reporte llega un instante después del removido del job.
    if (!changes[JOB_KEY] && !changes["tokinCartReport"]) return;
    // Solo maneja la vista cuando el popup está mostrando la vista sintetizada
    // o no tiene sesión activa; si hay sesión real del offscreen, ella manda.
    if (ui.synthFromJob || !ui.sessionState || ui.sessionState.status === "idle") {
      syncFromJob();
    }
  });

  async function init() {
    // v2.0.56: primero restaura una tarea en curso (si la hay) y recién
    // entonces verifica acceso/sesión; así el recuadro de F5 no bloquea un job
    // que ya está corriendo.
    if (await maybeRestoreRunningTask()) return;
    const tab = await getStoreTab();
    const tabId = tab && tab.id;

    let access = await getAllowedUsers();
    if (!access.ok) {
      await new Promise((r) => setTimeout(r, 800));
      access = await getAllowedUsers(true);
    }
    ui.allowed = access;
    if (access.ok) {
      setBadge(access.cached ? "ok" : "ok", "Lista OK", access.warning || "Usuarios autorizados cargados");
    } else {
      setBadge("err", "Lista no disponible", access.error || "");
    }

    if (!tabId) {
      showAccess(
        "Abrí https://tokintienda.com.ar/store en una pestaña e iniciá sesión, " +
        "y volvé a abrir el popup."
      );
      return;
    }
    const pong = await pingWithRetry(tabId);
    if (!pong || !pong.ok) {
      showAccess(
        "No se pudo conectar con la página del store. " +
        "Refrescá la pestaña de tokintienda.com.ar (F5) para recargar la extensión " +
        "y volvé a abrir el popup."
      );
      return;
    }
    ui.session = pong.session;
    $("#user-info").textContent = pong.session.email || "No logueado";
    if (!pong.session.email) {
      // Sesión de Tokin cerrada o vencida: se conservan los datos del pedido
      // hasta que el usuario toque «Reanudar» (el resultado final es parte de
      // la sesión abierta y no se pierde al cerrar o minimizar el popup).
      showAccess(
        "Iniciá sesión en el store de Tokin para usar la herramienta. " +
        "Tu pedido sigue guardado hasta que toques «Reanudar»."
      );
      return;
    }
    $("#cfg-session").textContent = "Tu email de sesión: " + pong.session.email;

    const granted = await checkCachedAccess(pong.session.email);
    if (granted) {
      // Ya fue autorizado en esta sesión: no volver a bloquear aunque la lista
      // remota tarde o falle. Mantener el acceso y restaurar el estado.
      ui.allowed = { ok: true, emails: (ui.allowed && ui.allowed.emails) || [], cached: true };
      setBadge("ok", "Autorizado", "Acceso ya verificado en esta sesión.");
      const ens = await toSw({ type: "ENSURE_OFFSCREEN" });
      if (ens && ens.ok) {
        const st = await toOff({ type: "GET_STATE" });
        if (st && st.ok) {
          applyState(st.state);
          if (!st.state || st.state.status === "idle") {
            await syncFromJob();
          }
        } else {
          await syncFromJob();
        }
      }
      return;
    }

    await checkAccess(pong.session.email);
    if (ui.allowed && ui.allowed.ok && isAllowed(pong.session.email, ui.allowed.emails)) {
      await grantAccess(pong.session.email);
      const ens = await toSw({ type: "ENSURE_OFFSCREEN" });
      if (!ens || !ens.ok) {
        setStatus("No se pudo iniciar el procesador de fondo: " + ((ens && ens.message) || "error"), "err");
        return;
      }
      const st = await toOff({ type: "GET_STATE" });
      if (st && st.ok) {
        // La sesión queda cargada tal como estaba aunque el popup se haya
        // cerrado o minimizado; solo «Reanudar» o «Terminar» limpian el
        // formulario.
        applyState(st.state);
        // v2.0.27: si la sesión del offscreen está vacía pero hay un lote vivo
        // en el store (corriendo o pausado), mostrar la tarea restaurada.
        if (!st.state || st.state.status === "idle") {
          await syncFromJob();
        }
      } else {
        await syncFromJob();
      }
    }
  }

  function showAccess(msg) {
    $("#main-screen").classList.add("hidden");
    $("#access-screen").classList.remove("hidden");
    $("#access-msg").textContent = msg;
  }

  async function checkAccess(email) {
    if (!ui.allowed || !ui.allowed.ok) {
      showAccess(
        "No se pudo verificar la lista de usuarios (sin internet y sin copia guardada). " +
        "La extensión no se abre por seguridad."
      );
      return;
    }
    if (isAllowed(email, ui.allowed.emails)) {
      setBadge("ok", "Autorizado");
      return;
    }
    showAccess(
      "Tu usuario (" + email + ") no está en la lista de emails autorizados. " +
      "Contactá al administrador para habilitar el acceso."
    );
  }

  // ------------------------------------------------------------- archivo

  function initDropzone() {
    const dz = $("#dropzone");
    const fi = $("#file-input");

    fi.addEventListener("change", () => {
      const file = fi.files && fi.files[0];
      fi.value = "";
      if (file) handleFile(file);
    });

    dz.addEventListener("click", () => {
      const st = ui.sessionState;
      if (st && (st.status === "parsing" || st.status === "loading_cart")) return;
      try {
        // Selector desde el propio popup: no se pierde foco, la ingesta y el
        // resultado quedan en el mismo popup abierto.
        fi.click();
      } catch (e) {
        openPicker();
      }
    });
    dz.addEventListener("dragover", (e) => {
      e.preventDefault();
      dz.classList.add("dragover");
    });
    dz.addEventListener("dragleave", () => dz.classList.remove("dragover"));
    dz.addEventListener("drop", (e) => {
      e.preventDefault();
      dz.classList.remove("dragover");
      const file = e.dataTransfer.files && e.dataTransfer.files[0];
      if (file) handleFile(file);
    });
  }

  async function openPicker() {
    const tab = await getStoreTab();
    if (!tab || !tab.id) {
      setStatus("Abrí tokintienda.com.ar/store en una pestaña para elegir el archivo.", "warn");
      return;
    }
    setStatus("Abriendo el selector de archivos…");
    const ens = await toSw({ type: "ENSURE_OFFSCREEN" });
    if (!ens || !ens.ok) {
      setStatus("No se pudo iniciar el procesador de fondo.", "err");
      return;
    }
    const res = await sendTab(tab.id, { type: "SHOW_PICKER" });
    if (!res || !res.ok) {
      setStatus((res && res.message) || "No se pudo abrir el selector de archivos.", "err");
    } else {
      setStatus("Elegí el archivo del pedido en la ventana de Tokin.");
    }
  }

  async function handleFile(file) {
    setStatus("Enviando " + file.name + ".");
    $("#file-name").textContent = file.name;
    $("#file-name").classList.add("big");
    $("#dropzone").classList.add("has-file");
    try {
      const ens = await toSw({ type: "ENSURE_OFFSCREEN" });
      if (!ens || !ens.ok) {
        setStatus("No se pudo despertar el procesador de fondo.", "err");
        return;
      }
      const buffer = await file.arrayBuffer();
      const res = await toOff({ type: "PARSE", filename: file.name, b64: bufferToB64(buffer) });
      if (!res || !res.ok) {
        setStatus((res && res.message) || "No se pudo iniciar el procesamiento.", "err");
        return;
      }
      // El offscreen transmite STATE/PROGRESS: la UI se actualiza sola.
    } catch (e) {
      setStatus("Error al enviar: " + (e && e.message ? e.message : e), "err");
    }
  }

  async function cancelar() {
    // La carga al carrito (status "loading_cart") se cancela DIRECTAMENTE contra
    // el store vía background: durante un lote largo Chrome puede cerrar el
    // offscreen y un CANCEL que viaje por él se pierde, dejando la carga andando
    // sin freno. toSw(CANCEL_CART) persiste la clave tokinCartCancel (el content
    // script aborta en su próximo chequeo, o al bootear si está navegando) y la
    // reenvía a la pestaña, aunque el offscreen no exista.
    const st0 = await toOff({ type: "GET_STATE" });
    // No fiarse solo del offscreen: si Chrome lo reinició, su estado puede ser
    // "idle" aunque haya un lote en marcha. Detectar la fase también por el job
    // persistido y por el estado que el popup ya tenía renderizado.
    const jobd0 = await new Promise((r) => chrome.storage.local.get(JOB_KEY, (x) => r(x || {})));
    const inCart =
      !!jobd0[JOB_KEY] ||
      (st0 && st0.ok && st0.state && st0.state.status === "loading_cart") ||
      (ui.sessionState && ui.sessionState.status === "loading_cart");
    try { console.log("[Tokin] cancelar: status offscreen=" + (st0 && st0.ok ? (st0.state && st0.state.status) : "sin respuesta") + " job=" + !!jobd0[JOB_KEY] + " inCart=" + inCart); } catch (e) {}
    if (inCart) {
      setStatus("Cancelando la carga del carrito…", "warn");
      // Reenviar el CANCEL un par de veces: si la pestaña está navegando entre
      // líneas, un único mensaje puede perderse en el hueco de navegación (la
      // clave persistida lo cubre igual al bootear).
      for (let i = 0; i < 3; i++) {
        const r = await toSw({ type: "CANCEL_CART" });
        if (i < 2) await new Promise((r2) => setTimeout(r2, 600));
      }
      // Esperar la señal REAL de fin: el offscreen asienta "canceled" con el
      // reporte parcial, o el job desaparece (la carga se detuvo). Nunca pintar
      // un "cancelado" falso mientras el store sigue agregando.
      for (let i = 0; i < 24; i++) {
        await new Promise((r) => setTimeout(r, 500));
        const st = await toOff({ type: "GET_STATE" });
        if (st && st.ok && st.state && st.state.status === "canceled") {
          applyState(st.state);
          return;
        }
        const jobd = await new Promise((r) => chrome.storage.local.get(JOB_KEY, (x) => r(x || {})));
        const job = jobd[JOB_KEY];
        if (!job || job.phase === "done") {
          const st1 = await toOff({ type: "GET_STATE" });
          if (st1 && st1.ok && st1.state && st1.state.status === "canceled") {
            applyState(st1.state);
            return;
          }
          setStatus(
            "Carga detenida — lo cargado quedó en el carrito del store. El reporte parcial no se generó porque el procesador de fondo estaba cerrado.",
            "warn"
          );
          return;
        }
      }
      setStatus("El store sigue procesando la línea actual; se detiene en el próximo corte.", "warn");
      return;
    }
    // Etapas de ingesta (parsing/parsed): el CANCEL frena el proceso en el
    // offscreen (el content script aborta la carga y deja el reporte parcial).
    await toOff({ type: "CANCEL" });
    for (let i = 0; i < 10; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const st = await toOff({ type: "GET_STATE" });
      if (st && st.ok && st.state && st.state.status === "canceled") {
        applyState(st.state);
        return;
      }
    }
    const st = await toOff({ type: "GET_STATE" });
    if (st && st.ok) applyState(st.state);
    setStatus("Operación cancelada.", "warn");
  }

  // ------------------------------------------------------------- carrito

  async function armarCarrito() {
    const tab = await getStoreTab();
    if (!tab || !tab.id) {
      setStatus("Abrí el store de Tokin en una pestaña para cargar el carrito.", "err");
      return;
    }
    if (!ui.lineItems || !ui.lineItems.length) {
      setStatus("No hay líneas de pedido para cargar.", "warn");
      return;
    }
    setAction("cancelCart");
    setStatus("Cargando carrito…");
    await toOff({ type: "UPDATE_LINE_ITEMS", items: ui.lineItems });
    const res = await toOff({ type: "ADD_TO_CART" });
    if (!res || !res.ok) {
      setStatus((res && res.message) || "El store no respondió.", "err");
      setAction("cart");
    }
  }

  async function abrirStore() {
    const tab = await getStoreTab();
    if (tab && tab.id && tab.url) {
      chrome.tabs.update(tab.id, { active: true });
      await new Promise((r) => setTimeout(r, 600));
      sendTab(tab.id, { type: "OPEN_CART" });
    } else {
      chrome.tabs.create({ url: "https://tokintienda.com.ar/store" });
    }
  }

  // Clasificación honesta del estado de una línea a partir de su mensaje.
  // Antes era un regex genérico /unidad/i que etiquetaba "ERROR UNIDAD" hasta
  // la falta de stock ("el store solo tiene N unidades..."). Ahora cada caso
  // real tiene su estado propio.
  function estadoDe(r) {
    const msg = String((r && r.message) || "");
    if (r && r.ok && msg.indexOf("agregado") === 0) {
      // La línea quedó en el carrito; si quedó con menos cantidad de la pedida
      // (tope del store / "máximo de unidades permitida") se anota el faltante.
      return /falta de unidades para completar stock/.test(msg) ? "FALTA UNIDADES" : "CARGADO";
    }
    if (/sin stock|por falta de stock|no alcanza para|solo tiene\s+\d+\s+(unidad|unidades|un|uds|display|displays|bulto|bultos)|stock max/i.test(msg)) {
      return "SIN STOCK";
    }
    if (/no se encontr/.test(msg)) return "NO ENCONTRADO";
    if (/no se pudo convertir|supera el límite/i.test(msg)) return "ERROR UNIDAD";
    // v2.0.57: no existe "sin confirmar": al cierre toda línea sin card en el
    // carrito es un fallo real ("NO CARGADO"), nunca un estado intermedio.
    if (/no cargado/.test(msg)) return "NO CARGADO";
    return "NO CARGADO";
  }

  function estadoCounts(results) {
    const res = results || [];
    const added = res.filter((r) => !!r && r.ok && String(r.message || "").indexOf("agregado") === 0);
    return {
      added: added.length,
      faltaUnidades: added.filter((r) => /falta de unidades para completar stock/.test(String(r.message || ""))).length,
      sinStock: res.filter((r) => estadoDe(r) === "SIN STOCK").length,
      notFound: res.filter((r) => estadoDe(r) === "NO ENCONTRADO").length,
    };
  }

  // Excel de cierre (v2.0.40): 2 hojas:
  // 1) "Reporte General": todos los ítems (#, SKU, Producto, Cant, Unidad, Estado, Diagnóstico).
  // 2) "Faltantes y Observados": ítems no cargados con columnas de detalle adicionales.
  function descargarExcel() {
    const allItems = (ui.cart && ui.cart.allLineItems) || ui.lineItems || [];
    const results = ((ui.cart && ui.cart.results) || []).slice();
    const baseName = (ui.cart && ui.cart.docName) || "informe";
    const counts = estadoCounts(results);
    const added = counts.added;
    const sinStock = counts.sinStock;
    const notFound = counts.notFound;
    const isAdded = (r) => !!r && r.ok && String(r.message || "").indexOf("agregado") === 0;
    const isPartial = (r) => /falta de unidades para completar stock/.test(String((r && r.message) || ""));
    // v2.0.58: igual que el informe, la cifra principal es lo verificado en el
    // carrito real (productos únicos), no las líneas del pedido.
    const headN = (ui.cart && ui.cart.prodAdded != null) ? ui.cart.prodAdded : added;
    const headM = (ui.cart && ui.cart.totalProducts) || results.length;
    const summaryStr = `Pedido cargado: ${headN} de ${headM} productos del pedido | Sin stock: ${sinStock} | No encontrados: ${notFound}` +
      (counts.faltaUnidades ? " | Falta unidades: " + counts.faltaUnidades : "");

    // 1. Hoja 1: REPORTE GENERAL — 7 columnas simples
    const genHeaders = ["#", "Código SKU", "Producto Solicitado", "Cant. Pedida", "Unidad Pedida", "Estado", "Diagnóstico Detallado"];
    const generalAoa = [];
    generalAoa.push([summaryStr]);
    generalAoa.push(genHeaders);

    let cleanIdx = 0;
    // v2.0.60: en el reporte RECUPERADO (offscreen cerrado, sintetizado desde
    // tokinCartReport) no hay allLineItems: las filas se arman desde los
    // resultados del bloque, que traen producto/mensaje/unidad.
    const recovered = !allItems.length && Array.isArray(results) && results.some(Boolean);
    const src = recovered ? results.filter(Boolean) : allItems;
    const recRow = (r, i) => ({
      nro: r.nro || r.itemNro || (i + 1),
      sku: r.sku || r.code || "",
      producto: r.producto || "",
      cantidad: r.qty != null ? r.qty : (r.quantity != null ? r.quantity : ""),
      unidad: r.usedUnit || "",
      r,
    });
    src.forEach((it, i) => {
      const r = recovered ? it : (results[i] || {});
      if (!(it.producto || it.sku || "").trim()) return;
      cleanIdx++;
      const row = recovered ? recRow(it, i) : {
        nro: it.nro || (i + 1),
        sku: it.sku || "",
        producto: it.producto || "",
        cantidad: it.cantidad || "1",
        unidad: it.categoria || it.unidad || "",
        r,
      };
      const estado = estadoDe(r);
      // v2.0.73: fila separadora de LOTE cuando empieza un bloque nuevo de 19
      // (por nro de ingesta), reconocible en la planilla como «Lote N».
      if (row.nro && (row.nro - 1) % GROUP === 0) {
        generalAoa.push(["LOTE " + (Math.floor((row.nro - 1) / GROUP) + 1), "", "", "", "", "", "— pedido realizado"]);
      }
      generalAoa.push([
        row.nro,
        String(row.sku || "N/A"),
        String(row.producto || ""),
        String(row.cantidad || "1"),
        String(row.unidad || ""),
        estado,
        String(r.message || (isAdded(r) ? "Cargado correctamente al carrito" : "Sin mensaje de respuesta"))
      ]);
    });

    // 2. Hoja 2: FALTANTES Y OBSERVADOS — 9 columnas con detalle del store
    const pendHeaders = ["#", "Código SKU", "Producto Solicitado", "Cant. Pedida", "Unidad Pedida", "Estado", "Producto Matcheado (Store)", "Unidad Usada", "Diagnóstico Detallado"];
    const pendingAoa = [];
    pendingAoa.push([summaryStr]);
    pendingAoa.push(pendHeaders);

    let pendIdx = 0;
    (recovered ? results.filter(Boolean) : allItems).forEach((it, i) => {
      const r = recovered ? it : (results[i] || {});
      // v2.0.57: las líneas cargadas PARCIALMENTE ("falta de unidades para
      // completar stock") van en la hoja de observados: están en el carrito per
      //o faltan unidades y el usuario debe revisarlas.
      if (isAdded(r) && !isPartial(r)) return;
      if (!(it.producto || it.sku || "").trim()) return;
      pendIdx++;
      const unidad = recovered ? (r.usedUnit || "") : (it.categoria || it.unidad || "");
      const estado = estadoDe(r);
      const diagExtra =
        (r.convFactor > 0 ? " | factor conv: " + r.convFactor + " (pedido " + r.usedUnit + ")" : "") +
        (r.storeButtons ? " | botones card: " + r.storeButtons : "");

      const nroPend = recovered ? (r.nro || pendIdx) : (it.nro || pendIdx);
      // v2.0.73: separador de lote también en la hoja de faltantes/observados.
      if (nroPend && (nroPend - 1) % GROUP === 0) {
        pendingAoa.push(["LOTE " + (Math.floor((nroPend - 1) / GROUP) + 1), "", "", "", "", "", "", "", "— pedido realizado"]);
      }
      pendingAoa.push([
        nroPend,
        String(recovered ? (r.sku || "") : (it.sku || "N/A")),
        String(recovered ? (r.sku || "") : (it.sku || "N/A")),
        String(it.producto || ""),
        String(recovered ? (r.qty || "") : (it.cantidad || "1")),
        String(unidad || ""),
        estado,
        String(r.storeName || r.storeText || "N/A"),
        String(r.usedUnit || unidad || "N/A"),
        String(r.message || "Sin mensaje de respuesta") + diagExtra
      ]);
    });

    try {
      const wb = XLSX.utils.book_new();
      const wsGeneral = XLSX.utils.aoa_to_sheet(generalAoa);
      const wsPending = XLSX.utils.aoa_to_sheet(pendingAoa);

      wsGeneral["!cols"] = [{ wch: 4 }, { wch: 14 }, { wch: 42 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 65 }];
      wsPending["!cols"] = [{ wch: 4 }, { wch: 14 }, { wch: 42 }, { wch: 12 }, { wch: 14 }, { wch: 16 }, { wch: 42 }, { wch: 14 }, { wch: 65 }];

      XLSX.utils.book_append_sheet(wb, wsGeneral, "Reporte General");
      XLSX.utils.book_append_sheet(wb, wsPending, "Faltantes y Observados");

      const name = "Reporte_Autotokin_" + String(baseName).replace(/[\\/:*?"<>|]+/g, "_").replace(/\.(xlsx|xls|csv|pdf|docx)$/i, "") || "Reporte_Autotokin_informe";
      XLSX.writeFile(wb, name + ".xlsx");
      setStatus("Excel detallado descargado: " + name + ".xlsx", "ok");
    } catch (e) {
      setStatus("No se pudo generar el Excel: " + String((e && e.message) || e), "err");
    }
  }

  async function terminar() {
    const res = await toOff({ type: "CLEAR" });
    // «Terminar» (igual que «Reanudar») es de las únicas dos acciones que
    // vacían el carrito del store: la carga cancelada o terminada deja lo
    // cargado intacto hasta que el usuario decide cerrar la sesión.
    const tab = await getStoreTab();
    if (tab && tab.id) {
      try { await sendTab(tab.id, { type: "EMPTY_CART" }); } catch (e) {}
    }
    resetUi();
    setStatus(
      (res && res.ok ? "Sesión terminada, carrito vaciado y datos limpiados. " : "") + "Cargá un archivo para empezar.",
      res && res.ok ? "ok" : "warn"
    );
  }

  async function reanudar() {
    // v2.0.65: «Reanudar» = «Terminar»: detiene cualquier ejecución, vacía el
    // carrito y deja la herramienta en CERO, siempre — sin excepcion de job
    // "paused": la reanudacion silenciosa de una tarea pausada era la puerta
    // por la que una sesion vieja volvia a correr y pisaba cantidades/lineas
    // del pedido nuevo (líneas "que el PDF no pide" y cantidades reaplicadas).
    const res = await new Promise((r) => chrome.storage.local.get(JOB_KEY, (x) => r(x || {})));
    const job = res[JOB_KEY];
    if (job && job.phase && job.phase !== "done") {
      const tab = await getStoreTab();
      // Lote vivo (pending/searching/paused): detenerlo antes de vaciar el
      // carrito, asi no vuelve a escribir despues del vaciado. El CLEAR del
      // offscreen (mas abajo) borra ademas el job y el reporte del storage
      // local para que nada reviva al recargar.
      setStatus("Deteniendo la carga en curso…", "");
      try { await toSw({ type: "CANCEL_CART" }); } catch (e) {}
      // Esperar a que el lote aborte de verdad (el content script borra el job
      // en el próximo corte) antes de vaciar el carrito, para no vaciarlo en
      // pleno agregado. Si en ~8s no confirmó, vaciar igual (best effort).
      for (let w = 0; w < 16; w++) {
        await new Promise((r) => setTimeout(r, 500));
        const jobd = await new Promise((r) => chrome.storage.local.get(JOB_KEY, (x) => r(x || {})));
        if (!jobd[JOB_KEY]) break;
      }
      // CANCEL + CLEAR borran el job apenas el content script/o el offscreen lo
      // procesen; si en este punto sigue, no confiar en que no escriba de
      // nuevo y forzar borrado local antes de vaciar el carrito.
      const still = await new Promise((r) => chrome.storage.local.get(JOB_KEY, (x) => r(x || {})));
      if (tab && tab.id && !still[JOB_KEY]) {
        for (let k = 0; k < 3; k++) {
          const er = await sendTab(tab.id, { type: "EMPTY_CART" });
          if (er && er.ok) break;
          await new Promise((r) => setTimeout(r, 700));
        }
      }
      await toOff({ type: "CLEAR" });
      resetUi();
      setStatus("Carga detenida y carrito vaciado. Cargá un archivo para empezar.", "ok");
      return;
    }
    await toOff({ type: "CLEAR" });
    resetUi();
    // Vaciar el carrito del store también si no hay job activo.
    const tab = await getStoreTab();
    if (tab && tab.id) {
      try { await sendTab(tab.id, { type: "EMPTY_CART" }); } catch (e) {}
    }
    setStatus("Formulario limpio. Cargá un archivo para empezar.", "ok");
  }

  function resetUi() {
    ui.sessionState = null;
    ui.lineItems = [];
    ui.cart = null;
    $("#items-box").innerHTML = "";
    $("#cart-results-final").innerHTML = "";
    $("#done-summary").textContent = "";
    $("#file-name").textContent = "";
    $("#file-name").classList.remove("big");
    $("#dropzone").classList.remove("has-file");
    resetPanels();
    setStatus("Tocá la zona o arrastrá el archivo del pedido (Excel, PDF o DOCX).");
  }

  // ------------------------------------------------------------- settings

  function initSettings() {
    $("#btn-settings").addEventListener("click", async () => {
      $("#settings-overlay").classList.remove("hidden");
      try {
        const access = await getAllowedUsers(true);
        ui.allowed = access;
        if (access && access.ok) {
          setBadge("ok", "Lista OK", (access.warning || "").toString());
        } else {
          setBadge("err", "Lista no disponible", (access && access.error) || "");
        }
      } catch (e) {
        ui.allowed = { ok: false, error: String((e && e.message) || e) };
        setBadge("err", "Lista no disponible", String((e && e.message) || e));
      }
    });
    $("#btn-close-settings").addEventListener("click", () => {
      $("#settings-overlay").classList.add("hidden");
    });
    $("#btn-refresh-list").addEventListener("click", async () => {
      setStatus("Refrescando pestaña del store y reactivando la herramienta…", "");
      let access;
      try {
        access = await getAllowedUsers(true);
      } catch (e) {
        access = { ok: false, error: String((e && e.message) || e) };
      }
      ui.allowed = access;
      if (access && access.ok) {
        setBadge("ok", "Lista OK", access.warning || "");
      } else {
        setBadge("err", "Lista no disponible", (access && access.error) || "");
      }
      // v2.0.56: además de refrescar la lista, se recarga la pestaña del store
      // para que el content script re-aplique la sesión y la lista de acceso.
      const storeTab = await getStoreTab();
      if (!storeTab || !storeTab.id) {
        setStatus(access && access.ok ? "Lista actualizada. No se encontró la pestaña del store." : "No se pudo actualizar ni encontrar la pestaña del store.", "warn");
        return;
      }
      try {
        chrome.tabs.reload(storeTab.id, {}, () => { void chrome.runtime.lastError; });
      } catch (e) {}
      // v2.0.60: esperar a que el content script vuelva a estar listo tras el
      // reload (hasta ~15s: el reload repinta la pestaña) en lugar de dejar la
      // herramienta muerta hasta un segundo clic / reapertura del popup.
      let pong = null;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 500));
        pong = await pingTab(storeTab.id);
        if (pong && pong.ok) break;
      }
      if (!(pong && pong.ok)) {
        setStatus(access && access.ok
          ? "Lista actualizada. La pestaña del store se recargó; volvé a abrir el popup."
          : "No se pudo conectar con la pestaña del store tras el refresco.", "warn");
        return;
      }
      ui.session = pong.session;
      const email = (pong.session && pong.session.email) || "";
      $("#user-info").textContent = email || "No logueado";
      if (!email) {
        setStatus("Sesión del store no detectada tras el refresco. Iniciá sesión en Tokin.", "warn");
        return;
      }
      if (!(access && access.ok)) {
        setStatus("Sesión OK pero sin lista de acceso. Intentá de nuevo en unos segundos.", "warn");
        return;
      }
      if (isAllowed(email, access.emails)) {
        await grantAccess(email);
        // Reactivar en el MISMO clic: asegurar el offscreen y restaurar la
        // sesión (o la tarea del store si hay un lote vivo), sin pedir pasos
        // extras.
        const ens = await toSw({ type: "ENSURE_OFFSCREEN" });
        if (ens && ens.ok) {
          const st = await toOff({ type: "GET_STATE" });
          if (st && st.ok && st.state && st.state.status !== "idle") {
            applyState(st.state);
          } else {
            await syncFromJob();
          }
        }
        $("#access-screen").classList.add("hidden");
        $("#main-screen").classList.remove("hidden");
        setBadge("ok", "Autorizado");
        setStatus("Información refrescada. La herramienta quedó activa.", "ok");
      } else {
        await revokeAccess();
        setBadge("err", "No autorizado");
        setStatus("Tu usuario aún no está en la lista.", "err");
      }
    });
  }

  // ------------------------------------------------------------- bind

  function bind() {
    $("#btn-cancel").addEventListener("click", cancelar);
    $("#btn-cart").addEventListener("click", armarCarrito);
    $("#btn-cancel-cart").addEventListener("click", cancelar);
    $("#btn-open-store").addEventListener("click", abrirStore);
    $("#btn-excel").addEventListener("click", descargarExcel);
    $("#btn-clear").addEventListener("click", terminar);
    $("#btn-reset").addEventListener("click", reanudar);
    $("#items-box").addEventListener("dblclick", (e) => {
      const td = e.target && e.target.closest ? e.target.closest("td[data-field]") : null;
      if (td) startCellEdit(td);
    });
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.target === "popup") {
      if (msg.type === "PROGRESS") setStatus(msg.message, "");
      else if (msg.type === "STATE") applyState(msg.state);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  initDropzone();
  initSettings();
  bind();
  // Al abrir (o reabrir tras minimizar/cambiar de pestaña o ventana) restaura
  // la sesión: el reporte final sigue en pantalla, el cartelito verde de
  // acceso arriba y el usuario abajo.
  init();
})();

