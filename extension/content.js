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
      if (t.length < 3 || B.length > 80) continue;
      for (const u of B) {
        if (u.length < 3 || u[0] !== t[0]) continue;
        // Prefijo/abreviatura: "alf"~"alfajor", "top"~"topline", "xplos"~"xplosive".
        // Los usuarios suelen abreviar o escribir mal en el pedido.
        if (t.indexOf(u) === 0 || u.indexOf(t) === 0) {
          inter += 0.9;
          break;
        }
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

  // Nombre "nucleo": solo palabras de letras >= 2 chars, sin palabras de
  // función/unidad (x, gr, display, bulto…) para que el matcheo por prefijos
  // no falsee con "con"~"confitado" o "pack".
  function tokCoreName(s) {
    return tokNorm(s)
      .split(" ")
      .filter((w) => /^[a-z]{2,}$/.test(w) && !TOK_STOP.has(w))
      .join(" ");
  }

  // Compara dos palabras del nombre núcleo tolerando errores de tipeo del
  // pedido: iguales, prefijo/abreviatura ("alf"~"alfajor") o distancia 1.
  function tokWordMatch(a, b) {
    if (a === b) return true;
    if (a.length < 3 || b.length < 3) return false;
    if (a.indexOf(b) === 0 || b.indexOf(a) === 0) return true;
    if (Math.abs(a.length - b.length) > 1) return false;
    if (a[0] !== b[0]) return false;
    return tokLev(a, b) <= 1;
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
      if (!isNaN(v) && v > 0 && out.indexOf(v) === -1) out.push(v);
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
      // Gramaje comparado con redondeo: "73" == "73,5" (TOFI x73 vs ByN x73,5gr).
      for (const g of tg) if (ag.some((a) => Math.round(a) === Math.round(g))) {
        s += 0.2;
        break;
      }
    }
    return s;
  }

  // Extrae el código ARC-XXXX de una card y devuelve sus dígitos (o null).
  function tokArcCode(text) {
    const m = String(text || "").match(/ARC-(\d+)/i);
    return m ? m[1] : null;
  }

  // Empareja el código del pedido con el de la card: el SKU del archivo ("13357",
  // "11913" o "ARC-1013357") es sufijo del ARC del store ("ARC-1013357").
  function tokSkuMatch(cardText, sku) {
    const d = String(sku || "").replace(/\D+/g, "");
    if (!d) return false;
    const arc = tokArcCode(cardText);
    return !!arc && (arc.endsWith(d) || d.endsWith(arc));
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

  // De un botón de unidad ("x Display", "10% OFF x Bulto") devuelve el nombre
  // de la unidad normalizado ("Display") o "" si no se reconoce.
  function tokUnitLabelFromBtn(btnText) {
    const words = tokNorm(btnText).split(" ");
    const names = { display: "Display", bulto: "Bulto", unidad: "Unidad", caja: "Caja" };
    for (const key of ["display", "bulto", "unidad", "caja"]) {
      const aliases = TOK_UNIT_ALIASES[key];
      if (words.some((w) => aliases.some((al) => (al.length >= 3 ? w === al || w.indexOf(al) === 0 : w === al)))) {
        return names[key];
      }
    }
    return "";
  }

  // Parsea el texto de la card para extraer la conversión de unidad (v2.0.21).
  // Formato del store: "Display: 10 Uds / Bulto: 80 Uds = 8 Disp"
  // Retorna el factor de conversión (ej: 10) o 0 si no encuentra nada.
  function tokParseUnitConversion(cardText, wantType) {
    if (!cardText || !wantType) return 0;
    const norm = tokNorm(cardText);
    const typeAliases = TOK_UNIT_ALIASES[wantType] || [wantType];
    for (const alias of typeAliases) {
      const re = new RegExp(alias + "[:\\s]+(\\d+)\\s*Uds", "i");
      const m = norm.match(re);
      if (m) {
        const n = parseInt(m[1], 10);
        if (n > 0 && n <= 999) return n;
      }
    }
    return 0;
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

  // La unidad pedida es MÁXIMA jerarquía SOLO para el matcheo por nombre. Si el
  // pedido trae sku y existe la card del store con ese código (ARC-sufijo), esa
  // card ES el producto: es candidata aunque no ofrezca la unidad pedida (y en
  // ese caso se agrega en la unidad disponible, nunca otro producto). Sin
  // código, solo entran cards que ofrezcan el botón exacto de la unidad (o
  // "unidad"/"sin stock" sin selector). El producto debe compartir palabras
  // núcleo exactas o tolerables (abreviaturas como "alf"~"alfajor", "top"~
  // "topline", palabras repetidas). El gramaje es señal de desempate con
  // redondeo (73 ≈ 73,5). Entre cards válidos gana el que comparte más palabras
  // y mejor puntaje; el CÓDIGO del pedido (sku) es desempate principal.
  function tokBestArticle(target, wantType, wantedGrams, sku) {
    const arts = Array.from(document.querySelectorAll("article")).filter(
      (a) => a.getAttribute("data-id") !== "cart-product-card" && tokIsProductCard(a)
    );
    if (!arts.length) return null;
    const targetCore = Array.from(new Set(tokCoreName(target).split(" ").filter(Boolean)));
    const parsed = [];
    for (let i = 0; i < arts.length; i++) {
      const a = arts[i];
      const t = (a.innerText || "").replace(/\s+/g, " ");
      const btns = Array.from(a.querySelectorAll("[data-id=sku-selector-button]"));
      const cardCore = Array.from(new Set(tokCoreName(t).split(" ").filter(Boolean)));
      let shared = 0;
      for (const w of targetCore) {
        if (cardCore.some((c) => tokWordMatch(w, c))) shared++;
      }
      parsed.push({
        el: a,
        btns,
        codeMatch: tokSkuMatch(t, sku),
        shared,
        score: tokArticleScore(target, t),
      });
    }
    // 1) Código del pedido (v2.0.14): si la línea trae sku, el código es GATE
    // ESTRICTO — SOLO las cards cuyo ARC-XXXX termina con ese sku son candidatas.
    // Si el código no existe en el store (código mal leído o producto no
    // cargado) la línea se reporta "no se encontró": el nombre solo verifica,
    // nunca sustituye un producto distinto (ej. TOFI 2848 no está en el store).
    // Las líneas SIN sku (Excel sin columna código) siguen matcheando por nombre.
    const byCode = parsed.filter((p) => p.codeMatch);
    const pool = String(sku || "").trim() ? byCode : parsed.filter((p) => p.shared > 0);
    if (!pool.length) return null;
    let best = null;
    for (let i = 0; i < pool.length; i++) {
      const p = pool[i];
      if (!p.codeMatch) {
        // Sin código: filtro duro de unidad.
        const t = (p.el.innerText || "");
        const isNoStock = /sin stock/i.test(t);
        const hasSelector = p.btns.length > 0;
        let hasWanted;
        if (!wantType) {
          hasWanted = true;
        } else if (hasSelector) {
          hasWanted = p.btns.some((b) => tokUnitBtnMatch(b.innerText || "", wantType));
        } else {
          hasWanted = wantType === "unidad" || isNoStock;
        }
        if (!hasWanted) continue;
      }
      const better =
        !best ||
        (p.codeMatch && !best.codeMatch) ||
        (p.codeMatch === best.codeMatch &&
          (p.shared > best.shared || (p.shared === best.shared && p.score > best.score)));
      if (better) {
        best = { el: p.el, btns: p.btns, score: p.score, shared: p.shared, codeMatch: p.codeMatch };
      }
    }
    return best;
  }

  // El candidato ya pasó los filtros exactos (unidad + gramaje + producto).
  function tokAccept(cand) {
    return !!cand;
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
  // amplia, siempre filtradas por la unidad de venta pedida. El pack ("18x40g")
  // se descarta dejando el gramaje ("40g"), porque el store busca mejor por
  // gramos; si no aparece nada se prueba sin números y por marca.
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
    const unitWord = tokNorm(tokUnitLabel(item)); // bulto|display|unidad
    const grams = tokGrams(raw);
    const g0 = grams.length ? grams[0] : null;
    const gramToken = g0 != null && Number.isInteger(g0) ? String(g0) + "g" : "";
    // 1) SKU exacto del pedido (ARC-XXXX), si existe: es la búsqueda más precisa
    const sku = String(item.sku || "").trim();
    if (sku) push(sku);
    // 2) con el gramaje limpio ("ROCKLETS CONFITADOS 18x40g" -> "... 40g") + unidad
    push(
      raw.replace(/\b(\d+)\s*[x×]\s*(\d+)\s*(?:g|gr|grs|gramos?)?\b/gi, "$2g") +
        (unitWord ? " " + unitWord : "")
    );
    // 3) palabras núcleo + gramaje + unidad
    const words = tokNorm(raw)
      .replace(/\d+/g, " ")
      .split(" ")
      .filter((w) => w.length >= 3 && !TOK_STOP.has(w))
      .join(" ");
    push(words + (gramToken ? " " + gramToken : "") + (unitWord ? " " + unitWord : ""));
    // 4) primera palabra núcleo + unidad (amplia)
    push((words.split(" ")[0] || "") + (unitWord ? " " + unitWord : ""));
    // 5-7) sin unidad ni gramaje: el buscador del store exige AND de todos los
    // términos, así que "display"/"14g" rompen la búsqueda; al final quedan las
    // palabras clave, dos palabras y la marca sola (ej: "sonrisas", "top line").
    push(words);
    push(words.split(" ").slice(0, 2).join(" "));
    push(words.split(" ")[0] || "");
    return out;
  }

  function setTokRun(on) {
    try {
      window.__TOKIN_RUN__ = !!on;
      if (!on) window.__TOKIN_RES__ = null;
    } catch (e) {}
  }

  async function tokCartStart(items, tabId, filename) {
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
    // Total por producto (sku|unidad) en TODO el pedido: el store usa
    // semántica de FIJAR cantidad (set), así que cuando el mismo producto
    // aparece en varias líneas (ej. MENTA x810 x2 y x2, REX x75 x12 y x5) la
    // card del carrito debe quedar en la SUMA, no en el valor de una línea.
    const totals = {};
    for (const it of clean) {
      const key = String(it.sku || "").replace(/\D+/g, "") + "|" + tokNorm(tokUnitLabel(it));
      const q = Math.floor(Number(String(it.cantidad || "").replace(/[^\d.]/g, ""))) || 0;
      totals[key] = (totals[key] || 0) + q;
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
      productTotals: totals,
      // El job queda ligado a la pestaña y a la sesión que lo lanzó: si la
      // pestaña se cierra, se cierra la sesión o pasa demasiado tiempo, la
      // automatización NO se reanuda sola desde una sesión anterior.
      tabId: tabId || null,
      email: getSessionInfo().email,
      started: Date.now(),
      // Nombre del documento ingestado, para el informe de cierre de la tarea.
      docName: String(filename || ""),
    };
    await tokStoreRemove(CART_CANCEL_KEY);
    await tokStoreSet(CART_JOB_KEY, job);
    setTokRun(true);
    tokToastSet("Preparando carrito (0/" + job.total + ")", "");
    tokRunJob();
    return { ok: true, started: true, total: clean.length };
  }

  // Motivo de cancelación: "stop" = interrupción del sistema (pestaña o sesión
  // cerrada, lote huérfano) → volver al paso de líneas; "user" = cancelación
  // explícita → marcar canceled.
  async function tokCancelReason() {
    const v = await tokStoreGet(CART_CANCEL_KEY);
    return v === "stop" ? "stop" : v ? "user" : "";
  }

  async function tokRunJob() {
    try {
      const job = await tokStoreGet(CART_JOB_KEY);
      if (!job || job.phase === "done") return;
      // Si la sesión de Tokin se cerró, se frena todo (sin reanudar después).
      if (job.email && getSessionInfo().email !== job.email) return tokAbortCart(job, true);
      const reason = cartCancel ? "user" : await tokCancelReason();
      if (reason) return tokAbortCart(job, reason === "stop");
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

  // Estado real del carrito de Tokin desde el DOM: las cards del drawer
  // (article[data-id=cart-product-card]) están siempre en el DOM, aunque
  // ocultas, y sus inputs reflejan las unidades. El store usa semántica de
  // FIJAR cantidad (set), no de sumar: al agregar un producto que ya está en
  // el carrito, su qty pasa al valor pedido (no se acumula). Por eso la
  // verificación es por PRODUCTO (la qty de la card del carrito debe quedar
  // igual al valor pedido), no por delta de unidades totales.
  function tokCartCards() {
    return Array.from(document.querySelectorAll("article[data-id=cart-product-card]")).map((a) => {
      const sizeEl = a.querySelector("[data-id^=unit-size-ARC-]");
      const code = sizeEl ? tokArcCode(sizeEl.getAttribute("data-id")) : null;
      return {
        name: (a.innerText || "").replace(/\s+/g, " ").trim(),
        code,
        qty: parseInt(String((a.querySelector("input[type=number]") || {}).value || "").replace(/\D+/g, ""), 10) || 0,
      };
    });
  }

  // Card del carrito que corresponde al producto que acabamos de agregar.
  // El store deja SIN nombre de producto las cards agregadas eligiendo unidad
  // por pestaña (empiezan con "x Bulto (216 Uds)" / "x Display (18 Uds)"):
  // además de la similitud por nombre se acepta esa card si su qty alcanza la
  // pedida y su texto empieza con la unidad usada. Si conocemos el CÓDIGO
  // ARC-XXXX de la card del store (v2.0.10), el código es señal inequívoca:
  // la card del carrito que lo lleve es la del producto, por más que el nombre
  // haya quedado sin producto o con tipeo distinto al buscado.
  function tokCartFindProduct(cards, storeText, unitLabel, wantQty, code) {
    const un = tokNorm(unitLabel);
    const want = tokArcCode(String(code || ""));
    let best = null;
    for (const c of cards) {
      if (c.qty < wantQty) continue;
      let s;
      if (want && c.code) {
        if (c.code === want) s = 3;
        else if (c.code.endsWith(want) || want.endsWith(c.code)) s = 2.5;
        else continue;
      } else {
        const text = c.name;
        const norm = tokNorm(text);
        const unnamedUnit = un.length > 0 && norm.indexOf("x " + un) === 0;
        s = tokSim(storeText, text) + (unnamedUnit ? 0.5 : 0);
        if (s <= 0) continue;
      }
      if (!best || s > best.score) best = { qty: c.qty, score: s };
    }
    return best;
  }

  // Variante para el cierre del lote (informe): SOLO confirma si hay UNA card
  // candidata para el producto/unidad/qty pedida. Si hay más de una con el
  // mismo puntaje (ej. dos productos distintos agregados por la misma unidad
  // con texto "x Bulto"), NO confirma: queda para revisión manual y el informe
  // no cuenta de más ("agregado" solo si es inequívoco). Con el código (v2.0.10)
  // el ARC-XXXX identifica la card exacta del producto.
  function tokCartFindUnique(cards, storeText, unitLabel, wantQty, code) {
    const un = tokNorm(unitLabel);
    const want = tokArcCode(String(code || ""));
    let best = null;
    let n = 0;
    for (const c of cards) {
      if (c.qty < wantQty) continue;
      const text = c.name;
      let s;
      if (want && c.code) {
        if (c.code === want) s = 3;
        else if (c.code.endsWith(want) || want.endsWith(c.code)) s = 2.5;
        else continue;
      } else {
        const norm = tokNorm(text);
        const unnamedUnit = un.length > 0 && norm.indexOf("x " + un) === 0;
        s = tokSim(storeText, text) + (unnamedUnit ? 0.5 : 0);
        if (s <= 0) continue;
      }
      if (!best || s > best.score) {
        best = { qty: c.qty, score: s };
        n = 1;
      } else if (s === best.score) {
        n++;
      }
    }
    return n === 1 ? best : null;
  }

  async function tokProcessCurrentItem() {
    const job = await tokStoreGet(CART_JOB_KEY);
    if (!job) return;
    const reason = cartCancel ? "user" : await tokCancelReason();
    if (reason) return tokAbortCart(job, reason === "stop");
    const it = job.items[job.index];
    // Además del resultado, se guardan los datos para la RE-CONFIRMACIÓN final
    // del cierre (tokFinalVerify): texto de la card del store, unidad usada y
    // cantidad agregada, para volver a matchear la card del carrito cuando el
    // estado del drawer ya está estable.
    const r = { producto: it.producto || it.sku || "", ok: false, message: "", storeName: "", usedUnit: "", added: 0, storeText: "" };
    try {
      const target = String(it.producto || it.sku || "").trim();
      if (!target) {
        r.message = "sin nombre de producto";
        job.results.push(r);
        return tokAdvance(job, false);
      }
      const wantUnit = tokUnitLabel(it);
      const wantType = tokNorm(wantUnit);
      const wantedGrams = tokGrams(String(it.producto || "") + " " + String(it.unidad || ""));
      const queries = tokBuildQueries(it);
      // Cantidad total del producto en el pedido (suma de líneas duplicadas).
      const wantKey = String(it.sku || "").replace(/\D+/g, "") + "|" + tokNorm(wantUnit);
      const wantQty = (job.productTotals || {})[wantKey] || 0;

      const cand = await waitForTokin(
        () => tokBestArticle(target, wantType, wantedGrams, it.sku),
        12000,
        350
      );
      if (!cand || !tokAccept(cand)) {
        job.qIdx++;
        job.phase = "pending";
        await tokStoreSet(CART_JOB_KEY, job);
        return tokRunJob();
      }
      const out = await tokProcessCard(cand, it, target, wantType, wantUnit, wantedGrams, wantQty);
      Object.assign(r, out);
      const storeText = cand.el.innerText || "";
      r.storeText = storeText;
      // Código ARC-XXXX de la card del store elegida (v2.0.10): la verificación
      // del carrito lo usa como señal inequívoca (la card del carrito lo lleva
      // en data-id=unit-size-ARC-...). Si la primera fijación de cantidad se
      // perdió en un re-render de React (la SPA cambia la URL a &size=n_20_n y
      // remonta las cards), se RE-aplica la qty DIRECTAMENTE en la card del
      // carrito (por su código) y en la card del store, y se vuelve a verificar.
      const code = tokArcCode(storeText);
      if (r.ok && out.added > 0) {
        // Confirmar por PRODUCTO que la línea realmente se cargó (semántica
        // SET: la card del carrito debe quedar con la qty pedida).
        let hit = null;
        let confirmed = false;
        for (let i = 0; i < 8 && !confirmed; i++) {
          if (i > 0) {
            // 1) re-aplicar la qty en la card del carrito por su CÓDIGO (la card
            // real puede estar sin nombre de producto, pero conserva el ARC).
            if (code) {
              const cart = tokCartCards();
              const mine = cart.find((c) => c.code && (c.code === code || c.code.endsWith(code) || code.endsWith(c.code)));
              if (mine && mine.qty < out.added) {
                const cartEl = document.querySelectorAll("article[data-id=cart-product-card]");
                for (const el of cartEl) {
                  const sc = tokArcCode((el.querySelector("[data-id^=unit-size-ARC-]") || {}).getAttribute ? (el.querySelector("[data-id^=unit-size-ARC-]").getAttribute("data-id") || "") : "");
                  if (sc && (sc === code || sc.endsWith(code) || code.endsWith(sc))) {
                    const inp = el.querySelector("input[type=number]");
                    if (inp) tokSetValue(inp, String(out.added));
                    break;
                  }
                }
              }
            }
            // 2) re-aplicar la cantidad sobre la card del store (fallback previo).
            const els = await waitForTokin(
              () => {
                const c = tokBestArticle(target, wantType, wantedGrams, it.sku);
                if (!c) return null;
                const ins = Array.from(c.el.querySelectorAll("input[type=number]")).filter(
                  (e) => e.offsetParent !== null
                );
                return ins.length ? ins : null;
              },
              5000,
              250
            );
            if (els) for (const el of els) tokSetValue(el, String(out.added));
            await toksleep(600);
          }
          hit = tokCartFindProduct(tokCartCards(), storeText, out.usedUnit || "", out.added, code);
          confirmed = !!hit;
          if (!confirmed) await toksleep(700);
        }
        if (!confirmed) {
          r.ok = false;
          r.message =
            "no se confirmó en el carrito (pedido " + out.added + (hit ? ", card qty " + hit.qty : ", sin card") + ")";
        }
      }
    } catch (e) {
      r.message = "error: " + String((e && e.message) || e).slice(0, 140);
    }
    job.results.push(r);
    return tokAdvance(job, r.ok);
  }

  async function tokProcessCard(cand, it, target, wantType, wantUnit, wantedGrams, wantQty) {
    const card = cand.el;
    const cardText = (card.innerText || "").replace(/\s+/g, " ").trim();
    const out = { ok: false, message: "", storeName: cardText.slice(0, 90), added: 0, usedUnit: wantUnit };

    let unitBtn = null;
    let usedUnit = wantUnit;
    let unitNote = "";
    const btns = Array.from(card.querySelectorAll("[data-id=sku-selector-button]"));
    if (wantType && btns.length) {
      unitBtn = btns.find((x) => tokUnitBtnMatch(x.innerText || "", wantType)) || null;
    }
    if (unitBtn) {
      unitBtn.click();
      await toksleep(1500);
    } else if (btns.length) {
      if (cand.codeMatch) {
        // Producto confirmado por CÓDIGO: la card no ofrece la unidad pedida.
        // v2.0.21: si la card muestra la conversión (ej. "Display: 10 Uds"),
        // se piden las unidades convertidas en vez de 1 unidad suelta.
        const uName = tokUnitLabelFromBtn(btns[0].innerText || "");
        const conv = tokParseUnitConversion(cardText, wantType);
        if (conv > 0 && wantType !== "unidad" && wantType !== (uName || "").toLowerCase()) {
          // La card tiene la conversión: wantQty Display/Bulto → wantQty * conv Unidades.
          const convertedQty = wantQty * conv;
          if (convertedQty > 999) {
            out.ok = false;
            out.message =
              "no se agregó: " + wantQty + " " + wantUnit + " = " + convertedQty +
              " unidades, supera el límite de 999 del store";
            return out;
          }
          unitBtn = btns[0];
          usedUnit = "Unidad";
          unitNote = " (" + wantQty + " " + wantUnit + " = " + convertedQty + " Unidad)";
          unitBtn.click();
          await toksleep(1500);
          // Reemplazar wantQty por la cantidad convertida para que se setee en el input.
          wantQty = convertedQty;
        } else {
          // v2.0.22: sin conversión y sin botón de la unidad pedida: NO se
          // agrega en otra unidad. El usuario pide Display/Bulto y la card no
          // ofrece esa unidad ni tiene info de conversión.
          out.ok = false;
          out.message =
            "la card no ofrece " + wantUnit +
            " ni conversión (solo " + (uName || "otra unidad") + ")";
          return out;
        }
      } else {
        // Sin código confirmado: NO se elige otra unidad, el pedido pide esa.
        out.message = "la card no ofrece el botón de " + wantUnit + " pedido";
        out.ok = false;
        return out;
      }
    }

    const isNoStock = /sin stock/i.test(cardText);
    const qty = Math.floor(Number(String(it.cantidad || "").replace(/[^\d.]/g, ""))) || 0;

    if (qty > 999) {
      out.ok = false;
      out.message =
        "cantidad " + it.cantidad + " parece un error de lectura (límite 999): " +
        "corregila en la tabla y volvé a enviar";
      return out;
    }

    let nums = await waitForTokin(() => {
      const c = tokBestArticle(target, wantType, wantedGrams, it.sku);
      if (!c) return null;
      const els = c.el.querySelectorAll("input[type=number]");
      return els.length ? els : null;
    }, 5000, 250);

    if (!nums) {
      const addBtn = await waitForTokin(() => {
        const c = tokBestArticle(target, wantType, wantedGrams, it.sku);
        if (!c) return null;
        const b = c.el.querySelector("[data-id=add-to-cart-button]");
        return b && !b.disabled ? b : null;
      }, 6000, 250);
      if (!addBtn) {
        out.message = isNoStock
          ? "encontrado pero sin stock"
          : "sin botón Agregar habilitado";
        out.ok = !!isNoStock;
        return out;
      }
      addBtn.click();
      nums = await waitForTokin(() => {
        const c = tokBestArticle(target, wantType, wantedGrams, it.sku);
        if (!c) return null;
        const els = c.el.querySelectorAll("input[type=number]");
        return els.length ? els : null;
      }, 8000, 250);
      if (!nums) {
        out.ok = true;
        out.added = wantQty > 0 ? wantQty : 1;
        out.usedUnit = usedUnit;
        out.message = "agregado sin poder fijar cantidad" + unitNote;
        return out;
      }
    }

    if (wantQty > 0) {
      for (const el of nums) if (el.offsetParent !== null) tokSetValue(el, String(wantQty));
      await toksleep(600);
      // v2.0.21: si hubo conversión (Display/Bulto → Unidades), verificar que
      // el store aceptó la cantidad completa. Si el store capó la qty (stock
      // insuficiente),.reportar el límite en vez de reportar "agregado".
      let actualQty = wantQty;
      if (unitNote && unitNote.indexOf("=") !== -1) {
        for (const el of nums) {
          if (el.offsetParent !== null) {
            const v = parseInt(String(el.value || "").replace(/\D+/g, ""), 10);
            if (v > 0 && v < actualQty) actualQty = v;
          }
        }
      }
      out.ok = true;
      out.added = actualQty;
      out.usedUnit = usedUnit;
      if (actualQty < wantQty && unitNote && unitNote.indexOf("=") !== -1) {
        out.ok = false;
        out.message =
          "no se agregó: el store solo tiene " + actualQty + " unidades" +
          " (necesitaba " + wantQty + " para cubrir" + unitNote + ")";
      } else if (actualQty !== qty) {
        // productTotals fusionó líneas duplicadas: el carrito tiene la suma,
        // pero el mensaje refleja lo que ESTA línea pidió.
        out.message = "agregado: " + qty + " " + usedUnit + unitNote +
          " (acumulado en carrito: " + actualQty + ")";
      } else {
        out.message = "agregado: " + qty + " " + usedUnit + unitNote;
      }
    } else {
      out.ok = true;
      out.message = "agregado sin cantidad" + unitNote;
    }
    // v2.0.13: el set en la card del STORE puede enviar updateCart con la
    // variante de la unidad que la card muestra (para un producto YA en el
    // carrito la card queda mostrando Unidad/Display aunque el ítem sea Bulto)
    // y el servidor no la aplica: la card del carrito queda corta aunque el DOM
    // la muestre optimista (React comparte el estado local). El input de la
    // card del CARRITO (misma unidad que el ítem) sí persiste (verificado
    // contra el servidor), así que la cantidad se fija SIEMPRE ahí también,
    // forzando un cambio si el DOM ya muestra el valor pedido (un set al mismo
    // valor no dispara el onChange de React y el servidor quedaría corto).
    if (out.ok && wantQty > 0) {
      const code = tokArcCode(cardText);
      if (code) {
        const cartInp = await waitForTokin(() => {
          for (const el of document.querySelectorAll("article[data-id=cart-product-card]")) {
            const sc = tokArcCode(
              (el.querySelector("[data-id^=unit-size-ARC-]") || { getAttribute: () => "" }).getAttribute("data-id") || ""
            );
            if (sc && (sc === code || sc.endsWith(code) || code.endsWith(sc))) {
              const inp = el.querySelector("input[type=number]");
              if (inp) return inp;
            }
          }
          return null;
        }, 6000, 250);
        if (cartInp) {
          const cur = parseInt(String(cartInp.value || "").replace(/\D+/g, ""), 10) || 0;
          if (cur === wantQty && wantQty > 1) {
            tokSetValue(cartInp, String(wantQty - 1));
            await toksleep(250);
          }
          tokSetValue(cartInp, String(wantQty));
          await toksleep(500);
        }
      }
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
      // Cierre de la tarea: re-confirmación final contra el carrito ya estable,
      // para que el informe sea completo y real (ver tokFinalVerify).
      await tokFinalVerify(job);
      return tokFinishCart(job);
    }
    await tokStoreSet(CART_JOB_KEY, job);
    return tokRunJob();
  }

  // Re-confirmación final al terminar el lote. Tiene dos partes:
  // 1) RE-FIJAR cantidad: una card que quedó "agregado: N Bulto" durante la
  //    corrida puede quedar corta DESPUÉS, porque el re-render de React / la
  //    sincronización con el servidor la resetea a la unidad mínima (1) cuando
  //    la siguiente navegación recarga el carrito desde el servidor (el
  //    tokSetValue sobre la card del store no siempre registra a tiempo). Al
  //    cierre no hay más navegaciones: se setea la qty directo en la card del
  //    carrito (por su código ARC) y la actualización persiste (igual que el
  //    fix GOAT de v2.0.10). Así el informe y el carrito final coinciden.
  // 2) RE-CONFIRMAR las líneas "no se confirmó" que en realidad sí quedaron con
  //    su card y qty pedida (estado del drawer ya estable).
  async function tokFinalVerify(job) {
    try {
      await toksleep(1500);
      const results = job.results || [];
      let changed = 0;
      let cards = tokCartCards();

      for (const r of results) {
        if (!(r.ok && String(r.message || "").indexOf("agregado") === 0)) continue;
        const wantQty = r.added || 0;
        if (!wantQty) continue;
        const code = tokArcCode(r.storeText || "");
        // No se salta si el DOM ya muestra la qty pedida: ese valor puede ser
        // OPTIMISTA (React comparte el estado local) mientras el servidor quedó
        // corto; un set al mismo valor no dispara el onChange, por eso se fuerza
        // un cambio real (wantQty-1 -> wantQty) para que updateCart regrese la
        // qty al servidor.
        let hit = null;
        for (let i = 0; i < 8; i++) {
          const cartEls = document.querySelectorAll("article[data-id=cart-product-card]");
          for (const el of cartEls) {
            const sizeEl = el.querySelector("[data-id^=unit-size-ARC-]");
            const sc = sizeEl ? tokArcCode(sizeEl.getAttribute("data-id") || "") : null;
            if (sc && (sc === code || sc.endsWith(code) || code.endsWith(sc))) {
              const inp = el.querySelector("input[type=number]");
              if (inp) {
                const cur = parseInt(String(inp.value || "").replace(/\D+/g, ""), 10) || 0;
                if (cur === wantQty && wantQty > 1) {
                  tokSetValue(inp, String(wantQty - 1));
                  await toksleep(250);
                }
                tokSetValue(inp, String(wantQty));
              }
              break;
            }
          }
          await toksleep(1000);
          cards = tokCartCards();
          hit = tokCartFindProduct(cards, r.storeText || "", r.usedUnit || "", wantQty, code);
          if (hit && hit.qty >= wantQty) break;
        }
        if (hit && hit.qty >= wantQty) {
          changed++;
        } else {
          // La card no llegó a la qty pedida (o no existe): el informe no debe
          // contar de más, se marca como no confirmado con su qty real.
          r.ok = false;
          r.message = "no se confirmó en el cierre (card qty " + (hit ? hit.qty : "sin card") + ")";
        }
      }

      for (const r of results) {
        if (r.ok) continue;
        if (String(r.message || "").indexOf("no se confirmó") !== 0) continue;
        const wantQty = r.added || 0;
        if (!wantQty) continue;
        const hit = tokCartFindUnique(cards, r.storeText || "", r.usedUnit || "", wantQty, r.storeText);
        if (!hit) continue;
        r.ok = true;
        r.message =
          "agregado: " + wantQty + " " + (r.usedUnit || "").trim() + " (confirmado en el cierre)";
        changed++;
      }
      if (changed) await tokStoreSet(CART_JOB_KEY, job);
      return changed;
    } catch (e) {
      return 0;
    }
  }

  async function tokFinishCart(job) {
    await tokStoreRemove(CART_JOB_KEY);
    await tokStoreRemove(CART_CANCEL_KEY);
    setTokRun(false);
    const results = job.results || [];
    // "Agregado" = lo que REALMENTE quedó en el carrito (message empieza con
    // "agregado"). "sin stock"/"no se encontró"/"no se confirmó" NO suman.
    const isAdded = (x) => x.ok && String(x.message || "").indexOf("agregado") === 0;
    const added = results.filter(isAdded).length;
    // "En el carrito: N productos" se cuenta por la IDENTIDAD que usa el carrito
    // (el código ARC de la card donde cayó la línea), no por el texto de la
    // línea: si dos líneas (aunque tengan descripción distinta) quedaron en la
    // MISMA card, son UN producto (semántica SET). Ej. CUENCA: el PDF lista el
    // código 14800 en "SANDIA x500" y "FRUTILLA x500" (error del proveedor) y el
    // gate por código las rutea a la misma card ARC-1014800 -> 41 líneas
    // "agregado" pero 40 cards reales.
    const prodKey = (x) => {
      const code = tokArcCode(x.storeText || "");
      return code ? "c:" + code : "t:" + String(x.producto || "").trim();
    };
    const prodAdded = new Set(results.filter(isAdded).map(prodKey)).size;
    const sinStock = results.filter((x) => !isAdded(x) && /sin stock/i.test(x.message || "")).length;
    const notFound = results.filter((x) => !isAdded(x) && /no se encontró/i.test(x.message || "")).length;
    const notConfirmed = results.filter((x) => !isAdded(x) && String(x.message || "").indexOf("no se confirmó") === 0).length;
    const docName = job.docName || "";
    const summary = { done: true, ok: added, total: job.total, results, docName, sinStock, notFound, notConfirmed, prodAdded };
    try {
      window.__TOKIN_RES__ = summary;
    } catch (e) {}
    try {
      window.postMessage({ __tok: "cart-res", payload: summary }, "*");
    } catch (e) {}
    tokToastSet(
      "Pedido listo: " + added + " de " + job.total + " en el carrito",
      added === job.total ? "ok" : "err"
    );
    tokToastHide();
    try {
      chrome.runtime.sendMessage(
        {
          target: "offscreen", type: "CART_DONE", ok: true, total: job.total, results, docName,
          sinStock, notFound, notConfirmed, prodAdded,
        },
        () => { void chrome.runtime.lastError; }
      );
    } catch (e) {}
    try {
      const cartBtn = document.querySelector("[data-id=navbar-minicart-button]");
      if (cartBtn) cartBtn.click();
    } catch (e) {}
  }

  async function tokAbortCart(job, interrupted) {
    await tokStoreRemove(CART_JOB_KEY);
    await tokStoreRemove(CART_CANCEL_KEY);
    setTokRun(false);
    tokToastSet(interrupted ? "Tarea interrumpida (pestaña o sesión cerrada)." : "Carga cancelada.", "");
    try {
      // interrupted: la pestaña/sesión se cerró o el lote quedó huérfano → el
      // offscreen vuelve al paso de líneas capturadas (CART_STOP), no a
      // "canceled": la tarea no terminó con confirmación del usuario.
      chrome.runtime.sendMessage(
        interrupted
          ? { target: "offscreen", type: "CART_STOP" }
          : {
              target: "offscreen",
              type: "CART_DONE",
              canceled: true,
              total: (job && job.total) || 0,
              results: (job && job.results) || [],
            },
        () => { void chrome.runtime.lastError; }
      );
    } catch (e) {}
    try {
      window.postMessage(
        { __tok: "cart-res", payload: { done: true, canceled: true, total: (job && job.total) || 0, results: (job && job.results) || [] } },
        "*"
      );
    } catch (e) {}
  }

  function tokGetTabId() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "GET_TAB_ID" }, (r) => {
          resolve((r && r.ok && r.tabId) || null);
        });
      } catch (e) { resolve(null); }
    });
  }

  // Reanudar tras una navegación del MISMO lote. Se exige que el job siga
  // siendo de la MISMA pestaña y de la MISMA sesión de Tokin y que no esté
  // vencido: un job huérfano de una sesión anterior (pestaña cerrada, logout,
  // tiempo) se aborta y NO se reanuda.
  async function resumeCart() {
    try {
      const d = await new Promise((res) =>
        chrome.storage.local.get([CART_JOB_KEY, CART_CANCEL_KEY], (x) => res(x || {}))
      );
      const cancel = d[CART_CANCEL_KEY];
      const job = d[CART_JOB_KEY];
      if (!job) return;
      if (cancel) return tokAbortCart(job, cancel === "stop");
      const email = getSessionInfo().email;
      const lostSession = (job.email && (!email || email !== job.email));
      const stale = lostSession || (job.started && Date.now() - job.started > 60 * 60 * 1000);
      if (stale) return tokAbortCart(job, true);
      if (job.tabId) {
        const me = await tokGetTabId();
        if (!me || me !== job.tabId) return tokAbortCart(job, true);
      }
      if (job.phase === "searching" && location.href.indexOf("/store/search") !== -1) {
        setTokRun(true);
        tokRunJob();
      }
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
        tokCartStart(msg.items || [], msg.tabId, msg.filename)
          .then((out) => sendResponse({ ok: true, ...out }))
          .catch((err) => sendResponse({ ok: false, message: String(err) }));
        break;
      case "CANCEL_CART":
        cartCancel = true;
        tokStoreSet(CART_CANCEL_KEY, "user");
        sendResponse({ ok: true });
        break;
      case "OPEN_CART":
        // El botón "Abrir store" del popup abre el CARRITO (drawer del store).
        try {
          const b = document.querySelector("[data-id=navbar-minicart-button]");
          if (b) b.click();
        } catch (e) {}
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
      const out = await tokCartStart(payload.items || [], null, payload.filename || "");
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
