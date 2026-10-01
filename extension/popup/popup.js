// Tokin AutoPedido - popup logic (100% local, sin servidor, sin OAuth)
// El popup solo muestra y dirige: el procesamiento (OCR) y la carga al carrito
// corren en el documento offscreen, que sigue vivo aunque este popup se cierre
// al minimizar la pestaña. Al reabrir, se restaura la sesión desde allí.
import { parseDocument, mapFields, summarize } from "../core/agent.js";
// v2.0.87: ya no se usa el control de acceso por mail. Queda el import solo por
// isAllowed, que hoy siempre da true y sirve de guarda si se reintrodujera.
import { isAllowed } from "../core/access.js";
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
    // v2.0.82: correcciones que el cliente escribe sobre las filas de
    // "Requiere revisión manual", por nro de línea del pedido. Sobreviven a los
    // re-renders del popup (la sesión los reemite) y se envían al offscreen
    // cuando el cliente pide la tanda de ajustes.
    manualEdits: {},
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

  // v2.0.87: el popup se auto-repara en vez de pedirle un F5 al usuario. El
  // content script falta por dos motivos y ambos se resuelven acá:
  //
  //   1) La extensión se recargó (o se instaló) con la pestaña del store YA
  //      abierta: Chrome no re-inyecta los content scripts de las pestañas
  //      vivas, así que PING no tiene a quién responderle.
  //   2) Quedó una instancia huérfana de una versión anterior. El content
  //      script se autoprotege con el atributo data-tokin-ap en <html> para no
  //      duplicar el carrito, y esa marca NO se va con la extensión: al
  //      reinyectar, la nueva instancia ve la marca, avisa por consola y se
  //      retira. Por eso hay que borrar la marca antes de inyectar, o el popup
  //      seguiría sin poder conectarse aunque el script se cargara.
  async function selfHealStore(tabId) {
    const pong0 = await pingTab(tabId);
    if (pong0 && pong0.ok) return pong0;

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          document.documentElement.removeAttribute("data-tokin-ap");
        },
      });
    } catch (e) {
      // sin permiso de scripting sobre esa pestaña: seguimos al reintento
    }
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"],
      });
    } catch (e) {
      return null;
    }
    // La inyección es asíncrona respecto del listener: hay que darle margen.
    for (let i = 0; i < 12; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const pong = await pingTab(tabId);
      if (pong && pong.ok) return pong;
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
    // v2.0.82: con el pedido terminado el botón NO desaparece: si quedaron
    // líneas sin cargar, se rearma para la tanda de ajustes manuales.
    const esTandaManual = which === "doneManual";
    showEl("#btn-open-store", which === "done" || which === "blocks" || esTandaManual);
    showEl("#btn-excel", which === "done" || which === "blocks" || which === "error" || esTandaManual);
    showEl("#btn-clear", which === "done" || which === "blocks" || esTandaManual);
  }

  // v2.0.67: el flujo es automático de punta a punta (lotes de 19 + checkout
  // por lote) y arranca con UNA sola pulsación: el botón siempre dice
  // "Enviar al carrito", sin importar cuántas líneas queden.
  function updateCartBtn() {
    const btn = $("#btn-cart");
    if (!btn) return;
    // v2.0.82: si el pedido ya terminó con líneas sin cargar, el mismo botón
    // pasa a la tanda de ajustes manuales (dice cuántas son) para que el
    // cliente no tenga que adivinar un segundo flujo.
    const man = manualCount();
    const esTanda = !!(ui.sessionState && ui.sessionState.status === "done" && man > 0);
    btn.textContent = esTanda ? "Enviar ajustes manuales (" + man + ")" : "Enviar al carrito";
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
      renderDone(st);
      // v2.0.82: si quedaron líneas fuera del carrito, el botón se rearma para
      // la tanda de ajustes manuales; si no, el pedido está cerrado.
      const c = st.cart || { ok: 0, total: 0 };
      setAction(manualCount() ? "doneManual" : "done");
      showEl("#btn-cart", manualCount() > 0);
      updateCartBtn();
      setStatus(
        "Pedido cargado en el carrito: " + (c.ok || 0) + " de " + (c.total || 0) + "." +
          (manualCount() ? " " + manualCount() + " línea(s) quedaron para revisión manual." : ""),
        manualCount() ? "warn" : "ok"
      );
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
      // v2.0.76: en estado de error el informe y el Excel deben seguir
      // teniendo salida (el usuario necesita bajar lo que pasó, no quedarse
      // sin datos porque el flujo falló en algún lote).
      const c = st.cart || ui.cart || { results: [], total: 0 };
      const hasData = (c && ((c.results && c.results.length) || (c.allLineItems && c.allLineItems.length)));
      resetPanels();
      setStatus(st.error || st.progress || "Ocurrió un error.", "err");
      if (hasData) {
        // Mantener la vista con lo que ya se procesó y el Excel a mano.
        showEl("#done-summary", true);
        showEl("#cart-results-final", true);
        renderDone(st);
        const act = "error";
        setAction(act);
        showEl("#btn-excel", true);
        showEl("#btn-clear", true);
      } else if (st.step === 3 && ui.lineItems.length) {
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

  // v2.0.82: una línea está CARGADA solo si su mensaje arranca con "agregado".
  // Todo lo demás (conversión no exacta, qty que el store no registró, sin
  // stock, no encontrado) quedó FUERA del carrito.
  function isCargada(r) {
    return !!(r && r.ok && String(r.message || "").indexOf("agregado") === 0);
  }

  // v2.0.84: SIN STOCK CONFIRMADO. El content script marca `confirmado` cuando el
  // producto quedó verificado por código flexible + nombre + gramaje y el store
  // no lo tiene (o tomó menos de lo pedido). Es un hecho del store, no una falla
  // de la extensión: entra al reporte como observación confirmada y NO se reabre
  // para ajuste manual, porque no hay nada que el cliente pueda cambiar.
  function esSinStockConfirmado(r) {
    return !!(r && r.confirmado === true && !isCargada(r));
  }

  // v2.0.84: RONDA MANUAL DEFINITIVA. Una línea que ya pasó por la tanda de
  // ajustes manuales tiene su resultado FINAL: si después de corregirla a mano
  // cae en sin stock o no encontrado, eso es lo que queda. No se abre una
  // segunda tanda para la misma línea.
  function esAjusteDefinitivo(r) {
    return !!(r && r.manualRound);
  }

  // v2.0.84: lo que efectivamente se puede corregir a mano. Fuera de la lista
  // quedan (a) los sin stock confirmados, que son un hecho del store, y (b) las  // líneas que ya pasaron por una tanda de ajuste, cuyo resultado es definitivo.
  function esPendienteDeAjuste(r) {
    return !isCargada(r) && !esSinStockConfirmado(r) && !esAjusteDefinitivo(r);
  }

  // v2.0.82: nro de línea del pedido de un resultado (el que se usa para
  // editar la línea correcta y para el Excel). Viene estampado por el content
  // script; si faltara, se cae al índice visible.
  function manualNro(r, i, cargadas) {
    const n = r && (r.nro != null ? r.nro : r.itemNro);
    return n != null ? Number(n) : (cargadas || 0) + (i || 0) + 1;
  }

  // Fila de revisión manual: motivo, qué se puede cargar a mano y los campos
  // editables (cantidad/unidad) con los que se reenvía SOLO esa línea.
  function renderManualRow(r, nro, idx) {
    const ed = ui.manualEdits[nro] || {};
    const qty = ed.cantidad != null ? ed.cantidad : (r.cantidad != null ? r.cantidad : "");
    const unit = ed.categoria != null ? ed.categoria : (r.unidad || "");
    const sug =
      r && r.sugQty > 0
        ? '<span class="manual-sug">Cargala a mano: ' + esc(r.sugQty) + " " + esc(r.sugUnit) +
          (r.sugTotal ? " (" + esc(r.sugTotal) + " " + esc(r.unidad || "unidad") + ")" : "") + "</span>"
        : "";
    const sinCodigo = !String((r && r.sku) || "").trim();
    return (
      '<div class="cart-row err manual-row" data-nro="' + esc(nro) + '" data-idx="' + (idx || 0) + '">' +
      '<b><span class="manual-nro">#' + esc(nro) + "</span> " + esc(r.producto || "") +
      (r.sku ? ' <span class="manual-sku">' + esc(r.sku) + "</span>" : "") + "</b>" +
      '<span class="manual-msg">' + esc(r.message || "") + "</span>" +
      sug +
      (sinCodigo
        ? '<span class="manual-sug">Sin código ARC: la extensión no la puede cargar, agregala a mano en el store.</span>'
        : '<span class="manual-edit">' +
          '<label>Cantidad<input class="m-qty" type="number" min="0" step="1" inputmode="numeric" value="' + esc(qty) + '"></label>' +
          '<label>Unidad<input class="m-unit" list="tokin-unidades" value="' + esc(unit) + '"></label>' +
          "</span>") +
      "</div>"
    );
  }

  // Payload para la tanda de ajustes: una entrada por línea no cargada, con lo
  // que el cliente haya corregido (si no corrige nada, se reintenta igual con los
  // valores del pedido).
  function manualPayload(manuales) {
    return manuales.map((r, i) => {
      const nro = manualNro(r, i, 0);
      const ed = ui.manualEdits[nro] || {};
      const rq = r.cantidad != null ? r.cantidad : "";
      const ru = r.unidad || "";
      return {
        nro: nro,
        producto: r.producto || "",
        sku: r.sku || "",
        cantidad: ed.cantidad != null ? ed.cantidad : rq,
        categoria: ed.categoria != null ? ed.categoria : ru,
      };
    });
  }

  function renderCartResults(results, box) {
    const res = (results || []).filter(Boolean);
    if (!res.length) {
      box.innerHTML = '<p class="hint">Cargando…</p>';
      return;
    }
    // v2.0.82: el informe se parte en dos: lo que quedó en el carrito (arriba, con
    // sus separadores de lote) y, AL FINAL, las líneas que no se cargaron bajo el
    // encabezado "Requiere revisión manual". Así el cliente ve la tarea terminada
    // y, debajo, exactamente lo que tiene que corregir a mano.
    const cargadas = res.filter(isCargada);
    const manuales = res.filter(esPendienteDeAjuste);
    let html =
      '<p class="hint">Agregados al carrito: ' + cargadas.length + " de " + res.length +
      (manuales.length
        ? '. <b class="manual-hint">' + manuales.length + " línea" + (manuales.length === 1 ? "" : "s") +
          " para revisión manual</b> (al final del informe)."
        : ". Revisá el carrito en el store para confirmar.") +
      "</p>";
    // v2.0.75: el reporte se divide en bloques con el separador de lote
    // en negrita y con el título que corresponde según si la compra se
    // confirmó de verdad (lotChecks del offscreen) o no.
    const checksRep = (ui.sessionState && ui.sessionState.lotChecks) || {};
    html += cargadas
      .map((r, i) => {
        const nro = (r && (r.nro != null ? r.nro : (r.itemNro != null ? r.itemNro : null))) || (i + 1);
        const blockN = Math.floor((nro - 1) / GROUP) + 1;
        const prev = cargadas[i - 1];
        const prevNro = (prev && (prev.nro != null ? prev.nro : (prev.itemNro != null ? prev.itemNro : i))) || i;
        const isFirstOfBlock =
          i === 0 || Math.floor((prevNro - 1) / GROUP) + 1 !== blockN;
        const okConf = checksRep && checksRep[String(blockN)];
        const sepTitle = okConf
          ? "LOTE " + blockN + " PEDIDO REALIZADO"
          : "LOTE " + blockN + " CARGADO EN CARRITO (SIN CONFIRMAR)";
        const sep = isFirstOfBlock
          ? '<div class="bloque-sep" style="font-weight:800;text-transform:uppercase;padding:8px 0;border-bottom:1px solid #cbd5e1;margin-top:10px">' + sepTitle + "</div>"
          : "";
        return sep + '<div class="cart-row ok"><b>' + esc(r.producto) + "</b><span>" + esc(r.message) + "</span></div>";
      })
      .join("");
    if (manuales.length) {
      html +=
        '<div class="manual-sep">Requiere revisión manual — ' + manuales.length +
        " línea" + (manuales.length === 1 ? "" : "s") +
        " no se cargaron al carrito</div>" +
        '<p class="hint">Revisá el motivo de cada una. Si el problema es la cantidad o la unidad, ' +
        "corregila acá y tocá «Enviar ajustes manuales»: se cargan solo estas líneas, sin tocar lo que ya quedó en el carrito.</p>" +
        '<datalist id="tokin-unidades"><option value="unidad"><option value="bulto"><option value="display">' +
        '<option value="caja"><option value="pack"><option value="par"></datalist>';
      html += manuales
        .map((r, i) => renderManualRow(r, manualNro(r, i, cargadas.length), i))
        .join("");
    }
    box.innerHTML = html;
    updateCartBtn();
  }

  // Cuántas líneas del informe actual quedan para la ronda manual. Cuenta sólo lo
  // que todavía se puede corregir: los sin stock confirmados ya son un hecho del
  // store y las que ya pasaron por una tanda manual tienen resultado definitivo,
  // así que en ambos casos el botón no ofrece una segunda vuelta.
  function manualCount() {
    const res = ((ui.cart && ui.cart.results) || []).filter(Boolean);
    return res.filter(esPendienteDeAjuste).length;
  }

  function renderCartItems(progress, total) {
    const box = $("#items-box");
    const list = ui.lineItems || [];
    const done = progress && typeof progress.index === "number" ? progress.index : -1;
    const cart = ui.cart || {};
    // v2.0.73: el bloque en proceso se calcula desde batchStart ABSOLUTO que
    // emite el offscreen (número de ingesta), no del índice del slice visible.
    const batchStart = (progress && typeof progress.batchStart === "number" && progress.batchStart >= 0)
      ? progress.batchStart
      : (typeof cart.batchStart === "number" ? cart.batchStart : 0);
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
    // Lotes ya REALIZADOS o no, con el texto correcto (v2.0.75):
    // «LOTE N PEDIDO REALIZADO» solo si el checkout de ese lote quedó
    // confirmado de verdad por el offscreen (lotChecks). En negrita y
    // mayúsculas, acumulados en la parte superior mientras avanza el proceso.
    const checks = (ui.sessionState && ui.sessionState.lotChecks) || (ui.lotChecks) || {};
    const lotTitle = (n) => {
      const checked = checks && checks[String(n)];
      if (checked) return "LOTE " + n + " PEDIDO REALIZADO";
      return "LOTE " + n + " CARGADO EN CARRITO (SIN CONFIRMAR)";
    };
    // Lotes que ya cerraron su ciclo (anteriores al bloque en curso).
    let htmlLots = "";
    for (let b = 1; b < curBlock; b++) {
      const cls = checks && checks[String(b)] ? "ok" : "warn";
      htmlLots += '<tr class="bloque ' + cls + '" style="font-weight:700;text-transform:uppercase;"><td colspan="4">' + lotTitle(b) + "</td></tr>";
    }
    // Lotes terminados primero (cada uno su OWN fila de la tabla) y luego la
    // tabla del bloque en curso con su encabezado.
    let html = htmlLots ? "<table><tbody>" + htmlLots + "</tbody></table>" : "";
    if (!rest.length) {
      box.innerHTML = html;
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
    // v2.0.82: lo que quedó fuera del carrito se anuncia arriba también, no
    // solo en el listado: el cliente tiene que enterarse de que el pedido NO
    // terminó y que hay algo que hacer.
    const man = ((c.results || []).filter(Boolean) || []).filter(esPendienteDeAjuste).length;
    if (man) parts.push("Requiere revisión manual: " + man);
    const def = ((c.results || []).filter(Boolean) || []).filter((r) => esAjusteDefinitivo(r) && !isCargada(r)).length;
    if (def) parts.push("Definitivos tras ajuste manual: " + def + " (sin segunda ronda)");
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
      cart: { total: job.total || 0, docName: job.docName || "", batchStart: Array.isArray(job.batchIdx) && job.batchIdx.length ? job.batchIdx[0] : 0, batchTotal: job.items ? job.items.length : 0 },
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
      // v2.0.82: la foto del carrito y la memoria de grupos viajan al popup para
      // que el Excel final se arme completo aunque el offscreen haya muerto.
      carrito: report.carrito || [],
      grupos: report.grupos || {},
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
      grupos: report.grupos || {},
      lotChecks: report.lotChecks || {},
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
    // v2.0.87: el job vivo es una RUPTURA real del proceso (se perdio al
    // cerrar el popup, caerse la señal o.reload del store). Si se puede
    // recuperar, se avisa; si no, se deja el estado de error que yahdiga
    // syncFromJob. La reanudacion silenciosa por senal (solo recargar la
    // extension) no pasa por aca y por eso no dispara cartel.
    const ok = await syncFromJob();
    if (ok) setStatus("Restaurando Información activa.", "ok");
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
    await boot();
  }

  // v2.0.87: el arranque como función aparte, para que «Reintentar conexión»
  // pueda repetir exactamente los mismos pasos (incluida la autorreparación
  // del content script) sin tener que cerrar y reabrir el popup.
  async function boot() {
    const tab = await getStoreTab();
    const tabId = tab && tab.id;

    // v2.0.87: ya no se descarga ni espera la lista de emails. La carga era un
    // fetch a GitHub que, sin señal, delaysba el arranque del popup y terminaba
    // en la pantalla de acceso aunque la sesión del store estuviera bien. Ahora
    // solo importa que haya una pestaña del store con sesión iniciada.
    ui.allowed = { ok: true, emails: [], cached: true };

    if (!tabId) {
      showAccess(
        "Abrí https://tokintienda.com.ar/store en una pestaña e iniciá sesión, " +
        "y volvé a abrir el popup.",
        "Falta la pestaña del store"
      );
      return;
    }
    // v2.0.87: primero se reintenta el ping y, si no hay respuesta, el popup se
    // auto-repara inyectando el content script (ya no hace falta el F5 manual).
    let pong = await pingWithRetry(tabId);
    if (!pong || !pong.ok) pong = await selfHealStore(tabId);
    if (!pong || !pong.ok) {
      showAccess(
        "No se pudo conectar con la página del store. " +
        "Tocá «Reintentar conexión»: la extensión se reinstala sola en esa pestaña.",
        "No se pudo conectar con el store"
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
        "Tu pedido sigue guardado hasta que toques «Reanudar».",
        "Falta iniciar sesión en el store"
      );
      return;
    }
    $("#cfg-session").textContent = "Tu email de sesión: " + pong.session.email;

    // v2.0.87: se elimina el factor de autorización por mail. Antes había que
    // estar en la lista remota (allowed_users.json) y su ausencia bloqueaba con
    // "Sesión OK pero sin lista de acceso". Ahora cualquier sesión iniciada en
    // el store entra directo: no hay lista que verificar ni que refrescar.
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

  function showAccess(msg, title) {
    $("#main-screen").classList.add("hidden");
    $("#access-screen").classList.remove("hidden");
    $("#access-msg").textContent = msg;
    // v2.0.87: el título por defecto ya no es "Acceso restringido" porque no hay
    // lista de usuarios: el bloqueo real es la conexión o la sesión del store.
    $("#access-title").textContent = title || "Conectar con el store";
    $("#access-badge").textContent = "—";
  }

  // v2.0.87: sin lista de emails. Queda solo la sesión del store como requisito;
  // si no hay sesión, el mensaje es el de login (lo llama init). Se conserva la
  // función para no romper otros callers.
  async function checkAccess(email) {
    if (!email) {
      showAccess(
        "Iniciá sesión en el store de Tokin para usar la herramienta. " +
        "Tu pedido sigue guardado hasta que toques «Reanudar»."
      );
      return;
    }
    setBadge("ok", "Autorizado");
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
    // v2.0.82: pedido terminado con líneas sin cargar → TANDA DE AJUSTES
    // MANUALES. Se reenvían solo esas, con lo que el cliente corrigió, sin
    // tocar lo que ya quedó en el carrito (no se duplican productos).
    // v2.0.84: es la ÚNICA ronda. Sólo entran las líneas que de verdad se pueden
    // corregir: los sin stock confirmados son un hecho del store y, para todo lo
    // que salga de esta tanda, el resultado que quede es el definitivo aunque siga
    // sin cargarse.
    const st = ui.sessionState || {};
    const res = ((ui.cart && ui.cart.results) || []).filter(Boolean);
    const manuales = res.filter(esPendienteDeAjuste);
    if (st.status === "done" && manuales.length) {
      setAction("cancelCart");
      setStatus("Cargando los ajustes manuales… (ronda única: lo que quede es el resultado final)");
      const r = await toOff({ type: "START_MANUAL_BATCH", items: manualPayload(manuales) });
      if (!r || !r.ok) {
        setStatus((r && r.message) || "No se pudo cargar la tanda manual.", "err");
        setAction("doneManual");
        showEl("#btn-cart", true);
        updateCartBtn();
      } else if (r.message) {
        setStatus(r.message, "warn");
      }
      return;
    }
    if (!ui.lineItems || !ui.lineItems.length) {
      setStatus("No hay líneas de pedido para cargar.", "warn");
      return;
    }
    setAction("cancelCart");
    setStatus("Cargando carrito…");
    await toOff({ type: "UPDATE_LINE_ITEMS", items: ui.lineItems });
    const res2 = await toOff({ type: "ADD_TO_CART" });
    if (!res2 || !res2.ok) {
      setStatus((res2 && res2.message) || "El store no respondió.", "err");
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
  function estadoBase(r) {
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
    // v2.0.82: "revisión manual" es el estado explícito de todo lo que quedó
    // fuera del carrito por no pasar las comprobaciones (conversión no exacta,
    // nombre/gramaje distintos, cantidad que el store no registró). El cliente
    // lo ve con el motivo y la carga sugerida, no como un error seco.
    if (/revisión manual/i.test(msg) || (r && r.manual)) return "REVISIÓN MANUAL";
    if (/no se pudo convertir|supera el límite/i.test(msg)) return "REVISIÓN MANUAL";
    // v2.0.57: no existe "sin confirmar": al cierre toda línea sin card en el
    // carrito es un fallo real ("NO CARGADO"), nunca un estado intermedio.
    if (/no cargado/.test(msg)) return "NO CARGADO";
    return "NO CARGADO";
  }

  // v2.0.84: el estado que se muestra y se escribe en el Excel. Se le antepone
  // "DEFINITIVO" a toda línea que ya pasó por una tanda de ajuste manual y no
  // quedó cargada: su resultado es el final y no hay una segunda vuelta. Y los
  // sin stock confirmados se marcan como tales, que es lo que los hace entrar al
  // reporte como observación firme y no como pendiente de corregir.
  function estadoDe(r) {
    const base = estadoBase(r);
    if (base === "CARGADO") return base;
    if (esSinStockConfirmado(r)) return "SIN STOCK CONFIRMADO";
    if (esAjusteDefinitivo(r)) return "DEFINITIVO · " + base;
    return base;
  }

  function estadoCounts(results) {
    const res = results || [];
    const added = res.filter(isCargada);
    return {
      added: added.length,
      // v2.0.82: solo para reconocer sesiones viejas; la versión actual nunca
      // reporta una línea parcial como cargada.
      faltaUnidades: added.filter((r) => /falta de unidades para completar stock|agregado parcial/.test(String(r.message || ""))).length,
      sinStock: res.filter((r) => estadoBase(r) === "SIN STOCK").length,
      sinStockConfirmado: res.filter(esSinStockConfirmado).length,
      notFound: res.filter((r) => estadoBase(r) === "NO ENCONTRADO").length,
      // v2.0.82: todo lo que no quedó cargado y necesita una decisión del
      // cliente (conversión, match o cantidad que el store no tomó).
      manual: res.filter((r) => estadoBase(r) === "REVISIÓN MANUAL").length,
      // v2.0.84: lo que queda realmente editable a mano: sin stock confirmados y
      // resultados definitivos ya quedan afuera.
      pendienteAjuste: res.filter(esPendienteDeAjuste).length,
      definitivos: res.filter((r) => esAjusteDefinitivo(r) && !isCargada(r)).length,
    };
  }

  // v2.0.84: Excel de cierre con 2 hojas, como pidió el cliente:
  // 1) "Reporte General": todas las líneas del pedido, agrupadas por BLOQUE de
  //    compra (los lotes 1..N y las tandas de ajuste manual A1..An al final, que
  //    es el orden real en que se hizo cada compra), con "Cargó en" y
  //    "Cant. cargada".
  // 2) "Faltantes y Observados": todo lo que no quedó cargado, ALSO ordenado por
  //    bloques e incluyendo las líneas corregidas a mano y los sin stock
  //    confirmados.
  // Lo que sobra (foto del carrito por bloque) no se pierde: queda anotado en el
  // separador de cada bloque, así el Excel sigue diciendo si ese momento de
  // compra quedó verificado.
  async function descargarExcel() {
    // v2.0.76: si el popup perdió la sesión (error / refresh / el offscreen se
    // cerró) el intento usa el último reporte persistido en storage.local; así
    // NUNCA se va a "hay que descargar pero no hay datos".
    if (!(ui.cart && ui.cart.results && ui.cart.results.length)) {
      try {
        const saved = await new Promise((r) => chrome.storage.local.get("tokinCartReport", (x) => r(x && x.tokinCartReport)));
        if (saved && (saved.results && saved.results.length || saved.allLineItems && saved.allLineItems.length || saved.done)) {
          ui.cart = ui.cart || {};
          ui.cart.results = saved.results || [];
          if (!ui.cart.allLineItems && saved.allLineItems) ui.cart.allLineItems = saved.allLineItems;
          if (!ui.cart.docName && saved.docName) ui.cart.docName = saved.docName;
          if (ui.cart.prodAdded == null && saved.prodAdded != null) ui.cart.prodAdded = saved.prodAdded;
          if (ui.cart.totalProducts == null && saved.totalProducts != null) ui.cart.totalProducts = saved.totalProducts;
          if (saved.lotChecks) {
            if (!ui.sessionState) ui.sessionState = { lotChecks: saved.lotChecks };
            else ui.sessionState.lotChecks = saved.lotChecks;
          }
          // v2.0.82: la memoria de grupos (con la foto del carrito previa a cada
          // checkout) y la foto del último bloque permiten armar el Excel final
          // aunque el offscreen ya haya muerto.
          if (saved.grupos) {
            if (!ui.sessionState) ui.sessionState = { lotChecks: {} };
            if (!ui.sessionState.grupos) ui.sessionState.grupos = saved.grupos;
          }
          if (saved.carrito && !ui.cart.carrito) ui.cart.carrito = saved.carrito;
        }
      } catch (e) {}
    }
    const allItems = (ui.cart && ui.cart.allLineItems) || ui.lineItems || [];
    const results = ((ui.cart && ui.cart.results) || []).slice();
    const baseName = (ui.cart && ui.cart.docName) || "informe";
    const counts = estadoCounts(results);
    const added = counts.added;
    const sinStock = counts.sinStock;
    const notFound = counts.notFound;
    const isAdded = isCargada;
    // v2.0.82: desde la versión actual NADA parcial se reporta como cargado (el
    // producto sale del carrito y la línea va a revisión manual). isPartial se
    // mantiene solo para reconocer sesiones/reportes viejos, que pueden venir
    // con líneas "agregado parcial: …" de versiones anteriores.
    const isPartial = (r) => /falta de unidades para completar stock|agregado parcial/.test(String((r && r.message) || ""));
    // v2.0.58: igual que el informe, la cifra principal es lo verificado en el
    // carrito real (productos únicos), no las líneas del pedido.
    const headN = (ui.cart && ui.cart.prodAdded != null) ? ui.cart.prodAdded : added;
    const headM = (ui.cart && ui.cart.totalProducts) || results.length;
    // v2.0.84: el encabezado separa lo que es un HECHO del store de lo que todavía
    // se puede corregir, que es lo que pidió el cliente: los sin stock confirmados
    // no son pendientes (no hay nada que ajustar) y las líneas que ya pasaron por
    // una tanda manual tienen resultado definitivo.
    const resueltas = results.filter((r) => r && r.manualRound && isAdded(r)).length;
    const pendientes = results.filter((r) => r && !isAdded(r)).length;
    const resumenMan = results.filter((r) => r && r.manualRound).length;
    const summaryStr = `Pedido cargado: ${headN} de ${headM} productos del pedido | Pendientes: ${pendientes} | Resueltas con ajuste manual: ${resueltas}` +
      (resumenMan ? ` (ajustes manuales: ${resumenMan} líneas)` : "") +
      ` | Sin stock: ${sinStock} (confirmados: ${counts.sinStockConfirmado}) | No encontrados: ${notFound}` +
      (counts.definitivos ? " | Definitivos tras ajuste manual: " + counts.definitivos : "") +
      (counts.faltaUnidades ? " | Falta unidades: " + counts.faltaUnidades : "") +
      (counts.pendienteAjuste ? " | Ajustables a mano: " + counts.pendienteAjuste : " | Ajustables a mano: 0 (no hay segunda ronda)");
    // v2.0.79: el mapeo de lotes se declara acá, ANTES de las hojas. Estaba
    // dentro del primer forEach y se usaba en el segundo → ReferenceError que
    // mataba la generación del Excel sin bajar nada ("no aparece el informe").
    const checksXls = (ui.sessionState && ui.sessionState.lotChecks) || {};
    // v2.0.82: grupos (foto del carrito por momento de compra) y utilidades para
    // saber en qué grupo se resolvió cada línea.
    const gruposXls = (ui.sessionState && ui.sessionState.grupos) || (ui.cart && ui.cart.grupos) || {};
    const grupoDe = (r, nro) => {
      if (r && r.grupo) return String(r.grupo);
      const n = Number(nro) || 0;
      return n >= 1 ? String(Math.floor((n - 1) / GROUP) + 1) : "1";
    };
    // Los lotes van 1..N y las tandas manuales A1..An al final, que es el
    // orden real en que se hizo cada compra.
    const ordenGrupo = (g) => {
      const s = String(g);
      if (/^\d+$/.test(s)) return parseInt(s, 10);
      const m = /^A(\d+)$/i.exec(s);
      return 1000 + (m ? parseInt(m[1], 10) : 0);
    };
    const etiquetaGrupo = (g) => (/^\d+$/.test(String(g)) ? "LOTE " + g : "AJUSTES MANUALES " + g);
    const estadoCompra = (g) => {
      const gr = gruposXls[g];
      if (!gr && !checksXls[g]) return "— estado de compra desconocido";
      const conf = gr ? !!gr.confirmado : !!checksXls[g];
      return conf ? "PEDIDO REALIZADO" : "CARGADO EN CARRITO (SIN CONFIRMAR)";
    };
    // v2.0.84: la foto del carrito por bloque era una hoja propia y con el Excel
    // de 2 hojas dejó de serlo, pero la evidencia no se pierde: el separador de
    // cada bloque dice si ese momento de compra quedó verificado y con cuántas
    // líneas/productos. Si el store no dejó leer el carrito, se dice explícito.
    const separadorGrupo = (g) => {
      const gr = gruposXls[g] || {};
      const foto = Array.isArray(gr.foto) ? gr.foto : [];
      let txt = "— " + estadoCompra(g);
      if (gr.manual) txt += " · tanda de ajustes manuales";
      if (gr.checkouts > 1) txt += " · " + gr.checkouts + " checkouts";
      if (gr.fecha) txt += " · " + fechaXls(gr.fecha);
      if (foto.length) {
        txt += " · foto del carrito: " + foto.length + " producto" + (foto.length === 1 ? "" : "s") + " verificados";
      } else if (gr.verificado === false || (gr.verificado != null && !gr.verificado)) {
        txt += " · carrito NO verificable en ese instante (el store no dejó leerlo)";
      } else {
        txt += " · sin foto del carrito";
      }
      return txt;
    };
    // "Cantidad cargada" en una sola celda, con su unidad (lo pidió el cliente
    // en vez de "Unidad Usada"). En lo que SÍ entró va la unidad que tomó el
    // store ("24 unidad"), y en lo que no entró la unidad PEDIDA ("0 caja" de las
    // 2 cajas que se pidieron): la unidad del store que falló queda en el
    // diagnóstico. La cantidad real la selló el offscreen al cerrar cada grupo; si
    // el reporte es viejo, se deriva de added/message.
    const cantCargadaDe = (r, uniPed) => {
      const rr = r || {};
      let n = Number(rr.cantCargada);
      if (!isFinite(n) || rr.cantCargada == null || rr.cantCargada === "") {
        const m = /agregado\s+(\d+)/i.exec(String(rr.message || ""));
        n = isAdded(rr) ? (m ? parseInt(m[1], 10) : (Number(rr.added) || 0)) : 0;
      }
      const u = String(
        (isAdded(rr) ? (rr.usedUnit || uniPed) : (uniPed || rr.usedUnit)) || ""
      ).trim();
      return String(n) + (u ? " " + u : "");
    };
    const fechaXls = (iso) => {
      if (!iso) return "—";
      const d = new Date(iso);
      if (isNaN(d.getTime())) return String(iso);
      const p = (x) => String(x).padStart(2, "0");
      return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    // 1. Hoja 1: REPORTE GENERAL — 9 columnas
    const genHeaders = ["#", "Código SKU", "Producto Solicitado", "Cant. Pedida", "Unidad Pedida", "Estado", "Cargó en", "Cant. cargada", "Diagnóstico Detallado"];
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
      cantidad: r.cantidad != null ? r.cantidad : (r.quantity != null ? r.quantity : (r.qty != null ? r.qty : "")),
      unidad: r.unidad || r.categoria || "",
      r,
    });
    // v2.0.82: las filas se arman por GRUPO y no por número de línea, para que el
    // separador sea un momento de compra real ("LOTE 3", "AJUSTES MANUALES A1")
    // y las líneas corregidas a mano queden agrupadas al final, en el orden en
    // que se hicieron los ajustes. Dentro de cada grupo mantiene el nro original.
    const filasGen = [];
    src.forEach((it, i) => {
      const r = recovered ? it : (results[i] || {});
      if (!(it.producto || it.sku || "").trim()) return;
      const row = recovered ? recRow(it, i) : {
        nro: it.nro || (i + 1),
        sku: it.sku || "",
        producto: it.producto || "",
        cantidad: it.cantidad || "1",
        unidad: it.categoria || it.unidad || "",
        r,
      };
      filasGen.push({ row: row, grupo: grupoDe(r, row.nro) });
    });
    filasGen.sort((a, b) => {
      const oa = ordenGrupo(a.grupo), ob = ordenGrupo(b.grupo);
      if (oa !== ob) return oa - ob;
      return (Number(a.row.nro) || 0) - (Number(b.row.nro) || 0);
    });
    let grupoActual = null;
    for (let i = 0; i < filasGen.length; i++) {
      cleanIdx++;
      const row = filasGen[i].row;
      const r = row.r;
      const estado = estadoDe(r);
      const g = filasGen[i].grupo;
      // Separador de grupo con el estado HONESTO de esa compra: «PEDIDO
      // REALIZADO» solo si el checkout confirmó; si no, «CARGADO EN CARRITO (SIN
      // CONFIRMAR)»; y si no hay dato, se dice que se desconoce.
      if (g !== grupoActual) {
        generalAoa.push([etiquetaGrupo(g), "", "", "", "", "", "", "", separadorGrupo(g)]);
        grupoActual = g;
      }
      generalAoa.push([
        row.nro,
        String(row.sku || "—"),
        String(row.producto || ""),
        String(row.cantidad || "1"),
        String(row.unidad || ""),
        estado,
        etiquetaGrupo(g),
        cantCargadaDe(r, row.unidad),
        String(r.message || (isAdded(r) ? "Cargado correctamente al carrito" : "Sin mensaje de respuesta")) +
          (r.manualRound ? " · corregido a mano en la tanda de ajustes A" + r.manualRound : "")
      ]);
    }

    // 2. Hoja 2: FALTANTES Y OBSERVADOS — todo lo que al final NO quedó cargado,
    // en el MISMO orden por bloques que el Reporte General (los lotes 1..N y al
    // final las tandas de ajustes manuales A1..An). Se recyclea filasGen, que ya
    // está ordenado y agrupado, así las dos hojas cuentan exactamente lo mismo.
    // Entra acá todo lo pendiente, incluidos los sin stock CONFIRMADOS (que son
    // un hecho del store, no algo que el cliente pueda corregir) y las líneas
    // corregidas a mano, cuyo resultado ya es definitivo.
    const pendHeaders = ["#", "Código SKU", "Producto Solicitado", "Cant. Pedida", "Unidad Pedida", "Estado", "Cargó en", "Producto Matcheado (Store)", "Cant. cargada", "Diagnóstico Detallado"];
    const pendingAoa = [];
    pendingAoa.push([summaryStr]);
    pendingAoa.push(pendHeaders);

    let pendIdx = 0;
    let pendGrupo = null;
    for (let i = 0; i < filasGen.length; i++) {
      const row = filasGen[i].row;
      const r = row.r;
      // Todo lo que NO quedó cargado con la cantidad pedida (sin stock, sin
      // stock confirmado, no encontrado, revisión manual) y, en sesiones viejas,
      // las que habrían quedado como carga parcial.
      if (isAdded(r) && !isPartial(r)) continue;
      pendIdx++;
      const g = filasGen[i].grupo;
      const unidad = row.unidad || r.unidad || r.categoria || r.usedUnit || "";
      const diagExtra =
        (r.convFactor > 0 ? " | factor conv: " + r.convFactor + " (pedido " + r.usedUnit + ")" : "") +
        (r.storeButtons ? " | botones card: " + r.storeButtons : "") +
        (r.usedUnit ? " | unidad elegida por el store: " + r.usedUnit : "") +
        (r.sugQty > 0 ? " | se puede cargar a mano: " + r.sugQty + " " + (r.sugUnit || "") +
          (r.sugTotal > 0 ? " (cubre " + r.sugTotal + " " + (r.unidad || "unidad") + ")" : "") : "") +
        (r.confirmado === true ? " | CONFIRMADO: el store no tiene el stock (producto verificado por código+nombre+gramaje), no requiere ajuste" : "") +
        (r.manualRound ? " | RESULTADO DEFINITIVO: ya se corrigió a mano en la tanda A" + r.manualRound + " y así terminó; no hay segunda ronda de ajuste" : "");
      if (g !== pendGrupo) {
        pendingAoa.push([etiquetaGrupo(g), "", "", "", "", "", "", "", "", separadorGrupo(g)]);
        pendGrupo = g;
      }
      pendingAoa.push([
        row.nro,
        String(row.sku || "—"),
        String(row.producto || ""),
        String(row.cantidad || "1"),
        String(unidad || ""),
        estadoDe(r),
        etiquetaGrupo(g),
        String(r.storeName || r.storeText || "—"),
        cantCargadaDe(r, unidad),
        String(r.message || "Sin mensaje de respuesta") + diagExtra
      ]);
    }
    if (!pendIdx) {
      pendingAoa.push(["(sin líneas pendientes: todo el pedido quedó cargado)"]);
    }

    try {
      const wb = XLSX.utils.book_new();
      const wsGeneral = XLSX.utils.aoa_to_sheet(generalAoa);
      const wsPending = XLSX.utils.aoa_to_sheet(pendingAoa);

      wsGeneral["!cols"] = [{ wch: 4 }, { wch: 14 }, { wch: 42 }, { wch: 12 }, { wch: 14 }, { wch: 18 }, { wch: 22 }, { wch: 16 }, { wch: 65 }];
      wsPending["!cols"] = [{ wch: 4 }, { wch: 14 }, { wch: 42 }, { wch: 12 }, { wch: 14 }, { wch: 20 }, { wch: 22 }, { wch: 42 }, { wch: 16 }, { wch: 80 }];

      XLSX.utils.book_append_sheet(wb, wsGeneral, "Reporte General");
      XLSX.utils.book_append_sheet(wb, wsPending, "Faltantes y Observados");

      const name = "Reporte_Autotokin_" + String(baseName).replace(/[\\/:*?"<>|]+/g, "_").replace(/\.(xlsx|xls|csv|pdf|docx)$/i, "") || "Reporte_Autotokin_informe";
      XLSX.writeFile(wb, name + ".xlsx");
      setStatus("Excel descargado: " + name + ".xlsx (2 hojas: Reporte General · Faltantes y Observados)", "ok");
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
    ui.manualEdits = {};
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

  // v2.0.87: los botones de la pantalla de conexión. Antes el popup dead-endaba
  // con un mensaje que le pedía al usuario un F5 manual; ahora se reintenta solo
  // (con reinstalación del content script) y, si no hay pestaña, se abre el store.
  function initConnect() {
    $("#btn-access-retry").addEventListener("click", async () => {
      const btn = $("#btn-access-retry");
      btn.disabled = true;
      btn.textContent = "Conectando…";
      try {
        const storeTab = await getStoreTab();
        if (!storeTab || !storeTab.id) {
          showAccess(
            "No hay ninguna pestaña de tokintienda.com.ar/store abierta. " +
            "Abrila con tu sesión iniciada y volvé a tocar «Reintentar conexión».",
            "Falta la pestaña del store"
          );
          return;
        }
        let pong = await pingWithRetry(storeTab.id);
        if (!pong || !pong.ok) pong = await selfHealStore(storeTab.id);
        if (!pong || !pong.ok) {
          setAccessMsg(
            "El store sigue sin responder. Recargá la pestaña del store con F5 y " +
            "totá el botón otra vez."
          );
          return;
        }
        await boot();
      } finally {
        btn.disabled = false;
        btn.textContent = "Reintentar conexión";
      }
    });
    $("#btn-access-store").addEventListener("click", async () => {
      try {
        await chrome.tabs.create({ url: "https://tokintienda.com.ar/store" });
      } catch (e) {}
    });
  }

  function setAccessMsg(msg) {
    $("#access-msg").textContent = msg;
  }

  function initSettings() {
    // v2.0.87: abrir Ajustes ya no descarga ninguna lista de emails.
    $("#btn-settings").addEventListener("click", async () => {
      $("#settings-overlay").classList.remove("hidden");
    });
    $("#btn-close-settings").addEventListener("click", () => {
      $("#settings-overlay").classList.add("hidden");
    });
    // v2.0.87: este botón ya no refresca la lista de emails (se eliminó el factor
    // de autorización), pero SÍ recarga la pestaña del store, que es lo que
    // sigue siendo necesario: recargar el content script y reconectar la sesión.
    $("#btn-refresh-list").addEventListener("click", async () => {
      const storeTab = await getStoreTab();
      if (!storeTab || !storeTab.id) {
        setStatus("No se encontró la pestaña del store.", "warn");
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
        setStatus("La pestaña del store se recargó; volvé a abrir el popup.", "warn");
        return;
      }
      ui.session = pong.session;
      const email = (pong.session && pong.session.email) || "";
      $("#user-info").textContent = email || "No logueado";
      if (!email) {
        setStatus("Sesión del store no detectada tras el refresco. Iniciá sesión en Tokin.", "warn");
        return;
      }
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
      setStatus("Información actualizada. La herramienta quedó activa.", "ok");
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
    // v2.0.82: correcciones de las filas de "Requiere revisión manual". Se
    // guardan por nro de línea (no por índice de la tabla) para que sigan
    // apuntando a la línea correcta aunque el informe se re-ordene o se
    // re-renderice; se envían al pulsar «Enviar ajustes manuales».
    $("#cart-results-final").addEventListener("input", (e) => {
      const inp = e.target;
      if (!inp || !inp.classList || (!inp.classList.contains("m-qty") && !inp.classList.contains("m-unit"))) return;
      const row = inp.closest ? inp.closest(".manual-row") : null;
      if (!row) return;
      const nro = Number(row.getAttribute("data-nro"));
      if (!nro) return;
      const ed = ui.manualEdits[nro] || (ui.manualEdits[nro] = {});
      if (inp.classList.contains("m-qty")) ed.cantidad = inp.value;
      else ed.categoria = inp.value;
      updateCartBtn();
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
  initConnect();
  initSettings();
  bind();
  // Al abrir (o reabrir tras minimizar/cambiar de pestaña o ventana) restaura
  // la sesión: el reporte final sigue en pantalla, el cartelito verde de
  // acceso arriba y el usuario abajo.
  init();
})();

