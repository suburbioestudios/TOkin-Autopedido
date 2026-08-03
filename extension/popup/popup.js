// Tokin AutoPedido - popup logic (100% local, sin servidor, sin OAuth)
import { parseDocument, mapFields, summarize } from "../core/agent.js";
import { getMemory, setMapping, clearMemory } from "../core/memory.js";
import { getAllowedUsers, isAllowed } from "../core/access.js";
(function () {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const state = {
    doc: null,
    fields: [],
    mapping: [],
    session: null,
    allowed: null,
    currentTab: "extracted",
  };

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

  function getActiveTab() {
    return new Promise((resolve) => {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve(tabs[0]));
    });
  }

  function pingTab(tabId) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, { type: "PING" }, (res) => {
        if (chrome.runtime.lastError) return resolve(null);
        resolve(res);
      });
    });
  }

  function askTab(tabId, msg) {
    return new Promise((resolve) => {
      chrome.tabs.sendMessage(tabId, msg, (res) => {
        if (chrome.runtime.lastError) return resolve({ ok: false, message: chrome.runtime.lastError.message });
        resolve(res);
      });
    });
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  // ------------------------------------------------------------- init

  async function init() {
    const tab = await getActiveTab();
    const tabId = tab && tab.id;

    const access = await getAllowedUsers();
    state.allowed = access;
    if (access.ok) {
      setBadge(access.cached ? "ok" : "ok", "Lista OK", access.warning || "Usuarios autorizados cargados");
    } else {
      setBadge("err", "Lista no disponible", access.error || "");
    }

    if (!tabId) {
      showAccess("No hay pestaña activa.");
      return;
    }
    const pong = await pingTab(tabId);
    if (!pong || !pong.ok) {
      showAccess(
        "La extensión solo funciona en tokintienda.com.ar/store. " +
        "Abrí el store e iniciá sesión, y volvé a abrir el popup."
      );
      return;
    }
    state.session = pong.session;
    $("#user-info").textContent = pong.session.email || "No logueado";
    if (!pong.session.email) {
      showAccess("Iniciá sesión en el store de Tokin para usar la herramienta.");
      return;
    }
    $("#cfg-session").textContent = "Tu email de sesión: " + pong.session.email;

    await checkAccess(pong.session.email);
  }

  function showAccess(msg) {
    $("#main-screen").classList.add("hidden");
    $("#access-screen").classList.remove("hidden");
    $("#access-msg").textContent = msg;
  }

  async function checkAccess(email) {
    if (!state.allowed || !state.allowed.ok) {
      showAccess(
        "No se pudo verificar la lista de usuarios (sin internet y sin copia guardada). " +
        "La extensión no se abre por seguridad."
      );
      return;
    }
    if (await isAllowed(email, state.allowed.hashes)) {
      setBadge("ok", "Autorizado");
      return;
    }
    showAccess(
      "Tu usuario (" + email + ") no está en la lista de emails autorizados. " +
      "Contactá al administrador para habilitar el acceso."
    );
  }

  // ------------------------------------------------------------- tabs

  function switchTab(name) {
    document.querySelectorAll(".tab").forEach((b) => {
      b.classList.toggle("active", b.dataset.tab === name);
    });
    document.querySelectorAll(".tabpanel").forEach((p) => p.classList.remove("active"));
    $("#tab-" + name).classList.add("active");
    state.currentTab = name;
  }

  function initTabs() {
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });
  }

  // ------------------------------------------------------------- archivo

  function initDropzone() {
    const dz = $("#dropzone");
    const input = $("#file-input");

    dz.addEventListener("click", () => input.click());
    $("#browse-link").addEventListener("click", (e) => {
      e.stopPropagation();
      input.click();
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
    input.addEventListener("change", () => {
      const file = input.files && input.files[0];
      if (file) handleFile(file);
    });
  }

  async function handleFile(file) {
    setStatus("Procesando " + file.name + "… (todo en tu navegador)");
    $("#file-name").textContent = file.name;
    try {
      const buffer = await file.arrayBuffer();
      const doc = await parseDocument(file.name, buffer);
      state.doc = doc;
      $("#doc-info").classList.remove("hidden");
      $("#btn-map").disabled = false;
      renderExtracted();
      renderItems();
      const s = summarize(doc);
      setStatus(
        (doc.error ? "Con advertencias: " + doc.error + " · " : "") + summarizeDoc(s),
        doc.error ? "warn" : "ok"
      );
      switchTab("extracted");
    } catch (e) {
      setStatus("Error al procesar: " + (e && e.message ? e.message : e), "err");
    }
  }

  function summarizeDoc(doc) {
    const kv = (doc.kv_pairs || []).length;
    const items = (doc.line_items || []).length;
    return kv + " dato(s) · " + items + " línea(s) de pedido";
  }

  function renderExtracted() {
    const d = state.doc;
    let html = "";
    if (d.kv_pairs && d.kv_pairs.length) {
      html += "Datos:\n" + d.kv_pairs.map((p) => "  " + p.key + " → " + p.value).join("\n") + "\n\n";
    }
    if (d.tables && d.tables.length) {
      d.tables.forEach((t) => {
        html += "Tabla [" + t.sheet + "] " + t.headers.join(" | ") + " (" + t.rows.length + " filas)\n";
      });
    } else {
      html += "(no se detectaron tablas)";
    }
    $("#extracted-content").textContent = html || "Sin datos extraídos.";
  }

  // ------------------------------------------------------------- mapeo

  async function generateMapping() {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) return;
    setStatus("Descubriendo campos del formulario…");
    const fields = await askTab(tab.id, { type: "GET_FIELDS" });
    if (!fields.ok || !fields.fields || !fields.fields.length) {
      setStatus("No se encontraron campos en la página actual. ¿Estás en el formulario de pedido?", "err");
      return;
    }
    if (!state.doc) {
      setStatus("Primero cargá un documento.", "err");
      return;
    }
    state.fields = fields.fields.filter((f) => f.visible);
    setStatus("Analizando " + state.fields.length + " campos…");
    const memory = await getMemory();
    const res = mapFields(state.fields, state.doc, memory);
    state.mapping = res.mapping || [];
    renderMapping();
    $("#btn-fill").disabled = false;
    setStatus("Mapeo generado. Revisá los valores y hacé click en «Rellenar».", "ok");
    switchTab("mapping");
  }

  function renderMapping() {
    const list = $("#mapping-list");
    list.innerHTML = "";
    if (!state.mapping.length) {
      list.innerHTML = '<p class="hint">Sin coincidencias.</p>';
      return;
    }
    state.mapping.forEach((m, i) => {
      const row = document.createElement("div");
      row.className = "map-row";
      const f = state.fields.find((x) => x.key === m.field_key) || {};
      const typeName = f.type || "";
      row.innerHTML =
        '<div class="field-name">' + esc(f.label || m.field_key) +
        (f.placeholder ? " <small>" + esc(f.placeholder) + "</small>" : "") +
        (typeName ? " <small>" + esc(typeName) + "</small>" : "") + "</div>" +
        '<input type="text" data-idx="' + i + '" data-key="' + esc(m.field_key) + '" value="' + esc(m.value || "") + '" placeholder="sin dato">' +
        '<span class="conf ' + (m.confidence || "baja") + '">' + esc(m.confidence || "") + "</span>" +
        '<input type="checkbox" data-mem="' + i + '" title="Recordar este mapeo para el mismo tipo de documento">' +
        '<span class="hint" title="' + esc(m.source || "") + '">' + esc((m.source || "").slice(0, 16)) + "</span>";
      list.appendChild(row);
    });
    $("#memory-row").hidden = false;
  }

  // ------------------------------------------------------------- rellenar

  async function fillForm() {
    const tab = await getActiveTab();
    if (!tab || tab.id == null) return;
    const mapping = [];
    document.querySelectorAll("#mapping-list .map-row").forEach((row) => {
      const input = row.querySelector('input[type="text"]');
      const key = input && input.dataset.key;
      const value = input ? input.value.trim() : "";
      if (key && value) mapping.push({ fieldKey: key, value: value });
    });
    if (!mapping.length) {
      setStatus("No hay valores para rellenar. Revisá el mapeo.", "err");
      return;
    }
    setStatus("Rellenando " + mapping.length + " campos…");
    const res = await askTab(tab.id, { type: "FILL_FORM", mapping: mapping });
    if (!res.ok) {
      setStatus("La pestaña cambió o no responde. Recargala e intentá de nuevo.", "err");
      return;
    }
    const ok = res.results.filter((r) => r.ok).length;
    const fail = res.results.length - ok;
    setStatus("Rellenados " + ok + " campo(s)" + (fail ? ", " + fail + " con error (revisá los bordes rojos)." : "."),
      fail ? "warn" : "ok");
  }

  // ------------------------------------------------------------- items

  function itemsText(withPrices) {
    const items = (state.doc && state.doc.line_items) || [];
    if (withPrices) {
      return items
        .map((it) => [it.sku, it.producto, it.cantidad, it.precio].join("\t"))
        .join("\n");
    }
    return items
      .map((it) => (it.sku || it.producto) + "\t" + (it.cantidad || "") + "\t" + (it.categoria || it.unidad || ""))
      .join("\n");
  }

  function renderItems() {
    const items = (state.doc && state.doc.line_items) || [];
    const box = $("#items-table");
    if (!items.length) {
      box.innerHTML = '<p class="hint">No se detectaron líneas de pedido.</p>';
      return;
    }
    let html = '<table><tr><th>#</th><th>Producto</th><th>Cant.</th><th>Unidad</th></tr>';
    items.forEach((it, i) => {
      const unidad = it.categoria || it.unidad || "";
      html +=
        "<tr>" +
        '<td class="mono">' + (i + 1) + "</td>" +
        '<td>' + esc(it.producto) + "</td>" +
        '<td>' + esc(it.cantidad) + "</td>" +
        "<td>" + esc(unidad) + "</td>" +
        "</tr>";
    });
    html += "</table>";
    box.innerHTML = html;
  }

  function buildCartItems() {
    return ((state.doc && state.doc.line_items) || [])
      .map((it) => ({
        producto: it.producto || "",
        cantidad: it.cantidad || "",
        unidad: it.categoria || it.unidad || "",
        sku: it.sku || "",
      }))
      .filter((it) => (it.producto || it.sku || "").trim());
  }

  async function armarCarrito() {
    const tab = await getActiveTab();
    if (!tab || !tab.id) {
      setStatus("No hay pestaña activa.", "err");
      return;
    }
    const items = buildCartItems();
    if (!items.length) {
      setStatus("No hay líneas de pedido para cargar.", "warn");
      return;
    }
    $("#btn-cart").disabled = true;
    setStatus("Armando carrito en el store (" + items.length + " líneas)…", "ok");
    const out = await askTab(tab.id, { type: "ADD_TO_CART", items });
    $("#btn-cart").disabled = false;
    if (!out || !out.ok) {
      setStatus((out && out.message) || "El store no respondió.", "err");
      return;
    }
    const res = out.results || [];
    const ok = res.filter((r) => r.ok).length;
    const rows = res
      .map((r) => {
        const cls = r.ok ? "ok" : "err";
        return '<div class="cart-row ' + cls + '"><b>' + esc(r.producto) + "</b><span>" + esc(r.message) + "</span></div>";
      })
      .join("");
    $("#cart-results").innerHTML =
      '<p class="hint">Agregados al carrito: ' + ok + " de " + res.length + ". Revisá el carrito en el store para confirmar.</p>" +
      rows;
    setStatus("Pedido procesado: " + ok + " de " + res.length + " en el carrito.", ok === res.length ? "ok" : "warn");
  }

  async function copyText(text, msg) {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(msg, "ok");
    } catch (e) {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      setStatus(msg, "ok");
    }
  }

  // ------------------------------------------------------------- memoria

  async function rememberMapping() {
    if (!state.doc) return;
    const sends = [];
    document.querySelectorAll("#mapping-list .map-row").forEach((row) => {
      const cb = row.querySelector('input[data-mem]');
      if (!cb || !cb.checked) return;
      const input = row.querySelector('input[type="text"]');
      const idx = Number(input.dataset.idx);
      const m = state.mapping[idx];
      const value = input.value.trim();
      const source = (m && m.source) || "";
      sends.push({
        fingerprint: state.doc.fingerprint,
        field_key: m.field_key,
        source: /sin dato|sin coincidencia|memoria/.test(source) ? "" : source,
        value: value,
      });
    });
    if (!sends.length) {
      setStatus("Marcá con ✔ las filas que querés recordar.", "warn");
      return;
    }
    for (const s of sends) {
      await setMapping(s.fingerprint, s.field_key, s.source, s.value);
    }
    setStatus("Mapeo guardado para próximos documentos del mismo tipo.", "ok");
  }

  async function clearMemory() {
    await clearMemory();
    setStatus("Memoria de mapeo borrada.", "ok");
  }

  // ------------------------------------------------------------- settings

  function initSettings() {
    $("#btn-settings").addEventListener("click", async () => {
      const access = await getAllowedUsers(true);
      state.allowed = access;
      if (access.ok) {
        setBadge("ok", "Lista OK", access.warning || "");
      } else {
        setBadge("err", "Lista no disponible", access.error || "");
      }
      $("#settings-overlay").classList.remove("hidden");
    });
    $("#btn-close-settings").addEventListener("click", () => {
      $("#settings-overlay").classList.add("hidden");
    });
    $("#btn-refresh-list").addEventListener("click", async () => {
      const access = await getAllowedUsers(true);
      state.allowed = access;
      if (access.ok) {
        setBadge("ok", "Lista OK", access.warning || "");
        setStatus("Acceso actualizado.", "ok");
        const email = state.session && state.session.email;
        if (email) {
          if (await isAllowed(email, state.allowed.hashes)) {
            $("#access-screen").classList.add("hidden");
            $("#main-screen").classList.remove("hidden");
            setBadge("ok", "Autorizado");
            setStatus("Acceso habilitado. Podés usar la herramienta.", "ok");
          } else {
            setBadge("err", "No autorizado");
            setStatus("Tu usuario aún no está en la lista.", "err");
          }
        }
      } else {
        setBadge("err", "Lista no disponible", access.error || "");
        setStatus(access.error || "No se pudo actualizar el acceso.", "err");
      }
    });
  }

  // ------------------------------------------------------------- bind

  function bind() {
    $("#btn-map").addEventListener("click", generateMapping);
    $("#btn-fill").addEventListener("click", fillForm);
    $("#btn-copy-items").addEventListener("click", () =>
      copyText(itemsText(false), "Líneas copiadas (SKU|CANT).")
    );
    $("#btn-cart").addEventListener("click", armarCarrito);
    $("#btn-remember").addEventListener("click", rememberMapping);
    $("#btn-clear-memory").addEventListener("click", clearMemory);
  }

  initTabs();
  initDropzone();
  initSettings();
  bind();
  init();
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
