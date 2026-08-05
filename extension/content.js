// Tokin AutoPedido - content script
// Descubre campos del formulario, rellena valores (compatible con React/Next.js)
// y expone una API de mensajes para el popup.

(function () {
  "use strict";

  document.documentElement.setAttribute("data-tokin-ap", "1");

  let highlightStyleInjected = false;
  let cartCancel = false;

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

  function tokLev(a, b) {
    a = String(a); b = String(b);
    const m = a.length, n = b.length;
    if (m === 0) return n;
    if (n === 0) return m;
    let prev = new Array(n + 1);
    let curr = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      curr[0] = i;
      const ai = a[i - 1];
      for (let j = 1; j <= n; j++) {
        const cost = ai === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
      }
      const tmp = prev; prev = curr; curr = tmp;
    }
    return prev[n];
  }

  // Similaridad tolerante a errores OCR: además de igualdad exacta de tokens,
  // cuenta como acierto un token con distancia de edición <= 1 (ACUILA/AGUILA,
  // BACLEY/BAGLEY) para que los PDFs escaneados encuentren el producto igual.
  function tokSim(a, b) {
    const A = Array.from(new Set(tokNorm(a).split(" ").filter(Boolean)));
    const B = Array.from(new Set(tokNorm(b).split(" ").filter(Boolean)));
    if (!A.length || !B.length) return 0;
    const bSet = new Set(B);
    let inter = 0;
    for (const t of A) {
      if (bSet.has(t)) {
        inter += 1;
        continue;
      }
      if (t.length < 4 || B.length > 80) continue;
      for (const u of B) {
        if (u.length < 4 || u[0] !== t[0]) continue;
        if (Math.abs(t.length - u.length) > 1) continue;
        if (tokLev(t, u) <= 1) {
          inter += 0.85;
          break;
        }
      }
    }
    const jac = inter / (A.length + B.length - inter);
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
    const mapa = { bulto: "Bulto", display: "Display", pack: "Display", packs: "Display", paquete: "Display", pk: "Display", b: "Bulto", bu: "Bulto", d: "Display", di: "Display", u: "Unidad", ud: "Unidad", un: "Unidad", a: "Unidad", unidad: "Unidad", caja: "Caja" };
    const k = String((item && (item.categoria || item.unidad)) || "").toLowerCase();
    return mapa[k] || (k ? k.charAt(0).toUpperCase() + k.slice(1) : "Unidad");
  }

  const TOK_UNIT_ALIASES = {
    display: ["display", "disp", "pack", "packs", "paquete", "paquetes"],
    bulto: ["bulto", "bultos", "envase", "caja", "cajas"],
    unidad: ["unidad", "unidades", "uds", "und", "uni", "unid"],
    caja: ["caja", "cajas"],
  };

  function tokNumbers(s) {
    return Array.from(new Set((String(s || "").match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", "."))));
  }

  // Nombre "nucleo": solo palabras de letras >= 2 chars (descarta x, gr, medidas, skus…).
  function tokCoreName(s) {
    return tokNorm(s)
      .split(" ")
      .filter((w) => /^[a-z]{2,}$/.test(w))
      .join(" ");
  }

  // Puntaje de articulo: max entre sim. completa y sim. del nombre nucleo, mas bonus
  // por numeros compartidos y sobre todo por el GRAMAJE ("18x40g" vs "x40 GRS."):
  // el peso del producto identifica la unidad exacta aunque difiera el pack.
  function tokGrams(s) {
    const t = String(s || "").toLowerCase();
    const out = [];
    let m;
    const re = /(\d+(?:[.,]\d+)?)\s*(?:g|gr|grs|gramo|gramos|kg)\b/g;
    while ((m = re.exec(t))) {
      const v = parseFloat(m[1].replace(",", "."));
      if (!isNaN(v) && out.indexOf(v) === -1) out.push(v);
    }
    return out;
  }

  function tokArticleScore(target, articleText) {
    const full = tokSim(target, articleText);
    const name = tokSim(tokCoreName(target), tokCoreName(articleText));
    let s = Math.max(full, name);
    const tn = tokNumbers(target);
    const an = tokNumbers(articleText);
    if (tn.length && an.length) {
      let hits = 0;
      for (const n of tn) if (an.indexOf(n) !== -1) hits++;
      s += 0.12 * hits;
    }
    const tg = tokGrams(target);
    const ag = tokGrams(articleText);
    if (tg.length && ag.length) {
      for (const g of tg) if (ag.indexOf(g) !== -1) {
        s += 0.2;
        break;
      }
    }
    return s;
  }

  // Tamaños que figuran en la card: "Display: 30 Uds / Bulto: 240 Uds", "Pack x 16".
  function tokUnitSizes(articleText) {
    const t = String(articleText || "");
    const out = {};
    const m = t.match(/(?:display|pack)\b[:\s]*x?\s*(\d[\d.]*)\s*(?:uds?|unidades?)?/i);
    if (m) out.display = parseFloat(m[1].replace(",", "."));
    const n = t.match(/bulto\b[:\s]*x?\s*(\d[\d.]*)\s*(?:uds?|unidades?)?/i);
    if (n) out.bulto = parseFloat(n[1].replace(",", "."));
    return out;
  }

  // Si el pedido dice "DISPLAY DE 30 UNIDADES" / "PACK X 16", el tamaño esperado es 30 / 16.
  function tokWantedDisplay(item) {
    const text = tokNorm(String(item.unidad || "") + " " + String(item.producto || ""));
    const m = text.match(/(?:display|pack)\s+(?:(?:de|x)\s+)?(\d[\d.,]*)/);
    if (m) return parseFloat(m[1].replace(",", "."));
    return null;
  }

  // Un boton de unidad coincide si alguna de sus palabras es el tipo o un sinonimo
  // ("x Pack" es Display en la tienda de Tokin).
  function tokUnitBtnMatch(btnText, type) {
    const words = tokNorm(btnText).split(" ");
    const aliases = TOK_UNIT_ALIASES[type] || [type];
    return words.some((w) =>
      aliases.some((al) => (al.length >= 3 ? w === al || w.indexOf(al) === 0 : w === al))
    );
  }

  // Una card de producto real tiene precio, SKU ARC-*, botones de unidad o de
  // Agregar (o dice "sin stock"). Los <article> del footer/Institucional no.
  function tokIsProductCard(a) {
    const t = (a.innerText || "");
    if (!t) return false;
    if (
      a.querySelector("[data-id=add-to-cart-button]") ||
      a.querySelector("[data-id=sku-selector-button]") ||
      a.querySelector("input[type=number]")
    ) {
      return true;
    }
    if (/\$\s?\d[\d.,]*(?:\s|$)/.test(t)) return true;
    if (/ARC-\d+/i.test(t)) return true;
    if (/sin stock/i.test(t)) return true;
    return false;
  }

  // Ranking: primero la card que ofrece el botón de la unidad pedida (si la hay),
  // luego las card con botón Agregar/unidades, y al final las promos/combo o sin
  // stock. Dentro de cada grupo, el puntaje (que incluye el gramaje) decide.
  // Devuelve { el, score, group, hasWanted } o null.
  function tokBestArticle(target, wantType, wantedDisplay) {
    const arts = Array.from(document.querySelectorAll("article")).filter(
      (a) => a.getAttribute("data-id") !== "cart-product-card" && tokIsProductCard(a)
    );
    if (!arts.length) return null;
    let best = null;
    let bestScore = -1;
    let bestGroup = 99;
    for (let i = 0; i < arts.length; i++) {
      const a = arts[i];
      const t = (a.innerText || "").replace(/\s+/g, " ");
      let s = tokArticleScore(target, t);
      const ds = tokUnitSizes(t).display;
      if (wantedDisplay != null) {
        if (ds === wantedDisplay) s += 0.3;
        else if (ds != null) s -= 0.15;
      }
      const btns = Array.from(a.querySelectorAll("[data-id=sku-selector-button]"));
      const hasWanted = wantType ? btns.some((b) => tokUnitBtnMatch(b.innerText || "", wantType)) : false;
      const group = hasWanted ? 0 : btns.length || a.querySelector("[data-id=add-to-cart-button]") ? 1 : 2;
      if (group < bestGroup || (group === bestGroup && s > bestScore)) {
        bestGroup = group;
        bestScore = s;
        best = { el: a, score: s, group, hasWanted };
      }
    }
    return best;
  }

  // Se acepta el candidato si es suficientemente bueno. En la última query
  // posible ("si o sí encontrar el producto") se acepta cualquier card que
  // comparta al menos una palabra-núcleo del pedido, aunque difiera gramaje.
  function tokAccept(cand, lastChance, target) {
    if (cand.group === 0) return cand.score >= 0.2;
    if (cand.score >= 0.5) return true;
    if (lastChance) {
      const ta = tokCoreName(target).split(" ").filter(Boolean);
      const aa = tokCoreName(cand.el.innerText || "").split(" ").filter(Boolean);
      if (ta.some((w) => aa.indexOf(w) !== -1)) return true;
    }
    return false;
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

  function tokProgress(message, index, total, ok) {
    try {
      chrome.runtime.sendMessage(
        { target: "offscreen", type: "CART_PROGRESS", message: String(message || ""), index, total, ok: !!ok },
        () => { void chrome.runtime.lastError; }
      );
    } catch (e) {}
  }

  function tokToB64(buf) {
    const bytes = new Uint8Array(buf);
    let bin = "";
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(bin);
  }

  // ----------------------------------------------------- selector de archivos
  // El action popup de Chrome se cierra al abrir el selector nativo, asi que el
  // picker se abre desde la pestaña del store (que no se cierra). Chrome
  // conserva el gesto de usuario del clic en el popup al pasar el mensaje al
  // content script, por eso input.click() abre el dialogo sin problemas.
  let pickerOverlay = null;
  let pickerInput = null;

  // Envía PARSE al offscreen con reintentos: si el documento offscreen todavía
  // no está creado, el canal no existe y se reintenta hasta que responda.
  function sendParseToOffscreen(filename, b64, tries) {
    const attempt = (n) => {
      try {
        chrome.runtime.sendMessage(
          { target: "offscreen", type: "PARSE", filename, b64 },
          (res) => {
            if (chrome.runtime.lastError) {
              if (n > 0) setTimeout(() => attempt(n - 1), 600);
              return;
            }
            void res;
          }
        );
      } catch (e) {
        if (n > 0) setTimeout(() => attempt(n - 1), 600);
      }
    };
    attempt(tries || 5);
  }

  function setPickerText(title, msg, kind) {
    try {
      const t = document.getElementById("tokin-picker-title");
      const m = document.getElementById("tokin-picker-msg");
      if (t) t.textContent = title || "";
      if (m) {
        m.textContent = msg || "";
        m.style.color = kind === "ok" ? "#15803d" : kind === "err" ? "#b91c1c" : "#475569";
      }
    } catch (e) {}
  }

  function ensurePickerOverlay() {
    if (pickerOverlay && document.body && document.body.contains(pickerOverlay)) return pickerOverlay;
    pickerOverlay = document.createElement("div");
    pickerOverlay.id = "tokin-picker-overlay";
    pickerOverlay.style.cssText =
      "position:fixed;inset:0;z-index:999998;background:rgba(15,23,42,.45);" +
      "display:flex;align-items:center;justify-content:center;";
    const box = document.createElement("div");
    box.style.cssText =
      "background:#fff;color:#0f172a;border-radius:16px;padding:22px 26px;max-width:380px;width:86%;" +
      "text-align:center;font:14px system-ui;box-shadow:0 14px 44px rgba(0,0,0,.35);";
    const title = document.createElement("div");
    title.id = "tokin-picker-title";
    title.style.cssText = "font-weight:700;font-size:16px;margin-bottom:8px;";
    title.textContent = "Elegí el archivo del pedido…";
    const msg = document.createElement("div");
    msg.id = "tokin-picker-msg";
    msg.style.cssText = "color:#475569;font-size:13px;line-height:1.5;";
    msg.textContent = "Excel, PDF o DOCX. La extensión lo procesa 100% en tu PC.";
    box.appendChild(title);
    box.appendChild(msg);
    pickerOverlay.appendChild(box);
    pickerInput = document.createElement("input");
    pickerInput.type = "file";
    pickerInput.accept = ".pdf,.xlsx,.xls,.docx,.csv,.txt";
    pickerInput.style.cssText = "position:absolute;width:1px;height:1px;opacity:0;overflow:hidden;";
    pickerOverlay.appendChild(pickerInput);
    document.body.appendChild(pickerOverlay);
    return pickerOverlay;
  }

  function showFilePicker() {
    return new Promise((resolve) => {
      try {
        const overlay = ensurePickerOverlay();
        overlay.style.display = "flex";
        const input = pickerInput;
        input.value = "";
        const done = (r) => resolve(r);
        input.onchange = () => {
          const file = input.files && input.files[0];
          if (!file) {
            overlay.style.display = "none";
            done({ ok: true, picked: false });
            return;
          }
          setPickerText("Leyendo «" + file.name + "»…", "Preparando el archivo para procesarlo en tu PC.");
          const reader = new FileReader();
          reader.onload = () => {
            try {
              const b64 = tokToB64(reader.result);
              sendParseToOffscreen(file.name, b64);
              setPickerText(
                "Pedido enviado a Tokin AutoPedido.",
                "Procesando «" + file.name + "». Abrí la extensión para ver las líneas y tocar «Enviar a carrito».",
                "ok"
              );
              setTimeout(() => { overlay.style.display = "none"; }, 2600);
              done({ ok: true, picked: true });
            } catch (e) {
              setPickerText("No se pudo leer el archivo.", String((e && e.message) || e), "err");
              done({ ok: false, message: String((e && e.message) || e) });
            }
          };
          reader.onerror = () => {
            setPickerText("No se pudo leer el archivo.", "Intentalo de nuevo.", "err");
            done({ ok: false, message: "error de lectura" });
          };
          reader.readAsArrayBuffer(file);
        };
        input.oncancel = () => {
          overlay.style.display = "none";
          done({ ok: true, picked: false });
        };
        input.click();
      } catch (e) {
        resolve({ ok: false, message: String((e && e.message) || e) });
      }
    });
  }

  // ----------------------------------------------------- carrito (lote resumible)
  // El store navega a /store/search al buscar; eso destruye el content script.
  // El lote se persiste en chrome.storage.local y cada página nueva reanuda:
  // por cada línea se navega a la búsqueda, se elige la card correcta (unidad +
  // gramaje), se agrega y se pasa a la siguiente.

  const CART_JOB_KEY = "tokinCartJob";
  const CART_CANCEL_KEY = "tokinCartCancel";

  function tokStoreGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (d) => {
          if (chrome.runtime.lastError) return resolve(null);
          resolve(d ? d[key] : null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function tokStoreSet(key, value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [key]: value }, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  function tokStoreRemove(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.remove(key, () => {
          void chrome.runtime.lastError;
          resolve();
        });
      } catch (e) { resolve(); }
    });
  }

  const TOK_STOP = new Set([
    "x", "de", "con", "sin", "en", "del", "la", "el", "los", "las", "y", "por", "para",
    "g", "gr", "grs", "kg", "uds", "pack", "packs", "caja", "cajas", "bulto", "bultos",
    "display", "displays", "unidad", "unidades", "paquete", "paquetes",
  ]);

  function tokSearchUrl(query) {
    return location.origin + "/store/search?q=" + encodeURIComponent(query);
  }

  // Queries candidatas para el buscador del store, de la más específica a la más
  // amplia. El pack ("18x40g") se descarta dejando el gramaje ("40g"), porque el
  // store busca mejor por gramos; si no aparece nada se prueba sin números y por
  // marca ("si o sí encontrar el producto").
  function tokBuildQueries(item) {
    const raw = String(item.producto || item.sku || "").trim();
    if (!raw) return [];
    const out = [];
    const seen = new Set();
    const push = (q) => {
      q = String(q || "").replace(/\s+/g, " ").trim();
      const key = tokNorm(q);
      if (q && !seen.has(key)) {
        seen.add(key);
        out.push(q);
      }
    };
    // 1) SKU exacto del pedido (ARC-XXXX), si existe: es la búsqueda más precisa
    const sku = String(item.sku || "").trim();
    if (sku) push(sku);
    // 2) con el gramaje limpio ("ROCKLETS CONFITADOS 18x40g" -> "ROCKLETS CONFITADOS 40g")
    push(raw.replace(/\b(\d+)\s*[x×]\s*(\d+)\s*(?:g|gr|grs|gramos?)?\b/gi, "$2g"));
    push(
      tokNorm(raw)
        .replace(/\d+/g, " ")
        .split(" ")
        .filter((w) => w.length >= 3 && !TOK_STOP.has(w))
        .join(" ")
    );
    push(
      tokNorm(raw)
        .split(" ")
        .filter((w) => w.length >= 3 && !TOK_STOP.has(w))[0] || ""
    );
    return out;
  }

  function setTokRun(on) {
    try {
      window.__TOKIN_RUN__ = !!on;
      if (!on) window.__TOKIN_RES__ = null;
    } catch (e) {}
  }

  async function tokCartStart(items) {
    cartCancel = false;
    const existing = await tokStoreGet(CART_JOB_KEY);
    if (existing) {
      return { ok: false, message: "Ya hay una carga de carrito en curso." };
    }
    const clean = (items || [])
      .map((it) => ({
        producto: it.producto || it.sku || "",
        cantidad: it.cantidad || "",
        unidad: it.unidad || "",
        categoria: it.categoria || "",
        sku: it.sku || "",
      }))
      .filter((it) => (it.producto || it.sku || "").trim());
    if (!clean.length) {
      return { ok: false, message: "No hay líneas de pedido para cargar." };
    }
    const job = {
      token: Date.now() + "-" + Math.floor(Math.random() * 1e6),
      items: clean,
      index: 0,
      qIdx: 0,
      results: [],
      total: clean.length,
      phase: "pending",
      query: "",
    };
    await tokStoreRemove(CART_CANCEL_KEY);
    await tokStoreSet(CART_JOB_KEY, job);
    setTokRun(true);
    tokToastSet("Preparando carrito (0/" + job.total + ")", "");
    tokRunJob();
    return { ok: true, started: true, total: clean.length };
  }

  async function tokRunJob() {
    try {
      const job = await tokStoreGet(CART_JOB_KEY);
      if (!job || job.phase === "done") return;
      if (cartCancel || (await tokStoreGet(CART_CANCEL_KEY))) return tokAbortCart(job);
      if (job.phase === "pending") {
        const it = job.items[job.index];
        const queries = tokBuildQueries(it);
        if (job.qIdx >= queries.length) {
          job.results.push({
            producto: it.producto || it.sku || "",
            ok: false,
            message: "no se encontró el producto en el store",
          });
          return tokAdvance(job, false);
        }
        const query = queries[job.qIdx];
        job.phase = "searching";
        job.query = query;
        await tokStoreSet(CART_JOB_KEY, job);
        tokToastSet(
          "Buscando «" + String(it.producto || "").slice(0, 36) + "» (" + (job.index + 1) + "/" + job.total + ")",
          ""
        );
        const url = tokSearchUrl(query);
        if (location.href === url) return tokProcessCurrentItem();
        location.href = url;
        return;
      }
      if (job.phase === "searching") {
        if (location.href.indexOf("/store/search") === -1) {
          job.phase = "pending";
          await tokStoreSet(CART_JOB_KEY, job);
          return tokRunJob();
        }
        return tokProcessCurrentItem();
      }
    } catch (e) {}
  }

  async function tokProcessCurrentItem() {
    const job = await tokStoreGet(CART_JOB_KEY);
    if (!job) return;
    if (cartCancel || (await tokStoreGet(CART_CANCEL_KEY))) return tokAbortCart(job);
    const it = job.items[job.index];
    const r = { producto: it.producto || it.sku || "", ok: false, message: "", storeName: "" };
    try {
      const target = String(it.producto || it.sku || "").trim();
      if (!target) {
        r.message = "sin nombre de producto";
        job.results.push(r);
        return tokAdvance(job, false);
      }
      const wantUnit = tokUnitLabel(it);
      const wantType = tokNorm(wantUnit);
      const wantedDisplay = tokWantedDisplay(it);
      const queries = tokBuildQueries(it);
      const lastChance = job.qIdx >= queries.length - 1;

      const cand = await waitForTokin(
        () => tokBestArticle(target, wantType, wantedDisplay),
        12000,
        350
      );
      if (!cand || !tokAccept(cand, lastChance, target)) {
        job.qIdx++;
        job.phase = "pending";
        await tokStoreSet(CART_JOB_KEY, job);
        return tokRunJob();
      }
      const out = await tokProcessCard(cand, it, target, wantType, wantUnit, wantedDisplay);
      Object.assign(r, out);
    } catch (e) {
      r.message = "error: " + String((e && e.message) || e).slice(0, 140);
    }
    job.results.push(r);
    return tokAdvance(job, r.ok);
  }

  async function tokProcessCard(cand, it, target, wantType, wantUnit, wantedDisplay) {
    const card = cand.el;
    const cardText = (card.innerText || "").replace(/\s+/g, " ").trim();
    const out = { ok: false, message: "", storeName: cardText.slice(0, 90) };
    let sizes = tokUnitSizes(cardText);

    let unitBtn = null;
    if (cand.hasWanted) {
      const btns = Array.from(card.querySelectorAll("[data-id=sku-selector-button]"));
      unitBtn = btns.find((x) => tokUnitBtnMatch(x.innerText || "", wantType));
    }
    if (unitBtn) {
      unitBtn.click();
      await toksleep(1500);
    } else if (card.querySelector("[data-id=sku-selector-button]")) {
      const anyBtn = card.querySelector("[data-id=sku-selector-button]");
      anyBtn.click();
      await toksleep(1500);
      out.message = "(sin botón de " + wantUnit + ", se usó " + (anyBtn.innerText || "").trim() + ")";
    }

    let unitNote = "";
    if (wantedDisplay != null && sizes.display != null && sizes.display !== wantedDisplay) {
      unitNote = " (card: " + wantUnit.toLowerCase() + " de " + sizes.display + ", pedido " + wantedDisplay + ")";
    }
    const isNoStock = /sin stock/i.test(cardText);
    const qty = Math.floor(Number(String(it.cantidad || "").replace(/[^\d.]/g, ""))) || 0;

    let nums = await waitForTokin(() => {
      const c = tokBestArticle(target, wantType, wantedDisplay);
      if (!c) return null;
      const els = c.el.querySelectorAll("input[type=number]");
      return els.length ? els : null;
    }, 5000, 250);

    if (!nums) {
      const addBtn = await waitForTokin(() => {
        const c = tokBestArticle(target, wantType, wantedDisplay);
        if (!c) return null;
        const b = c.el.querySelector("[data-id=add-to-cart-button]");
        return b && !b.disabled ? b : null;
      }, 6000, 250);
      if (!addBtn) {
        out.message = isNoStock
          ? "encontrado pero sin stock" + unitNote
          : "sin botón Agregar habilitado" + unitNote;
        return out;
      }
      addBtn.click();
      nums = await waitForTokin(() => {
        const c = tokBestArticle(target, wantType, wantedDisplay);
        if (!c) return null;
        const els = c.el.querySelectorAll("input[type=number]");
        return els.length ? els : null;
      }, 8000, 250);
      if (!nums) {
        out.ok = true;
        out.message = "agregado sin poder fijar cantidad" + unitNote + out.message;
        return out;
      }
    }

    if (qty > 0) {
      for (const el of nums) tokSetValue(el, String(qty));
      await toksleep(600);
      out.ok = true;
      out.message = "agregado: " + qty + " " + wantUnit + unitNote + out.message;
    } else {
      out.ok = true;
      out.message = "agregado sin cantidad" + unitNote + out.message;
    }
    return out;
  }

  async function tokAdvance(job, ok) {
    tokProgress(
      "Cargando carrito: " + (job.index + 1) + " de " + job.total + " — " +
        String(job.items[job.index].producto || "").slice(0, 30),
      job.index,
      job.total,
      ok
    );
    job.index++;
    job.qIdx = 0;
    job.phase = "pending";
    if (job.index >= job.total) {
      job.phase = "done";
      await tokStoreSet(CART_JOB_KEY, job);
      return tokFinishCart(job);
    }
    await tokStoreSet(CART_JOB_KEY, job);
    return tokRunJob();
  }

  async function tokFinishCart(job) {
    await tokStoreRemove(CART_JOB_KEY);
    await tokStoreRemove(CART_CANCEL_KEY);
    setTokRun(false);
    const results = job.results || [];
    const okCount = results.filter((x) => x.ok).length;
    try {
      window.__TOKIN_RES__ = { done: true, ok: okCount, total: job.total, results };
    } catch (e) {}
    try {
      window.postMessage({ __tok: "cart-res", payload: { done: true, ok: okCount, total: job.total, results } }, "*");
    } catch (e) {}
    tokToastSet(
      "Pedido listo: " + okCount + " de " + job.total + " en el carrito",
      okCount === job.total ? "ok" : "err"
    );
    tokToastHide();
    try {
      chrome.runtime.sendMessage(
        { target: "offscreen", type: "CART_DONE", ok: true, total: job.total, results },
        () => { void chrome.runtime.lastError; }
      );
    } catch (e) {}
    try {
      const cartBtn = document.querySelector("[data-id=navbar-minicart-button]");
      if (cartBtn) cartBtn.click();
    } catch (e) {}
  }

  async function tokAbortCart(job) {
    await tokStoreRemove(CART_JOB_KEY);
    await tokStoreRemove(CART_CANCEL_KEY);
    setTokRun(false);
    tokToastSet("Carga cancelada.", "");
    try {
      window.postMessage(
        { __tok: "cart-res", payload: { done: true, canceled: true, total: (job && job.total) || 0, results: (job && job.results) || [] } },
        "*"
      );
    } catch (e) {}
    try {
      chrome.runtime.sendMessage(
        {
          target: "offscreen",
          type: "CART_DONE",
          canceled: true,
          total: (job && job.total) || 0,
          results: (job && job.results) || [],
        },
        () => { void chrome.runtime.lastError; }
      );
    } catch (e) {}
  }

  function resumeCart() {
    try {
      chrome.storage.local.get([CART_JOB_KEY, CART_CANCEL_KEY], (d) => {
        if (chrome.runtime.lastError) return;
        const cancel = d && d[CART_CANCEL_KEY];
        const job = d && d[CART_JOB_KEY];
        if (!job) return;
        if (cancel) {
          tokAbortCart(job);
          return;
        }
        if (job.phase === "searching" && location.href.indexOf("/store/search") !== -1) {
          setTokRun(true);
          tokRunJob();
        }
      });
    } catch (e) {}
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
        tokCartStart(msg.items || [])
          .then((out) => sendResponse({ ok: true, ...out }))
          .catch((err) => sendResponse({ ok: false, message: String(err) }));
        break;
      case "CANCEL_CART":
        cartCancel = true;
        tokStoreSet(CART_CANCEL_KEY, true);
        sendResponse({ ok: true });
        break;
      case "SHOW_PICKER":
        showFilePicker()
          .then((r) => sendResponse({ ok: true, ...r }))
          .catch((e) => sendResponse({ ok: false, message: String((e && e.message) || e) }));
        return true;
      default:
        sendResponse({ ok: false, message: "Tipo de mensaje desconocido" });
    }
    return true;
  });

  window.addEventListener("message", async (ev) => {
    try {
      const d = ev.data || {};
      if (d.__tok !== "cart-req") return;
      const payload = d.payload || {};
      if (payload.probe === "cartJob") {
        const job = await tokStoreGet(CART_JOB_KEY);
        window.postMessage({ __tok: "cart-res", payload: { ok: true, job } }, "*");
        return;
      }
      const out = await tokCartStart(payload.items || []);
      if (out && !out.ok) {
        window.postMessage({ __tok: "cart-res", payload: out }, "*");
      }
    } catch (err) {
      window.postMessage({ __tok: "cart-res", payload: { ok: false, message: String(err) } }, "*");
    }
  });

  function tokInjectBridge() {
    try {
      chrome.runtime.sendMessage({ type: "INJECT_MAIN_BRIDGE" }, () => { void chrome.runtime.lastError; });
    } catch (e) {}
  }

  resumeCart();

  tokInjectBridge();
})();
