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
      default:
        sendResponse({ ok: false, message: "Tipo de mensaje desconocido" });
    }
    return true;
  });

  // Nota para depuracion
  window.__TOKIN_AUTOPEDIDO__ = { discoverFields, fillForm, getSessionInfo };
})();
