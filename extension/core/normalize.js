// Utilidades de normalizacion: cadenas, fechas, telefonos, numeros.
// Portadas de server/agent.py.
import { SYNONYM_GROUPS, CURRENCY_SYMBOLS } from "./synonyms_es.js";

export function normalize(s) {
  if (s == null) return "";
  s = String(s)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
  s = s.toLowerCase();
  s = s.replace(/[\$%,\u00a0;()\[\]{}]/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function clean_value(s) {
  if (s == null) return "";
  s = String(s).trim();
  if (!s) return s;
  const lower = s.toLowerCase();
  for (const sym of CURRENCY_SYMBOLS) {
    if (lower.includes(sym)) s = s.split(sym).join(" ");
  }
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

export function date_iso(value) {
  const v = String(value == null ? "" : value).trim();
  let m = v.match(/^(\d{1,2})[\/\-\.](\d{1,2})[\/\-\.](\d{2,4})$/);
  if (m) {
    let d = +m[1], mo = +m[2], y = m[3];
    if (String(y).length === 2) y = "20" + y;
    y = +y;
    if (y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  m = v.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (y >= 1 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${String(y).padStart(4, "0")}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    }
  }
  return null;
}

export function phone_clean(value) {
  return String(value == null ? "" : value).replace(/\D/g, "");
}

export function is_numeric(v) {
  if (v == null) return false;
  v = String(v).replace(/,/g, ".").trim();
  v = v.replace(/\s/g, "");
  return /^-?\d+(\.\d+)?$/.test(v);
}

// "24 B" -> {num:24, unit:"B"}, "6 D" -> {num:6, unit:"D"}, "24" -> {num:24, unit:""}
export function parse_qty(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d+(?:[.,]\d+)?)\s*([A-Za-z]*)$/);
  if (!m) return null;
  const num = parseFloat(m[1].replace(",", "."));
  if (isNaN(num)) return null;
  return { num, unit: m[2].toUpperCase() };
}

// Columna de unidad -> categoria del store: "bulto" | "display" | "unidad".
// Acepta letras simples (B/D/U/A) y nomenclatura OCR UN/DI/BU.
export function medida_categoria(unit) {
  if (unit == null) return "";
  const k = normalize(unit);
  if (!k) return "";
  if (k === "b" || k === "bu" || k === "bulto" || k === "bultos") return "bulto";
  if (k === "d" || k === "di" || k === "disp" || k === "disps" || k === "display" || k === "pack" || k === "packs" || k === "paquete" || k === "paquetes" || k === "pk") return "display";
  if (k === "a" || k === "u" || k === "un" || k === "ud" || k === "uds" || k === "und" || k === "unid" || k === "unidad") return "unidad";
  return k;
}

// ---------------- sinonimia -> concepto ----------------

const _CONCEPT_BY_TOKEN = {};
for (const [concept, words] of Object.entries(SYNONYM_GROUPS)) {
  for (const w of words) _CONCEPT_BY_TOKEN[normalize(w)] = concept;
}

export function match_concept(text) {
  const t = normalize(text);
  if (!t) return null;
  if (Object.prototype.hasOwnProperty.call(_CONCEPT_BY_TOKEN, t)) {
    return _CONCEPT_BY_TOKEN[t];
  }
  let best = null;
  let best_ratio = 0;
  for (const [token, concept] of Object.entries(_CONCEPT_BY_TOKEN)) {
    if (token.length >= 3 && t.includes(token)) {
      const ratio = token.length / t.length;
      if (ratio > best_ratio) {
        best = concept;
        best_ratio = ratio;
      }
    }
  }
  if (best && best_ratio >= 0.5) return best;
  return null;
}

export function looks_like_value(cell) {
  if (!cell) return false;
  const s = String(cell);
  return (
    is_numeric(s) ||
    date_iso(s) !== null ||
    phone_clean(s) !== "" ||
    s.includes("@") ||
    s.length >= 6 ||
    /\d/.test(s)
  );
}
