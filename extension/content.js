// Tokin AutoPedido - content script
// Descubre campos del formulario, rellena valores (compatible con React/Next.js)
// y expone una API de mensajes para el popup.

(function () {
  "use strict";

  try {
    document.documentElement.setAttribute("data-tokin-ap", "1");
  } catch (e) {}

  let highlightStyleInjected = false;

  // ------------------------------------------------------------- utilidades

  function toStr(v) {
    return v == null ? "" : String(v);
  }

  function stableKey(el, index) {
    const id = el.getAttribute("id");
    if (id) return id;
    const name = el.getAttribute("name");
    if (name) return name;
    const dataId = el.getAttribute("data-id");
    if (dataId) return dataId;
    const label = findLabel(el);
    return (label ? "lbl-" + label.replace(/\s+/g, "-") : "") || ("fld-" + index);
  }

  function findLabel(el) {
    // <label for="id">
    if (el.id) {
      try {
        const lbl = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (lbl) return lbl.innerText.trim();
      } catch (e) {}
    }
    // aria-labelledby
    const alb = el.getAttribute("aria-labelledby");
    if (alb) {
      const ref = document.getElementById(alb);
      if (ref) return ref.innerText.trim();
    }
    // aria-label
    const al = el.getAttribute("aria-label");
    if (al) return al.trim();
    // envoltorio <label>
    let p = el.closest("label");
    if (p) {
      const t = (p.innerText || "").replace(el.value || "", "").trim();
      if (t) return t;
    }
    // hermano previo que parezca etiqueta
    let prev = el.previousElementSibling;
    let guard = 0;
    while (prev && guard < 4) {
      const tag = prev.tagName;
      const cls = (prev.className || "").toString();
      if (tag === "LABEL" || tag === "P" || tag === "SPAN" || /label|heading|title|text-/.test(cls)) {
        const t = (prev.innerText || "").trim();
        if (t && !/^\d+$/.test(t)) return t;
      }
      prev = prev.previousElementSibling;
      guard++;
    }
    // subir hasta contenedor de campo
    p = el.closest("div");
    for (let i = 0; p && i < 3; i++) {
      if (!p) break;
      const children = Array.from(p.querySelectorAll("label, span, p, h1, h2, h3, h4, small"))
        .filter((n) => !n.contains(el) || n !== el);
      for (const n of children) {
        const t = (n.innerText || "").trim();
        if (t && t.length < 80 && !/^\d+$/.test(t)) return t;
      }
      p = p.parentElement;
    }
    return "";
  }

  function getOptions(el) {
    if (el.tagName !== "SELECT") return [];
    return Array.from(el.options).map((o) => ({ value: o.value, text: o.text.trim() }));
  }

  function isFillingCandidate(el) {
    const tag = el.tagName;
    if (tag !== "INPUT" && tag !== "SELECT" && tag !== "TEXTAREA") return false;
    if (el.isContentEditable) return true;
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (type === "hidden") return false;
    if (type === "submit" || type === "button" || type === "reset" || type === "file") return false;
    if (el.disabled || el.readOnly) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return true;
  }

  // ------------------------------------------------------------- descubrir

  function discoverFields() {
    const all = document.querySelectorAll("input, select, textarea, [contenteditable='true']");
    const fields = [];
    let index = 0;
    for (const el of all) {
      const tag = el.tagName;
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (tag === "INPUT" && ["hidden", "submit", "button", "reset", "file"].includes(type)) continue;
      if (tag === "INPUT" && el.disabled && !el.getAttribute("name")) continue;

      const label = findLabel(el);
      const rect = el.getBoundingClientRect();
      fields.push({
        key: stableKey(el, index),
        index: index,
        tag: tag,
        type: type || (tag === "SELECT" ? "select" : tag === "TEXTAREA" ? "textarea" : "text"),
        id: el.getAttribute("id") || "",
        name: el.getAttribute("name") || "",
        dataId: el.getAttribute("data-id") || "",
        placeholder: el.getAttribute("placeholder") || "",
        ariaLabel: el.getAttribute("aria-label") || "",
        label: label,
        options: getOptions(el),
        visible: isFillingCandidate(el),
        disabled: !!el.disabled,
        readonly: !!el.readOnly,
        required: el.required || false,
        value: toStr(el.value),
        contentEditable: el.isContentEditable || false,
        top: Math.round(rect.top || 0),
        left: Math.round(rect.left || 0),
      });
      index++;
    }
    return fields;
  }

  // ------------------------------------------------------------- relleno

  function setNativeValue(el, value) {
    const proto =
      el.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : el.tagName === "SELECT"
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
  }

  function fire(el) {
    ["input", "change", "blur"].forEach((type) => {
      try {
        el.dispatchEvent(new Event(type, { bubbles: true, cancelable: true }));
      } catch (e) {}
    });
  }

  function fillSelect(el, value) {
    const opts = Array.from(el.options);
    const match =
      opts.find((o) => o.value === value) ||
      opts.find((o) => o.text.trim() === value) ||
      opts.find((o) => o.text.trim().toLowerCase().includes(toStr(value).toLowerCase()));
    if (!match) {
      return { ok: false, message: "Sin opción que coincida" };
    }
    setNativeValue(el, match.value);
    fire(el);
    return { ok: true, message: match.text };
  }

  function fillElement(el, value) {
    try {
      if (el.tagName === "SELECT") {
        return fillSelect(el, value);
      }
      if (el.isContentEditable || el.getAttribute("contenteditable") === "true") {
        el.textContent = toStr(value);
        fire(el);
        return { ok: true, message: "contenteditable" };
      }
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (type === "date" && /^\d{2}\/\d{2}\/\d{4}$/.test(toStr(value))) {
        const [d, m, y] = value.split("/");
        value = `${y}-${m}-${d}`;
      }
      if (type === "number") {
        value = toStr(value).replace(/,/g, ".").replace(/[^\d.\-]/g, "");
      }
      setNativeValue(el, toStr(value));
      fire(el);
      // algunos componentes usan input no controlado por React: re-set directo
      if (el.value !== toStr(value)) {
        el.value = toStr(value);
        fire(el);
      }
      return { ok: true, message: toStr(value).slice(0, 60) };
    } catch (e) {
      return { ok: false, message: String(e).slice(0, 80) };
    }
  }

  function fillForm(mapping) {
    const all = document.querySelectorAll("input, select, textarea, [contenteditable='true']");
    const results = [];
    const byKey = {};
    all.forEach((el, i) => byKey[stableKey(el, i)] = el);

    for (const m of mapping) {
      let el = byKey[m.fieldKey];
      if (!el && m.fieldKey) {
        el = document.querySelector(`#${CSS.escape(m.fieldKey)}`) ||
             document.querySelector(`[name="${CSS.escape(m.fieldKey)}"]`) ||
             document.querySelector(`[data-id="${CSS.escape(m.fieldKey)}"]`);
      }
      if (!el) {
        results.push({ fieldKey: m.fieldKey, ok: false, message: "Campo no encontrado" });
        continue;
      }
      const r = fillElement(el, m.value);
      highlight(el, r.ok);
      results.push({ fieldKey: m.fieldKey, ok: r.ok, message: r.message });
    }
    return results;
  }

  // ------------------------------------------------------------- highlight

  function injectStyle() {
    if (highlightStyleInjected) return;
    highlightStyleInjected = true;
    const style = document.createElement("style");
    style.id = "tokin-autopedido-style";
    style.textContent = `
      .tokin-ap-ok, .tokin-ap-err { outline: 3px solid transparent !important; transition: outline-color .2s; }
      .tokin-ap-ok { outline-color: #16a34a !important; }
      .tokin-ap-err { outline-color: #dc2626 !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function highlight(el, ok) {
    injectStyle();
    if (!el) return;
    el.classList.remove("tokin-ap-ok", "tokin-ap-err");
    el.classList.add(ok ? "tokin-ap-ok" : "tokin-ap-err");
    setTimeout(() => el.classList.remove("tokin-ap-ok", "tokin-ap-err"), 5000);
  }

  // ------------------------------------------------------------- carrito

  function toksleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  function tokNorm(s) {
    return String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  function tokSim(a, b) {
    const A = new Set(tokNorm(a).split(" ").filter(Boolean));
    const B = new Set(tokNorm(b).split(" ").filter(Boolean));
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const t of A) if (B.has(t)) inter++;
    const jac = inter / (A.size + B.size - inter);
    const an = tokNorm(a);
    const bn = tokNorm(b);
    const sub = an && bn && (an.includes(bn) || bn.includes(an)) ? 0.35 : 0;
    return Math.min(1, jac + sub);
  }

  async function waitForTokin(fn, timeout, interval) {
    const start = Date.now();
    interval = interval || 250;
    for (;;) {
      try {
        const v = fn();
        if (v) return v;
      } catch (e) {}
      if (Date.now() - start > timeout) return null;
      await toksleep(interval);
    }
  }

  function tokSetValue(el, value) {
    try {
      const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, "value");
      if (desc && desc.set) desc.set.call(el, value);
      else el.value = value;
      ["input", "change", "blur"].forEach((t) => {
        try {
          el.dispatchEvent(new Event(t, { bubbles: true, cancelable: true }));
        } catch (e) {}
      });
    } catch (e) {}
  }

  function tokUnitLabel(item) {
    const mapa = { bulto: "Bulto", display: "Display", b: "Bulto", d: "Display", u: "Unidad", ud: "Unidad", a: "Unidad", unidad: "Unidad", caja: "Caja" };
    const k = String((item && (item.categoria || item.unidad)) || "").toLowerCase();
    return mapa[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "Unidad");
  }

  function tokBestArticle(target) {
    const arts = Array.from(document.querySelectorAll("article")).filter(
      (a) => a.getAttribute("data-id") !== "cart-product-card"
    );
    if (!arts.length) return null;
    let best = null;
    let bestScore = 0;
    for (const a of arts) {
      const t = a.innerText || "";
      if (!t) continue;
      const s = tokSim(target, t);
      if (s > bestScore) {
        bestScore = s;
        best = a;
      }
    }
    return bestScore >= 0.35 ? best : null;
  }

  function tokToast() {
    let el = document.getElementById("tokin-toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "tokin-toast";
      el.style.cssText =
        "position:fixed;right:16px;bottom:16px;z-index:999999;background:#0f172a;color:#fff;" +
        "padding:10px 14px;border-radius:10px;font:13px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.35);" +
        "max-width:320px;white-space:pre-wrap;";
      document.body.appendChild(el);
    }
    return el;
  }

  function tokToastSet(text, kind) {
    try {
      const el = tokToast();
      el.textContent = text;
      el.style.background = kind === "ok" ? "#15803d" : kind === "err" ? "#b91c1c" : "#0f172a";
    } catch (e) {}
  }

  function tokToastHide() {
    try {
      const el = document.getElementById("tokin-toast");
      if (el) {
        setTimeout(() => el.remove(), 6000);
      }
    } catch (e) {}
  }

  async function addToCart(items) {
    const total = (items || []).length;
    tokToastSet("Preparando carrito (0/" + total + ")", "");
    const results = [];
    for (let idx = 0; idx < (items || []).length; idx++) {
      const it = items[idx];
      tokToastSet("Buscando «" + String(it.producto || "").slice(0, 40) + "» (" + (idx + 1) + "/" + total + ")", "");
      const r = { producto: it.producto || it.sku || "", ok: false, message: "", storeName: "" };
      try {
        const target = String(it.producto || it.sku || "").trim();
        if (!target) {
          r.message = "sin nombre de producto";
          results.push(r);
          continue;
        }
        const search = await waitForTokin(
          () => document.querySelector("input[placeholder*='productos']"),
          8000
        );
        if (!search) {
          r.message = "no hay buscador de productos en la página";
          results.push(r);
          continue;
        }
        tokSetValue(search, target);

        let option = await waitForTokin(() => {
          const opts = Array.from(document.querySelectorAll("[role=option]"));
          if (!opts.length) return null;
          let best = null;
          let bestScore = 0;
          for (const o of opts) {
            const s = tokSim(target, o.innerText || "");
            if (s > bestScore) {
              bestScore = s;
              best = o;
            }
          }
          return bestScore >= 0.4 ? best : null;
        }, 7000, 300);

        if (option) {
          option.click();
        } else {
          search.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", keyCode: 13, bubbles: true }));
          search.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", keyCode: 13, bubbles: true }));
        }

        let card = await waitForTokin(() => tokBestArticle(target), 18000, 400);
        if (!card) {
          r.message = "no se encontró el producto en los resultados";
          results.push(r);
          continue;
        }
        const cardText = (card.innerText || "").replace(/\s+/g, " ").trim();
        r.storeName = cardText.slice(0, 90);

        const wantUnit = tokUnitLabel(it);
        let availableUnits = "";
        const unitBtn = await waitForTokin(() => {
          const c = tokBestArticle(target);
          if (!c) return null;
          const btns = Array.from(c.querySelectorAll("[data-id=sku-selector-button]"));
          availableUnits = btns.map((x) => (x.innerText || "").trim()).join(" / ") || "";
          return btns.find((x) => (x.innerText || "").toLowerCase().includes(wantUnit.toLowerCase())) || null;
        }, 6000, 200);
        if (!unitBtn) {
          r.message = "sin botón de unidad «" + wantUnit + "»" + (availableUnits ? " (hay: " + availableUnits + ")" : "");
          results.push(r);
          continue;
        }
        unitBtn.click();
        await toksleep(2000);

        const qty = Math.floor(Number(String(it.cantidad || "").replace(/[^\d.]/g, ""))) || 0;
        let nums = await waitForTokin(() => {
          const c = tokBestArticle(target);
          if (!c) return null;
          const els = c.querySelectorAll("input[type=number]");
          return els.length ? els : null;
        }, 5000, 250);

        if (!nums) {
          const addBtn = await waitForTokin(() => {
            const c = tokBestArticle(target);
            if (!c) return null;
            const b = c.querySelector("[data-id=add-to-cart-button]");
            return b && !b.disabled ? b : null;
          }, 6000, 250);
          if (!addBtn) {
            r.message = "sin botón Agregar habilitado";
            results.push(r);
            continue;
          }
          addBtn.click();
          nums = await waitForTokin(() => {
            const c = tokBestArticle(target);
            if (!c) return null;
            const els = c.querySelectorAll("input[type=number]");
            return els.length ? els : null;
          }, 8000, 250);
          if (!nums) {
            r.ok = true;
            r.message = "agregado sin poder fijar cantidad";
            results.push(r);
            continue;
          }
        }

        if (qty > 0) {
          for (const el of nums) tokSetValue(el, String(qty));
          await toksleep(600);
          r.ok = true;
          r.message = "agregado: " + qty + " " + wantUnit;
        } else {
          r.ok = true;
          r.message = "agregado sin cantidad";
        }
      } catch (e) {
        r.message = "error: " + String((e && e.message) || e).slice(0, 140);
      }
      results.push(r);
      tokToastSet(
        r.ok
          ? "OK " + (idx + 1) + "/" + total + ": " + String(it.producto || "").slice(0, 30) + " — " + r.message
          : "FALTA " + (idx + 1) + "/" + total + ": " + String(it.producto || "").slice(0, 30) + " — " + r.message,
        r.ok ? "ok" : "err"
      );
    }
    let snapshot = {};
    try {
      const b = document.querySelector("[data-id=navbar-minicart-button]");
      const lines = Array.from(document.querySelectorAll("[data-id=cart-product-card]")).map((a) => {
        const q = a.querySelector("input[type=number]");
        return { text: (a.innerText || "").replace(/\s+/g, " ").trim().slice(0, 80), qty: q ? q.value : "" };
      });
      snapshot = {
        minicart: b ? (b.getAttribute("aria-label") || b.innerText || "") : "",
        lines,
      };
    } catch (e) {
      snapshot = { error: String(e) };
    }
    tokToastSet(
      "Pedido listo: " + results.filter((r) => r.ok).length + " de " + total + " en el carrito",
      results.every((r) => r.ok) ? "ok" : "err"
    );
    tokToastHide();
    try {
      const cartBtn = document.querySelector("[data-id=navbar-minicart-button]");
      if (cartBtn) cartBtn.click();
    } catch (e) {}
    return { results, snapshot };
  }

  // ------------------------------------------------------------- sesion

  function getSessionInfo() {
    let email = "";
    try {
      email = localStorage.getItem("currentEmail") || "";
      if (!email) {
        const cu = localStorage.getItem("currentUser");
        if (cu) {
          try { email = JSON.parse(cu).email || ""; } catch (e) {}
        }
      }
      if (!email) {
        const m = document.cookie.match(/(?:^|;\s*)UserJWT=([^;]+)/);
        if (m) {
          try {
            const payload = m[1].split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
            const pad = payload.length % 4;
            const b64 = pad ? payload + "=".repeat(4 - pad) : payload;
            const data = JSON.parse(decodeURIComponent(escape(atob(b64))));
            email =
              (data.user && data.user.email) ||
              (data.additionalInfo && data.additionalInfo.account && data.additionalInfo.account.email) ||
              data.email ||
              "";
          } catch (e) {}
        }
      }
    } catch (e) {}
    return {
      url: location.href,
      title: document.title,
      email: email,
      isTokin: location.hostname.indexOf("tokintienda") !== -1,
    };
  }

  // ------------------------------------------------------------- mensajes

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    switch (msg && msg.type) {
      case "PING":
        sendResponse({ ok: true, session: getSessionInfo() });
        break;
      case "GET_FIELDS":
        sendResponse({ ok: true, fields: discoverFields() });
        break;
      case "FILL_FORM":
        sendResponse({ ok: true, results: fillForm(msg.mapping || []) });
        break;
      case "HIGHLIGHT":
        sendResponse({ ok: true });
        break;
      case "ADD_TO_CART":
        addToCart(msg.items || [])
          .then((out) => sendResponse({ ok: true, ...out }))
          .catch((err) => sendResponse({ ok: false, message: String(err) }));
        break;
      default:
        sendResponse({ ok: false, message: "Tipo de mensaje desconocido" });
    }
    return true;
  });

  window.addEventListener("tokin-cart-req", async (ev) => {
    try {
      const out = await addToCart((ev.detail && ev.detail.items) || []);
      document.dispatchEvent(new CustomEvent("tokin-cart-res", { detail: out, bubbles: true }));
    } catch (err) {
      document.dispatchEvent(new CustomEvent("tokin-cart-res", { detail: { ok: false, message: String(err) }, bubbles: true }));
    }
  });

  // Nota para depuracion
  window.__TOKIN_AUTOPEDIDO__ = { discoverFields, fillForm, getSessionInfo, addToCart };
})();
