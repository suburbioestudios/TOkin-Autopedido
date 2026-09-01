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

  // v2.0.27: latido del lote. El watchdog lo usa para distinguir "la cadena de
  // ejecución sigue viva y avanzando" de "el loop murió sin dejar rastro"
  // (service worker reiniciado, excepción tragada, pestaña a medio cargar).
  let tokLastBeat = Date.now();
  function toksleep(ms) {
    tokLastBeat = Date.now();
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
      tokLastBeat = Date.now();
      try {
        const v = fn();
        if (v) return v;
      } catch (e) {}
      if (Date.now() - start > timeout) return null;
      await toksleep(interval);
    }
  }

  // v2.0.23: verificación de conectividad antes de cada búsqueda.
  // Si no hay internet, se frena el job y se avisa al usuario.
  async function tokCheckNet() {
    try {
      const ctrl = new AbortController();
      const tid = setTimeout(function() { ctrl.abort(); }, 5000);
      const r = await fetch("https://tokintienda.com.ar/store", {
        method: "HEAD",
        mode: "no-cors",
        cache: "no-store",
        signal: ctrl.signal,
      });
      clearTimeout(tid);
      return true;
    } catch (e) {
      return false;
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
    // v2.0.26: exigir 4+ dígitos. Un código degradado tipo "ama3" queda reducido
    // a d="3": sin este guard matchearía CUALQUIER card cuyo ARC termine en 3.
    if (d.length < 4) return false;
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
  function tokBestArticle(target, wantType, wantedGrams, sku, byName) {
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
    // v2.0.29: con sku el CÓDIGO es GATE ESTRICTO y el pool es solo byCode.
    // Pero cuando la búsqueda por código NO encontró la card (fallback a
    // nombre), byName=true desactiva el gate: se matchea por nombre + unidad
    // aunque la línea traiga sku. Es seguro porque en ese punto ya verificamos
    // que el código no existe en el store.
    const pool = !byName && String(sku || "").trim() ? byCode : parsed.filter((p) => p.shared > 0);
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
  // v2.0.27: pausa máxima que se auto-reanuda sola (30 min) y umbral de
  // inactividad a partir del cual el watchdog considera muerto el loop del
  // lote (todos los waits del flujo quedan muy por debajo de este valor).
  const TOK_PAUSE_MAX_MS = 30 * 60 * 1000;
  const TOK_STALE_MS = 15000;
  let tokChainAlive = false;

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
    const skuRaw = String(item.sku || "").trim();
    const skuDigits = skuRaw.replace(/\D+/g, "");
    const raw = String(item.producto || "").trim();
    let out = [];
    const seen = new Set();
    const push = (q) => {
      q = String(q || "").replace(/\s+/g, " ").trim();
      const key = tokNorm(q);
      if (q && !seen.has(key)) {
        seen.add(key);
        out.push(q);
      }
    };
    // v2.0.29: si la línea trae un CÓDIGO legible (4+ dígitos), la PRIMERA
    // búsqueda es SOLO por código (gate real v2.0.14): nunca agrega un producto
    // distinto cuando el pedido existe en el store. Pero si el código NO se
    // encuentra en el store (producto no cargado o código mal leído), se cae a
    // la búsqueda por NOMBRE con las queries de más abajo, para que la línea
    // igualmente pueda cargarse. Con un código degradado por el OCR
    // ("ama3", <4 dígitos) no hay matcheo seguro contra el ARC: se va directo a
    // BUSCAR POR NOMBRE (sin query de código), nunca a abortar.
    if (skuRaw && !skuDigits.length) {
      // código pero sin ningún dígito: no matchea ARC de todos modos → por nombre
    } else if (skuDigits.length >= 4) {
      push(skuRaw);
    }
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
    // v2.0.23: si hay un job pausado (interrupción de internet), reanudarlo
    // en vez de bloquear. El usuario ya tiene los items en el carrito.
    if (existing && existing.phase === "paused") {
      tokStartChain();
      return { ok: true, resumed: true, total: existing.total };
    }
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
    tokStartChain();
    tokToastSet("Preparando carrito (0/" + job.total + ")", "");
    return { ok: true, started: true, total: clean.length };
  }

  // Motivo de cancelación: "stop" = interrupción del sistema (pestaña o sesión
  // cerrada, lote huérfano) → volver al paso de líneas; "user" = cancelación
  // explícita → marcar canceled.
  async function tokCancelReason() {
    const v = await tokStoreGet(CART_CANCEL_KEY);
    return v === "stop" ? "stop" : v ? "user" : "";
  }

  // Devuelve la razón de cancel si el usuario pidió cancelar (o el sistema
  // interrumpió), para abortar cuanto antes DENTRO del procesamiento de un ítem
  // (el drawer del carrito grande hace cada ítem lento; esperar al checkpoint
  // entre líneas hace que el cancel parezca que no funciona).
  async function tokAbortIfRequested() {
    return cartCancel ? "user" : await tokCancelReason();
  }

  // v2.0.27: único punto de arranque de la cadena del lote. Si ya hay una
  // cadena viva, los kicks extra (watchdog, evento online, nudge del
  // background) se ignoran: nunca corren dos loops en paralelo procesando el
  // mismo job. El finally de la promesa exterior cubre TODA la recursión
  // interna (tokRunJob → tokProcessCurrentItem → tokAdvance → tokRunJob…).
  function tokStartChain() {
    if (tokChainAlive) return;
    tokChainAlive = true;
    setTokRun(true);
    Promise.resolve()
      .then(tokRunJob)
      .catch(() => {})
      .finally(() => { tokChainAlive = false; });
  }

  async function tokRunJob() {
    try {
      const job = await tokStoreGet(CART_JOB_KEY);
      if (!job || job.phase === "done") return;
      // Si la sesión de Tokin se cerró, se frena todo (sin reanudar después).
      if (job.email && getSessionInfo().email !== job.email) return tokAbortCart(job, true);
      const reason = cartCancel ? "user" : await tokCancelReason();
      if (reason) return tokAbortCart(job, reason === "stop");
      // v2.0.23: verificar conectividad antes de cada búsqueda.
      // Si no hay internet, pausar el job (no abortar) para que se pueda
      // reanudar desde donde se quedó sin repetir líneas.
      if (!(await tokCheckNet())) {
        return tokPauseCart(job);
      }
      if (job.phase === "pending") {
        const it = job.items[job.index];
        const queries = tokBuildQueries(it);
        if (job.qIdx >= queries.length) {
          // v2.0.29: se agotaron TODAS las queries. Con código válido se probó
          // el código (con su reintento por render lento) y, como fallback, las
          // queries por nombre. El mensaje lo deja claro: si había código, no
          // se encontró la card por el código NI por el nombre del producto.
          const skuD = String(it.sku || "").replace(/\D+/g, "");
          let msg = "no se encontró el producto en el store";
          if (String(it.sku || "").trim()) {
            msg = skuD.length >= 4
              ? "no se encontró card con el código " + String(it.sku).trim() + " ni por nombre en el store"
              // El prefijo "no se encontró" lo cuenta el desglose del informe.
              : "no se encontró: código «" + String(it.sku).trim() + "» ilegible por nombre en el store";
          }
          job.results.push({
            producto: it.producto || it.sku || "",
            ok: false,
            message: msg,
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
      // v2.0.29: byName=true cuando NO estamos en la query de código (qIdx 0 con
      // sku válido) — es decir, cuando caemos al fallback por NOMBRE. En ese
      // modo tokBestArticle matchea por nombre+unidad aunque la línea traiga
      // sku (el código ya no existe en el store).
      const validSku = String(it.sku || "").replace(/\D+/g, "").length >= 4;
      const byName = !(job.qIdx === 0 && validSku);

      const cand = await waitForTokin(
        () => tokBestArticle(target, wantType, wantedGrams, it.sku, byName),
        20000,
        350
      );
      if (!cand || !tokAccept(cand)) {
        // v2.0.29: la PRIMERA query es la del código. Si la SPA tardó en
        // renderizar las cards (carrito grande) esa query pudo fallar sin ser
        // real: se reintenta UNA vez la misma query de código antes de caer a
        // las de nombre. qIdx===0 solo identifica la query de código cuando la
        // línea trae un sku válido (tokBuildQueries lo pone primero).
        if (job.qIdx === 0 && String(it.sku || "").replace(/\D+/g, "").length >= 4 && !job.codeRetried) {
          job.codeRetried = true;
          job.phase = "pending";
          await tokStoreSet(CART_JOB_KEY, job);
          await toksleep(1200);
          return tokRunJob();
        }
        job.qIdx++;
        job.phase = "pending";
        await tokStoreSet(CART_JOB_KEY, job);
        return tokRunJob();
      }
      const out = await tokProcessCard(cand, it, target, wantType, wantUnit, wantedGrams, wantQty, byName);
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
          if (i > 0 && (await tokAbortIfRequested())) {
            return tokAbortCart(job, false);
          }
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
                const c = tokBestArticle(target, wantType, wantedGrams, it.sku, byName);
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

  async function tokProcessCard(cand, it, target, wantType, wantUnit, wantedGrams, wantQty, byName) {
    byName = !!byName;
    const card = cand.el;
    const cardText = (card.innerText || "").replace(/\s+/g, " ").trim();
    const out = { ok: false, message: "", storeName: cardText.slice(0, 90), added: 0, usedUnit: wantUnit };

    let unitBtn = null;
    let usedUnit = wantUnit;
    let unitNote = "";
    let convertedQty = 0;
    const btns = Array.from(card.querySelectorAll("[data-id=sku-selector-button]"));
    // v2.0.26: detección TEMPRANA de "sin stock". Una card sin botones de
    // unidad, sin input y sin botón Agregar que además dice "sin stock" no tiene
    // nada que procesar: reportarlo acá evita esperar los timeouts de
    // inputs/Agregar (~11 s) y evita que un mensaje de unidad oculte el dato
    // real: el producto SÍ existe en el store, solo no está disponible.
    if (
      /sin stock/i.test(cardText) &&
      !btns.length &&
      !card.querySelector("input[type=number]") &&
      !card.querySelector("[data-id=add-to-cart-button]")
    ) {
      const arc = tokArcCode(cardText);
      out.ok = true;
      out.message = "encontrado pero sin stock" + (arc ? " (" + arc + ")" : "");
      return out;
    }
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
          convertedQty = wantQty * conv;
          if (convertedQty > 999) {
            out.ok = false;
            out.message =
              "no se agregó: " + wantQty + " " + wantUnit + " = " + convertedQty +
              " unidades, supera el límite de 999 del store";
            return out;
          }
          unitBtn = btns[0];
          usedUnit = "Unidad";
          unitNote = " (" + convertedQty + " " + usedUnit + ")";
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
      const c = tokBestArticle(target, wantType, wantedGrams, it.sku, byName);
      if (!c) return null;
      const els = c.el.querySelectorAll("input[type=number]");
      return els.length ? els : null;
    }, 5000, 250);

    if (!nums) {
      const addBtn = await waitForTokin(() => {
        const c = tokBestArticle(target, wantType, wantedGrams, it.sku, byName);
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
        const c = tokBestArticle(target, wantType, wantedGrams, it.sku, byName);
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
      if (convertedQty > 0) {
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
      if (actualQty < wantQty && convertedQty > 0) {
        out.ok = false;
        out.message =
          "no se agregó: el store solo tiene " + actualQty + " unidades" +
          " (necesitaba " + wantQty + " para cubrir " + qty + " " + wantUnit + ")";
      } else if (convertedQty > 0) {
        // Mensaje conciso de conversión: ejemplo "agregado: 2 Display (40 Unidad)".
        out.message = "agregado: " + qty + " " + wantUnit +
          " (" + convertedQty + " " + usedUnit + ")";
        out.unitNote = qty + " " + wantUnit + " (" + convertedQty + " " + usedUnit + ")";
      } else if (actualQty !== qty) {
        // productTotals fusionó líneas duplicadas: el carrito tiene la suma.
        out.message = "agregado: " + wantQty + " " + usedUnit;
      } else {
        out.message = "agregado: " + qty + " " + usedUnit;
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
    if (await tokAbortIfRequested()) return tokAbortCart(job, false);
    tokProgress(
      "Cargando carrito: " + (job.index + 1) + " de " + job.total + " — " +
        String(job.items[job.index].producto || "").slice(0, 30),
      job.index,
      job.total,
      ok
    );
    job.index++;
    job.qIdx = 0;
    job.codeRetried = false;
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
      tokToastSet("Verificando cantidades en el carrito…", "");
      const results = job.results || [];
      let changed = 0;
      let cards = tokCartCards();

      for (const r of results) {
        if (!(r.ok && String(r.message || "").indexOf("agregado") === 0)) continue;
        const wantQty = r.added || 0;
        if (!wantQty) continue;
        const code = tokArcCode(r.storeText || "");
        // Primero verificar si la card ya tiene la qty correcta (sin re-setear).
        let hit = tokCartFindProduct(cards, r.storeText || "", r.usedUnit || "", wantQty, code);
        if (hit && hit.qty >= wantQty) { changed++; continue; }
        // Si no, re-setear la cantidad y verificar (máx 3 intentos, 600ms c/u).
        for (let i = 0; i < 3; i++) {
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
                  await toksleep(200);
                }
                tokSetValue(inp, String(wantQty));
              }
              break;
            }
          }
          await toksleep(600);
          cards = tokCartCards();
          hit = tokCartFindProduct(cards, r.storeText || "", r.usedUnit || "", wantQty, code);
          if (hit && hit.qty >= wantQty) break;
        }
        if (hit && hit.qty >= wantQty) {
          changed++;
        } else {
          // La card puede estar cargada pero con la qty SIN asentar (el re-render
          // de React del drawer saturado la resetea / la muestra distinta a lo
          // pedido) o con la qty que el store realmente aceptó (tope). Si la card
          // del CÓDIGO existe en el carrito (qty > 0), el ítem SÍ se cargó: no
          // degradar a un "no se confirmó" falso (el reporte debe reflejar el
          // carrito real). Confirmamos con la qty que quedó y anotamos si quedó
          // parcial. Solo cuando la card está AUSENTE del carrito es un fallo real.
          const present = cards.find(
            (c) => c.code && (c.code === code || c.code.endsWith(code) || code.endsWith(c.code)) && c.qty > 0
          );
          if (present) {
            r.message = "agregado: " + present.qty + " " + (r.usedUnit || "").trim() +
              (present.qty < wantQty ? " (qty parcial " + present.qty + "/" + wantQty + ")" : "") +
              " (confirmado en el cierre)";
            changed++;
          } else {
            r.ok = false;
            r.message = "no se confirmó en el cierre (sin card del código en el carrito)";
          }
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
        r.message = r.unitNote
          ? "agregado: " + r.unitNote + " (confirmado en el cierre)"
          : "agregado: " + wantQty + " " + (r.usedUnit || "").trim() + " (confirmado en el cierre)";
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

  // v2.0.23/32: vaciar el carrito del store (setear qty a 0 en cada card).
  // Las cards del drawer están SIEMPRE en el DOM, pero si el drawer está
  // cerrado su offsetParent es null: antes se filtraban y el carrito NO se
  // vaciaba al cancelar. Ahora se abre el drawer si ninguna card está visible
  // (para que los inputs sean interactuables y el set persista contra el
  // servidor), se setea 0 en cada card con cantidad y se cierra.
  async function tokEmptyCart() {
    const openDrawer = async () => {
      let visible = false;
      document.querySelectorAll("article[data-id=cart-product-card]").forEach((c) => {
        if (c.querySelector("input[type=number]") && c.offsetParent !== null) visible = true;
      });
      if (visible) return;
      const btn = document.querySelector("[data-id=navbar-minicart-button]");
      if (!btn) return;
      btn.click();
      await toksleep(900);
    };
    try {
      await openDrawer();
      const cards = document.querySelectorAll("article[data-id=cart-product-card]");
      for (const card of cards) {
        const inp = card.querySelector("input[type=number]");
        if (!inp) continue;
        const cur = parseInt(String(inp.value || "").replace(/\D+/g, ""), 10) || 0;
        if (cur === 0) continue;
        tokSetValue(inp, "0");
        await toksleep(300);
      }
      const close = document.querySelector("[data-id=cart-close-button], [data-id=minicart-close-button]");
      if (close) close.click();
    } catch (e) {}
  }

  // v2.0.23: pausar el job por interrupción (internet, etc.). NO vacía el
  // carrito ni borra el job: al reanudar se verifica la última línea y se
  // continúa desde ahí.
  async function tokPauseCart(job) {
    job.phase = "paused";
    job.pausedAt = Date.now();
    await tokStoreSet(CART_JOB_KEY, job);
    await tokStoreRemove(CART_CANCEL_KEY);
    setTokRun(false);
    tokToastSet("Sin conexión — tarea pausada en línea " + (job.index + 1) + "/" + job.total + ". Reanudá cuando tengas señal.", "warn");
    try {
      chrome.runtime.sendMessage(
        { target: "offscreen", type: "CART_PAUSE" },
        () => { void chrome.runtime.lastError; }
      );
    } catch (e) {}
    try {
      window.postMessage(
        { __tok: "cart-res", payload: { paused: true, total: job.total, index: job.index, results: job.results } },
        "*"
      );
    } catch (e) {}
  }

  async function tokAbortCart(job, interrupted) {
    await tokStoreRemove(CART_JOB_KEY);
    await tokStoreRemove(CART_CANCEL_KEY);
    setTokRun(false);
    // v2.0.23: vaciar el carrito al cancelar/interrumpir para que el usuario
    // pueda reanudar limpio (sin productos viejos mezclados).
    await tokEmptyCart();
    tokToastSet(interrupted ? "Tarea interrumpida — carrito vaciado." : "Carga cancelada — carrito vaciado.", "");
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
      // v2.0.27: cualquier fase activa se reanuda al cargar la página. Antes
      // solo se continuaba si phase="searching" Y ya estábamos en la página de
      // búsqueda: un lote que quedó "pending" (o "searching" en otra URL,
      // ej. página de error de Chrome por falta de señal) quedaba trabado para
      // siempre hasta que el usuario refrescara justo sobre la búsqueda.
      if (job.phase === "searching") {
        if (location.href.indexOf("/store/search") === -1) {
          job.phase = "pending";
          await tokStoreSet(CART_JOB_KEY, job);
        }
        tokStartChain();
        return;
      }
      if (job.phase === "pending") {
        tokStartChain();
        return;
      }
      // v2.0.23: reanudar tras pausa por interrupción (internet).
      // Buscar desde la ÚLTIMA línea que se confirmó en el carrito y continuar
      // desde la siguiente. No repetir líneas ya cargadas.
      if (job.phase === "paused") {
        const cards = tokCartCards();
        let resumeFrom = job.index;
        // Revisar las líneas desde la actual hacia atrás para encontrar la
        // última que realmente está en el carrito (confirmada).
        for (let checkIdx = job.index; checkIdx >= 0; checkIdx--) {
          const checkIt = job.items[checkIdx];
          const checkSku = String(checkIt.sku || "").replace(/\D+/g, "");
          const checkFound = checkSku ? cards.find(function(c) { return c.code && c.code.endsWith(checkSku); }) : null;
          if (checkFound) {
            // Esta línea ya está en el carrito. Si no tiene resultado, agregarlo.
            const alreadyResulted = job.results.some(function(r, ri) { return ri === checkIdx && r.ok; });
            if (!alreadyResulted) {
              const wantUnit = tokUnitLabel(checkIt);
              job.results[checkIdx] = {
                producto: checkIt.producto || checkIt.sku || "",
                ok: true,
                message: "agregado: " + checkFound.qty + " " + wantUnit + " (reanudado tras interrupción)",
                added: checkFound.qty,
                usedUnit: wantUnit,
                storeText: "",
              };
            }
            resumeFrom = checkIdx + 1;
            break;
          }
        }
        // Si no se encontró ninguna línea en el carrito, reintentar desde job.index.
        job.index = resumeFrom;
        job.qIdx = 0;
        job.phase = "pending";
        await tokStoreSet(CART_JOB_KEY, job);
        tokStartChain();
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
      case "TOKIN_PING":
        // Sondeo del watchdog del background: responde solo para confirmar que
        // este content script está vivo (si no responde, el background puede
        // recargar la pestaña cuando haya señal).
        sendResponse({ ok: true });
        break;
      case "TOKIN_RESUME_NUDGE":
        // La pestaña terminó de cargar (o el popup lo pidió) con un lote
        // vivo/pausado: intentar retomarlo ya.
        sendResponse({ ok: true });
        resumeCart();
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

  // v2.0.27: WATCHDOG del lote. Cada pocos segundos revisa el job y actúa:
  //   - phase="paused": poll real de conectividad (fetch al store); en cuanto
  //     hay señal de verdad (<30 min de pausa), reanuda solo. Esto cubre el
  //     caso típico de corte de señal: el evento "online" puede no dispararse
  //     nunca (WiFi conectada, router sin internet) o dispararse ANTES de que
  //     la ruta funcione.
  //   - phase="pending"/"searching" con cadena muerta (sin latido reciente):
  //     relanza el loop. Cubre excepciones tragadas y reinicios que dejaron el
  //     lote trabado sin navegar ni procesar.
  setInterval(function () {
    tokWatchdogTick();
  }, 7000);

  async function tokWatchdogTick() {
    try {
      const job = await tokStoreGet(CART_JOB_KEY);
      if (!job || job.phase === "done") return;
      if (cartCancel || (await tokCancelReason())) {
        resumeCart();
        return;
      }
      if (job.phase === "paused") {
        if (job.pausedAt && Date.now() - job.pausedAt > TOK_PAUSE_MAX_MS) return;
        if (!(await tokCheckNet())) return;
        tokToastSet("Conexión restaurada — reanudando tarea…", "ok");
        resumeCart();
        return;
      }
      if (job.phase === "pending" || job.phase === "searching") {
        if (tokChainAlive) return;
        // Cadena muerta: exigir además inactividad real (sin latidos) para no
        // pisar un procesamiento normal que recién arranca.
        if (Date.now() - tokLastBeat < TOK_STALE_MS) return;
        resumeCart();
      }
    } catch (e) {}
  }

  // v2.0.23/27: auto-reanudar cuando vuelve el internet. El evento se usa como
  // PISTA (dispara el primer intento antes), pero la recuperación real la hace
  // el reintento con poll de red: "online" suele llegar antes de que DNS/ruta
  // funcionen, así que se reintenta ~90 s (el watchdog sigue de refuerzo).
  window.addEventListener("online", function () {
    tokOnlineRetry();
  });

  let tokOnlinePolling = false;
  async function tokOnlineRetry() {
    if (tokOnlinePolling) return;
    tokOnlinePolling = true;
    try {
      for (let i = 0; i < 18; i++) {
        await toksleep(5000);
        const job = await tokStoreGet(CART_JOB_KEY);
        if (!job || job.phase !== "paused") return;
        if (job.pausedAt && Date.now() - job.pausedAt > TOK_PAUSE_MAX_MS) return;
        if (await tokCheckNet()) {
          tokToastSet("Conexión restaurada — reanudando tarea…", "ok");
          resumeCart();
          return;
        }
      }
    } catch (e) {
    } finally {
      tokOnlinePolling = false;
    }
  }
})();
