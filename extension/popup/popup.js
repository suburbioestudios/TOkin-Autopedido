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
    showEl("#btn-cancel", which === "cancel");
    showEl("#btn-cart", which === "cart");
    showEl("#btn-cancel-cart", which === "cancelCart");
    showEl("#btn-open-store", which === "done");
    showEl("#btn-excel", which === "done");
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
        showEl("#btn-excel", true);
        setAction("cart");
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
      setStatus(st.progress || "Tarea pausada — reanudá cuando tengas señal.", "warn");
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
    // "Agregado" = lo que REALMENTE quedó en el carrito (message empieza con
    // "agregado"); "sin stock" y "no se confirmó" no cuentan como cargados.
    const isAdded = (r) => r.ok && String(r.message || "").indexOf("agregado") === 0;
    const added = res.filter(isAdded).length;
    let html =
      '<p class="hint">Agregados al carrito: ' + added + " de " + res.length + ". Revisá el carrito en el store para confirmar.</p>";
    html += res
      .map((r) => {
        const cls = isAdded(r) ? "ok" : r.ok ? "warn" : "err";
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
    if (c.total) {
      html += "\nLíneas agregadas: " + c.ok + " de " + c.total + ".";
      if (c.prodAdded && c.prodAdded !== c.ok) {
        html += " En el carrito: " + c.prodAdded + " productos (hay líneas repetidas que se suman en una card).";
      }
    }
    const parts = [];
    if (c.sinStock) parts.push("Sin stock: " + c.sinStock);
    if (c.notFound) parts.push("No encontrados: " + c.notFound);
    if (c.notConfirmed) parts.push("Sin confirmar: " + c.notConfirmed);
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
      res = await new Promise((r) => chrome.storage.local.get(JOB_KEY, (x) => r(x || {})));
    } catch (e) {
      return false;
    }
    const job = res[JOB_KEY];
    if (job && job.phase && job.phase !== "done") {
      ui.synthFromJob = true;
      applyState(jobToState(job));
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

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[JOB_KEY]) return;
    // Solo maneja la vista cuando el popup está mostrando la vista sintetizada
    // o no tiene sesión activa; si hay sesión real del offscreen, ella manda.
    if (ui.synthFromJob || !ui.sessionState || ui.sessionState.status === "idle") {
      syncFromJob();
    }
  });

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
    // CANCEL frena el job: el content script aborta y VACÍA el carrito del
    // store, y el offscreen conserva el REPORTE PARCIAL (hasta dónde llegó) en
    // estado "canceled". No se limpia la sesión ni la UI: el reporte queda en
    // pantalla para que el usuario vea qué se cargó. La herramienta solo se
    // reinicia de cero con «Reanudar»/«Terminar».
    await toOff({ type: "CANCEL" });
    // Esperar a que el offscreen asiente el estado "canceled" (el content
    // script aborta y deja el reporte parcial) antes de pintarlo.
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
    setStatus("Carga cancelada — quedó el reporte parcial.", "warn");
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

  // Excel de cierre (v2.0.40): 2 hojas:
  // 1) "Reporte General": todos los ítems (#, SKU, Producto, Cant, Unidad, Estado, Diagnóstico).
  // 2) "Faltantes y Observados": ítems no cargados con columnas de detalle adicionales.
  function descargarExcel() {
    const allItems = (ui.cart && ui.cart.allLineItems) || ui.lineItems || [];
    const results = ((ui.cart && ui.cart.results) || []).slice();
    const baseName = (ui.cart && ui.cart.docName) || "informe";
    const isAdded = (r) => r && r.ok && String(r.message || "").indexOf("agregado") === 0;
    const added = results.filter(isAdded).length;
    const sinStock = results.filter((r) => !isAdded(r) && /sin stock/i.test(r.message || "")).length;
    const notFound = results.filter((r) => !isAdded(r) && /no se encontró/i.test(r.message || "")).length;
    const notConfirmed = results.filter((r) => !isAdded(r) && String(r.message || "").indexOf("no se confirmó") === 0).length;

    const summaryStr = `Pedido cargado: ${added} de ${results.length} | Sin stock: ${sinStock} | No encontrados: ${notFound} | Sin confirmar: ${notConfirmed}`;

    // 1. Hoja 1: REPORTE GENERAL — 7 columnas simples
    const genHeaders = ["#", "Código SKU", "Producto Solicitado", "Cant. Pedida", "Unidad Pedida", "Estado", "Diagnóstico Detallado"];
    const generalAoa = [];
    generalAoa.push([summaryStr]);
    generalAoa.push(genHeaders);

    let cleanIdx = 0;
    allItems.forEach((it, i) => {
      if (!(it.producto || it.sku || "").trim()) return;
      cleanIdx++;
      const r = results[i] || {};
      const unidad = it.categoria || it.unidad || "";
      let estado = "CARGADO";
      if (!isAdded(r)) {
        if (/sin stock/i.test(r.message || "")) estado = "SIN STOCK";
        else if (/no se encontró/i.test(r.message || "")) estado = "NO ENCONTRADO";
        else if (/unidad/i.test(r.message || "")) estado = "ERROR UNIDAD";
        else estado = "NO CARGADO";
      }
      generalAoa.push([
        cleanIdx,
        String(it.sku || "N/A"),
        String(it.producto || ""),
        String(it.cantidad || "1"),
        String(unidad || ""),
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
    allItems.forEach((it, i) => {
      const r = results[i] || {};
      if (isAdded(r)) return;
      if (!(it.producto || it.sku || "").trim()) return;
      pendIdx++;
      const unidad = it.categoria || it.unidad || "";
      let estado = "NO CARGADO";
      if (/sin stock/i.test(r.message || "")) estado = "SIN STOCK";
      else if (/no se encontró/i.test(r.message || "")) estado = "NO ENCONTRADO";
      else if (/unidad/i.test(r.message || "")) estado = "ERROR UNIDAD";

      pendingAoa.push([
        pendIdx,
        String(it.sku || "N/A"),
        String(it.producto || ""),
        String(it.cantidad || "1"),
        String(unidad || ""),
        estado,
        String(r.storeName || r.storeText || "N/A"),
        String(r.usedUnit || unidad || "N/A"),
        String(r.message || "Sin mensaje de respuesta")
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
    resetUi();
    setStatus(
      (res && res.ok ? "Sesión terminada y datos limpiados. " : "") + "Cargá un archivo para empezar.",
      res && res.ok ? "ok" : "warn"
    );
  }

  async function reanudar() {
    // v2.0.27: si hay una tarea activa o pausada en el store (job vivo), 
    // «Reanudar» RETOMA esa tarea; NO limpia el formulario. Antes hacía CLEAR
    // incondicional: con la tarea pausada por señal, el usuario tocaba
    // «Reanudar», el formulario quedaba vacío y la tarea seguía su curso en la
    // pestaña sin reflejo en el popup.
    const res = await new Promise((r) => chrome.storage.local.get(JOB_KEY, (x) => r(x || {})));
    const job = res[JOB_KEY];
    if (job && job.phase && job.phase !== "done") {
      const tab = await getStoreTab();
      if (!tab || !tab.id) {
        setStatus("Abrí tokintienda.com.ar/store para reanudar la tarea.", "warn");
        return;
      }
      setStatus("Reanudando la tarea en el store…", "");
      // Vaciar el carrito del store antes de reanudar para empezar limpio.
      await sendTab(tab.id, { type: "EMPTY_CART" });
      const pong = await sendTab(tab.id, { type: "TOKIN_RESUME_NUDGE" });
      if (!pong || !pong.ok) {
        // Sin content script (página de error tras el corte de señal):
        // recargar la pestaña reanuda el lote solo al bootear.
        try {
          chrome.tabs.reload(tab.id, {}, () => { void chrome.runtime.lastError; });
        } catch (e) {}
      }
      await syncFromJob();
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
          if (isAllowed(email, ui.allowed.emails)) {
            await grantAccess(email);
            $("#access-screen").classList.add("hidden");
            $("#main-screen").classList.remove("hidden");
            setBadge("ok", "Autorizado");
            setStatus("Acceso habilitado. Podés usar la herramienta.", "ok");
          } else {
            await revokeAccess();
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
})();

