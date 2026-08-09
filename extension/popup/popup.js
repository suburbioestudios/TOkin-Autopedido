// Tokin AutoPedido - popup logic (100% local, sin servidor, sin OAuth)
// El popup solo muestra y dirige: el procesamiento (OCR) y la carga al carrito
// corren en el documento offscreen, que sigue vivo aunque este popup se cierre
// al minimizar la pestaña. Al reabrir, se restaura la sesión desde allí.
import { parseDocument, mapFields, summarize } from "../core/agent.js";
import { getAllowedUsers, isAllowed } from "../core/access.js";
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
    showEl("#btn-cancel", which === "cancel");
    showEl("#btn-cart", which === "cart");
    showEl("#btn-cancel-cart", which === "cancelCart");
    showEl("#btn-open-store", which === "done");
    showEl("#btn-clear", which === "done");
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
    if (st.status === "parsed" || st.status === "done") return "ok";
    if (st.status === "canceled") return "warn";
    return "";
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

    if (st.status === "parsing") {
      resetPanels();
      setAction("cancel");
      setStatus(st.progress || "Procesando…", "");
      if (st.filename) {
        $("#file-name").textContent = st.filename;
        $("#file-name").classList.add("big");
        $("#dropzone").classList.add("has-file");
      }
    } else if (st.status === "parsed") {
      resetPanels();
      renderItems();
      showEl("#items-box", true);
      setAction(ui.lineItems.length ? "cart" : "none");
      setStatus(
        "Pedido reconocido: " + ui.lineItems.length + " líneas. Revisá las filas y tocá «Enviar a carrito».",
        "ok"
      );
    } else if (st.status === "loading_cart") {
      showEl("#items-box", true);
      showEl("#done-summary", false);
      showEl("#cart-results-final", false);
      showEl("#done-hint", false);
      setAction("cancelCart");
      renderCartItems(st.cartProgress, st.cart && st.cart.total);
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
        setAction("cart");
        renderDone(st);
        const c = st.cart || { ok: 0, total: 0 };
        setStatus("Carga cancelada: " + (c.ok || 0) + " de " + (c.total || 0) + " en el carrito.", "warn");
      } else {
        resetPanels();
        setStatus(st.progress || "Proceso cancelado.", "warn");
      }
    } else if (st.status === "error") {
      resetPanels();
      setStatus(st.error || st.progress || "Ocurrió un error.", "err");
      if (st.step === 3 && ui.lineItems.length) {
        showEl("#items-box", true);
        setAction("cart");
      }
    }
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
      const unidad = it.categoria || it.unidad || "";
      html +=
        "<tr>" +
        '<td class="mono">' + (i + 1) + "</td>" +
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
    const res = results || [];
    if (!res.length) {
      box.innerHTML = '<p class="hint">Cargando…</p>';
      return;
    }
    const ok = res.filter((r) => r.ok).length;
    let html =
      '<p class="hint">Agregados al carrito: ' + ok + " de " + res.length + ". Revisá el carrito en el store para confirmar.</p>";
    html += res
      .map((r) => {
        const cls = r.ok ? "ok" : "err";
        return '<div class="cart-row ' + cls + '"><b>' + esc(r.producto) + "</b><span>" + esc(r.message) + "</span></div>";
      })
      .join("");
    box.innerHTML = html;
  }

  function renderCartItems(progress, total) {
    const box = $("#items-box");
    const list = ui.lineItems || [];
    const done = progress && typeof progress.index === "number" ? progress.index : -1;
    const count = Math.min(done + 1, total || list.length);
    if (total || list.length) {
      setStatus("Cargando carrito (" + count + " de " + (total || list.length) + ")…", "");
    }
    const remaining = list
      .map((it, i) => ({ it, n: i + 1 }))
      .filter((r) => r.n - 1 > done);
    if (!remaining.length) {
      box.innerHTML = "";
      return;
    }
    let html = '<table><thead><tr><th>#</th><th>Producto</th><th>Cant.</th><th>Unidad</th></tr></thead><tbody>';
    remaining.forEach((r) => {
      const unidad = r.it.categoria || r.it.unidad || "";
      html +=
        "<tr>" +
        '<td class="mono">' + r.n + "</td>" +
        "<td>" + esc(r.it.producto) + "</td>" +
        "<td>" + esc(r.it.cantidad) + "</td>" +
        "<td>" + esc(unidad) + "</td>" +
        "</tr>";
    });
    html += "</tbody></table>";
    box.innerHTML = html;
  }

  function renderDone(st) {
    const c = (st && st.cart) || ui.cart || { results: [], total: 0, ok: 0 };
    const wasCanceled = st && st.status === "canceled";
    let html = wasCanceled
      ? "Carga cancelada. Lo que alcanzó a procesarse quedó en el carrito del store."
      : "El pedido quedó cargado en el carrito del store.";
    if (c.docName) html += "\nDocumento procesado: " + c.docName + ".";
    if (c.total) html += "\nLíneas: " + c.ok + " de " + c.total + ".";
    $("#done-summary").textContent = html;
    renderCartResults(c.results, $("#cart-results-final"));
  }

  // ------------------------------------------------------------- init

  async function init() {
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

    await checkAccess(pong.session.email);
    if (ui.allowed && ui.allowed.ok && (await isAllowed(pong.session.email, ui.allowed.hashes))) {
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
    if (await isAllowed(email, ui.allowed.hashes)) {
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
    setStatus("Enviando " + file.name + "…");
    $("#file-name").textContent = file.name;
    $("#file-name").classList.add("big");
    $("#dropzone").classList.add("has-file");
    try {
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
    await toOff({ type: "CANCEL" });
    setStatus("Cancelando…");
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
    } else {
      chrome.tabs.create({ url: "https://tokintienda.com.ar/store" });
    }
  }

  async function terminar() {
    const res = await toOff({ type: "CLEAR" });
    resetUi();
    setStatus(
      (res && res.ok ? "Sesión terminada y datos limpiados. " : "") + "Cargá un archivo para empezar.",
      res && res.ok ? "ok" : "warn"
    );
  }

  async function reanudar() {
    await toOff({ type: "CLEAR" });
    resetUi();
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
      let access;
      try {
        access = await getAllowedUsers(true);
      } catch (e) {
        access = { ok: false, error: String((e && e.message) || e) };
      }
      ui.allowed = access;
      if (access && access.ok) {
        setBadge("ok", "Lista OK", access.warning || "");
        setStatus("Acceso actualizado.", "ok");
        let email = ui.session && ui.session.email;
        if (!email) {
          const tab = await getStoreTab();
          if (tab && tab.id) {
            const pong = await pingWithRetry(tab.id, 3);
            if (pong && pong.ok) {
              ui.session = pong.session;
              email = pong.session.email || "";
            }
          }
        }
        if (email) {
          if (await isAllowed(email, ui.allowed.hashes)) {
            $("#access-screen").classList.add("hidden");
            $("#main-screen").classList.remove("hidden");
            setBadge("ok", "Autorizado");
            setStatus("Acceso habilitado. Podés usar la herramienta.", "ok");
          } else {
            setBadge("err", "No autorizado");
            setStatus("Tu usuario aún no está en la lista.", "err");
          }
        } else {
          setStatus("No se detectó tu sesión del store. Refrescá la pestaña del store (F5) e intentá de nuevo.", "warn");
        }
      } else {
        setBadge("err", "Lista no disponible", access.error || "");
        setStatus(access.error || "No se pudo actualizar el acceso.", "err");
      }
    });
  }

  // ------------------------------------------------------------- bind

  function bind() {
    $("#btn-cancel").addEventListener("click", cancelar);
    $("#btn-cart").addEventListener("click", armarCarrito);
    $("#btn-cancel-cart").addEventListener("click", cancelar);
    $("#btn-open-store").addEventListener("click", abrirStore);
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
  init();
  if (new URLSearchParams(location.search).get("debug") === "1") {
    window.__TOKIN_UI__ = { applyState, renderCartItems, openPicker };
  }
})();

// Hook de depuracion para tests automatizados (solo con ?debug=1).
if (new URLSearchParams(location.search).get("debug") === "1") {
  window.__TOKIN_CORE__ = {
    parseDocument, mapFields, summarize,
    getAllowedUsers, isAllowed,
    ocrProbe: async () => {
      const out = { steps: [], tesseract: !!window.Tesseract };
      if (!window.Tesseract) return out;
      const base = chrome.runtime.getURL("lib/tesseract/");
      let worker = null;
      try {
        out.steps.push("createWorker");
        worker = await window.Tesseract.createWorker({
          workerBlobURL: false,
          workerPath: base + "worker.min.js",
          corePath: base + "tesseract-core.wasm.js",
          langPath: base + "lang/",
          logger: () => {},
        });
        out.steps.push("created");
        out.steps.push("loadLanguage");
        await worker.loadLanguage("spa");
        out.steps.push("language_ok");
        out.steps.push("initialize");
        await worker.initialize("spa");
        out.steps.push("init_ok");
      } catch (e) {
        out.error = String((e && e.stack) || e);
      } finally {
        if (worker) { try { await worker.terminate(); } catch (e) {} }
      }
      return out;
    },
    pdfInfo: async (b64) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const pdfjs = window.pdfjsLib;
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
      const pdf = await pdfjs.getDocument({ data }).promise;
      const out = [];
      for (let i = 1; i <= pdf.numPages; i++) {
        const page = await pdf.getPage(i);
        const v = page.getViewport({ scale: 1 });
        const tc = await page.getTextContent();
        out.push({ page: i, w: Math.round(v.width), h: Math.round(v.height), items: tc.items.length });
      }
      return out;
    },
    renderPdfPage: async (b64, pageNum, scale) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const pdfjs = window.pdfjsLib;
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
      const pdf = await pdfjs.getDocument({ data }).promise;
      const page = await pdf.getPage(pageNum);
      const vp = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      return canvas.toDataURL("image/png");
    },
    ocrPdfPage: async (b64, pageNum, scale, proc, rotation) => {      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const pdfjs = window.pdfjsLib;
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
      const pdf = await pdfjs.getDocument({ data }).promise;
      const page = await pdf.getPage(pageNum);
      const vp = page.getViewport({ scale, rotation: rotation || 0 });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      if (proc) {
        const ctx = canvas.getContext("2d");
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const d = img.data;
        if (proc === "gray") {
          for (let i = 0; i < d.length; i += 4) {
            const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            d[i] = d[i + 1] = d[i + 2] = y;
          }
        } else if (proc === "bw") {
          let sum = 0, n = 0;
          for (let i = 0; i < d.length; i += 4) {
            sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            n++;
          }
          const th = sum / n;
          for (let i = 0; i < d.length; i += 4) {
            const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
            const v = y < th ? 0 : 255;
            d[i] = d[i + 1] = d[i + 2] = v;
          }
        }
        ctx.putImageData(img, 0, 0);
      }
      let worker = null;
      try {
        worker = await window.Tesseract.createWorker({
          workerBlobURL: false,
          workerPath: chrome.runtime.getURL("lib/tesseract/worker.min.js"),
          corePath: chrome.runtime.getURL("lib/tesseract/tesseract-core.wasm.js"),
          langPath: chrome.runtime.getURL("lib/tesseract/lang/"),
          logger: () => {},
        });
        await worker.loadLanguage("spa");
        await worker.initialize("spa");
        const { data: d } = await worker.recognize(canvas.toDataURL("image/png"));
        return { w: vp.width, h: vp.height, len: (d.text || "").length, conf: d.confidence, sample: (d.text || "").slice(0, 400) };
      } finally {
        if (worker) { try { await worker.terminate(); } catch (e) {} }
      }
    },
    ocrAllPages: async (b64) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const pdfjs = window.pdfjsLib;
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
      const pdf = await pdfjs.getDocument({ data }).promise;
      const out = [];
      let worker = null;
      try {
        worker = await window.Tesseract.createWorker({
          workerBlobURL: false,
          workerPath: chrome.runtime.getURL("lib/tesseract/worker.min.js"),
          corePath: chrome.runtime.getURL("lib/tesseract/tesseract-core.wasm.js"),
          langPath: chrome.runtime.getURL("lib/tesseract/lang/"),
          logger: () => {},
        });
        await worker.loadLanguage("spa");
        await worker.initialize("spa");
        for (let i = 1; i <= pdf.numPages; i++) {
          const page = await pdf.getPage(i);
          const vp = page.getViewport({ scale: 2 });
          const canvas = document.createElement("canvas");
          canvas.width = vp.width;
          canvas.height = vp.height;
          console.log("ocrAllPages render page", i);
          await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
          console.log("ocrAllPages recognize page", i);
          const { data: d } = await worker.recognize(canvas.toDataURL("image/png"));
          out.push({ page: i, len: (d.text || "").length });
          canvas.width = 0;
          canvas.height = 0;
          console.log("ocrAllPages done page", i, "len", (d.text || "").length);
        }
      } finally {
        if (worker) { try { await worker.terminate(); } catch (e) {} }
      }
      return out;
    },
    ocrPdfWords: async (b64, pageNum, scale, rotation) => {
      const data = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const pdfjs = window.pdfjsLib;
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
      const pdf = await pdfjs.getDocument({ data }).promise;
      const page = await pdf.getPage(pageNum);
      const vp = page.getViewport({ scale, rotation: rotation || 0 });
      const canvas = document.createElement("canvas");
      canvas.width = vp.width;
      canvas.height = vp.height;
      await page.render({ canvasContext: canvas.getContext("2d"), viewport: vp }).promise;
      let worker = null;
      try {
        worker = await window.Tesseract.createWorker({
          workerBlobURL: false,
          workerPath: chrome.runtime.getURL("lib/tesseract/worker.min.js"),
          corePath: chrome.runtime.getURL("lib/tesseract/tesseract-core.wasm.js"),
          langPath: chrome.runtime.getURL("lib/tesseract/lang/"),
          logger: () => {},
        });
        await worker.loadLanguage("spa");
        await worker.initialize("spa");
        const { data: d } = await worker.recognize(canvas.toDataURL("image/png"));
        const words = (d.words || []).map((w) => ({ t: w.text, x0: w.bbox.x0, y0: w.bbox.y0, x1: w.bbox.x1, y1: w.bbox.y1 }));
        canvas.width = 0;
        canvas.height = 0;
        return { w: vp.width, h: vp.height, words: words.slice(0, 2500) };
      } finally {
        if (worker) { try { await worker.terminate(); } catch (e) {} }
      }
    },
  };
}
