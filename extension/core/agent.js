// Motor de extraccion y mapeo, 100% en el navegador.
// Portado de server/agent.py (sin Python): parsea XLSX/XLS/CSV (SheetJS),
// DOCX (mammoth) y PDF (pdf.js, best-effort) y arma mapeos campo->valor.
import {
  normalize,
  clean_value,
  date_iso,
  phone_clean,
  is_numeric,
  parse_qty,
  match_concept,
  looks_like_value,
  medida_categoria,
} from "./normalize.js";

function lib(name) {
  return (typeof globalThis !== "undefined" && globalThis[name]) || null;
}

// Señal de cancelación lanzada desde el pipeline cuando el usuario toca
// "Cancelar". parseDocument la propaga tal cual (sin volcarla a doc.error).
export class CancelError extends Error {
  constructor() {
    super("Proceso cancelado por el usuario.");
    this.name = "CancelError";
  }
}

// ------------------------------------------------------------ utilidades

function decodeBytes(data) {
  // data: ArrayBuffer | Uint8Array
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  try {
    let text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return text;
  } catch (e) {
    try {
      return new TextDecoder("windows-1252").decode(bytes);
    } catch (e2) {
      return new TextDecoder("latin1").decode(bytes);
    }
  }
}

function sniffDelimiter(sample) {
  const lines = sample.split(/\r?\n/).filter((l) => l.trim()).slice(0, 8);
  if (!lines.length) return ",";
  let best = ",";
  let bestScore = -1;
  for (const d of [";", "\t", ","]) {
    let score = 0;
    let consistent = true;
    for (const line of lines) {
      const n = line.split(d).length - 1;
      if (n === 0) {
        consistent = false;
        break;
      }
      score += n;
    }
    if (consistent && score > bestScore) {
      best = d;
      bestScore = score;
    }
  }
  return best;
}

function parseCsv(text, delim) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.some((c) => String(c).trim() !== "")) rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length) {
    row.push(field);
    if (row.some((c) => String(c).trim() !== "")) rows.push(row);
  }
  return rows;
}

function _csv_rows(data) {
  const text = decodeBytes(data);
  const delim = sniffDelimiter(text.slice(0, 4096));
  return [{ sheet: "csv", rows: parseCsv(text, delim) }];
}

// ------------------------------------------------------- extraccion xlsx

function _xlsx_rows(data) {
  const XLSX = lib("XLSX");
  if (!XLSX) throw new Error("SheetJS (xlsx.full.min.js) no está cargado.");
  const wb = XLSX.read(data, { type: "array", cellDates: true });
  const result = [];
  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    if (!ws["!ref"]) continue;
    const range = XLSX.utils.decode_range(ws["!ref"]);
    const merged = {};
    for (const m of ws["!merges"] || []) {
      const topLeft = XLSX.utils.encode_cell({ r: m.s.r, c: m.s.c });
      const val = ws[topLeft] ? ws[topLeft].v : null;
      for (let r = m.s.r; r <= m.e.r; r++) {
        for (let c = m.s.c; c <= m.e.c; c++) {
          merged[r + "," + c] = val;
        }
      }
    }
    const rows = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const row = [];
      for (let c = range.s.c; c <= range.e.c; c++) {
        let v = null;
        if (Object.prototype.hasOwnProperty.call(merged, r + "," + c)) {
          v = merged[r + "," + c];
        } else {
          const cell = ws[XLSX.utils.encode_cell({ r, c })];
          if (cell && cell.v !== undefined) v = cell.v;
        }
        row.push(v);
      }
      if (row.some((v) => v != null && String(v).trim() !== "")) rows.push(row);
    }
    result.push({ sheet: sheetName, rows });
  }
  return result;
}

// ------------------------------------------------------- extraccion docx

function _docx(data) {
  const mammoth = lib("mammoth");
  if (!mammoth) throw new Error("mammoth.browser.min.js no está cargado.");
  return mammoth.convertToHtml({ arrayBuffer: data });
}

function _docx_to_tables(html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const tables = [];
  for (const table of doc.querySelectorAll("table")) {
    const rows = [];
    for (const tr of table.querySelectorAll("tr")) {
      const row = [];
      for (const td of tr.querySelectorAll("td, th")) {
        row.push(td.textContent.replace(/\s+/g, " ").trim());
      }
      if (row.some((x) => x)) rows.push(row);
    }
    if (rows.length) tables.push({ sheet: "tabla", rows });
  }
  let text = "";
  for (const el of doc.querySelectorAll("p, h1, h2, h3, h4, h5, li")) {
    const t = el.textContent.trim();
    if (t) text += t + "\n";
  }
  if (!text) text = (doc.body && doc.body.textContent) || "";
  return { text, tables };
}

// ------------------------------------------------------- extraccion pdf

function _text_items_to_lines(tc) {
  const byY = {};
  for (const item of tc.items) {
    if (!item.str) continue;
    const y = Math.round(item.transform[5]);
    const x = Math.round(item.transform[4]);
    (byY[y] = byY[y] || []).push({ x, str: item.str });
  }
  const ys = Object.keys(byY).map(Number).sort((a, b) => a - b);
  let text = "";
  for (const y of ys) {
    byY[y].sort((a, b) => a.x - b.x);
    text += byY[y].map((l) => l.str).join(" ") + "\n";
  }
  return text;
}

async function _ocr_worker() {
  const Tesseract = lib("Tesseract");
  if (!Tesseract) throw new Error("tesseract.min.js no está cargado.");
  let base = "lib/tesseract/";
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
    base = chrome.runtime.getURL("lib/tesseract/");
  }
  // worker clásico cargado desde su propia URL chrome-extension:// (sin blob:
  // CSP de MV3 no permite blob:). importScripts mismo-origen del worker sí funciona.
  const worker = await Tesseract.createWorker({
    workerBlobURL: false,
    workerPath: base + "worker.min.js",
    corePath: base + "tesseract-core.wasm.js",
    langPath: base + "lang/",
    logger: () => {},
  });
  await worker.loadLanguage("spa");
  await worker.initialize("spa");
  return worker;
}

async function _render_page(page, rotation, scale) {
  const viewport = page.getViewport({ scale, rotation: rotation || 0 });
  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
  return canvas;
}

async function _ocr_canvas(worker, canvas) {
  // Pasar el canvas directamente evita el costo de codificar a PNG.
  const { data } = await worker.recognize(canvas);
  const words = (data.words || [])
    .map((w) => ({
      t: String(w.text || ""),
      x0: w.bbox.x0,
      y0: w.bbox.y0,
      x1: w.bbox.x1,
      y1: w.bbox.y1,
    }))
    .filter((w) => w.t.trim() !== "");
  return { text: data.text || "", conf: data.confidence || 0, words, w: canvas.width, h: canvas.height };
}

// Pool sencillo: reparte los items entre N workers de Tesseract y resuelve en
// paralelo. next se lee/incrementa sin await en el medio, así que es seguro.
async function _parallel(pool, items, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(
    pool.map(async (worker) => {
      while (next < items.length) {
        const i = next++;
        out[i] = await fn(worker, items[i], i);
      }
    })
  );
  return out;
}

const OCR_WORKERS = 3;

// Detectar en que orientacion estan dibujadas las hojas (contenido girado dentro
// de una hoja vertical). Prueba 0/90/180/270 y puntua cada una por confianza de
// Tesseract + legibilidad (proporcion de palabras reales): el texto girado da
// confianza y legibilidad mucho mas bajas que el texto derecho. Devuelve las
// rotaciones ordenadas de mejor a peor para poder reintentar desde la vertical.
// Las hojas del pedido son gráficos vectoriales (cada carácter es un trazado,
// sin capa de texto). 2.0 (144 DPI) es el mínimo que mantiene SKU/cantidades
// legibles; 1.5 (~108 DPI) degrada el OCR. La detección de orientación corre a
// 1.2 para ser rápida (solo discrimina izquierda/derecha).
const OCR_SCALE = 2.0;
const OCR_DETECT_SCALE = 1.2;
const ROT_CANDIDATES = [0, 90, 180, 270];

// Palabras funcionales y claves del documento de pedido. El texto girado produce
// basura alfanumérica que un chequeo genérico no distingue; estas claves solo
// aparecen en el texto derecho ("NOTA DE PEDIDO", "FECHA", "código", "Cantidad"…).
const _SPANISH_WORDS = new Set([
  "de", "la", "el", "los", "las", "del", "y", "a", "en", "un", "una", "unos", "unas", "con", "por", "para",
  "se", "su", "sus", "al", "que", "o", "es", "no", "si", "me", "te", "le", "lo", "mi", "tu", "sin", "sobre",
  "entre", "hasta", "desde", "hacia", "cada", "todo", "toda", "todos", "todas", "este", "esta", "estos",
  "estas", "ese", "esa", "esos", "esas", "otro", "otra", "otros", "otras", "como", "cuando", "donde",
  "quien", "cual", "pero", "porque", "tambien", "tan", "bien", "muy", "hay",
  "nota", "pedido", "fecha", "hora", "horario", "vendedor", "comprador", "cliente", "proveedor",
  "distribuidora", "direccion", "telefono", "telefonos", "recepcion", "confirmar", "entregar", "entrega",
  "codigo", "cantidad", "cantidades", "precio", "precios", "importe", "descripcion", "producto",
  "productos", "unidad", "unidades", "bulto", "bultos", "display", "displays", "marca", "gramos", "piezas",
  "bonificaciones", "descuentos", "observaciones", "surtido", "total", "subtotal", "reimpresion",
  "sucursal", "autorizada", "autorizado", "nro", "referencia", "lista", "listado", "renglon", "renglones",
  "dulces", "villa", "parque", "ciudad", "caba", "localidad", "provincia", "nombre", "apellido", "correo",
  "envio", "envios", "carton", "cartones", "kiosco", "almacen", "deposito", "congelado", "srl", "empresa",
  "compania", "razon", "social", "dias", "hora", "hs", "uds", "kg", "cm",
]);

function _legibility(text) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  if (!words.length) return 0;
  let real = 0;
  for (const w of words) {
    const t = String(w).replace(/[^a-záéíóúüñ0-9]/gi, "").toLowerCase();
    if (!t) continue;
    if (/^\d{2,}([.,]\d+)?$/.test(t)) { real++; continue; }
    if (_SPANISH_WORDS.has(t)) { real++; continue; }
    // Estructura de palabra plausible (al menos 4 letras y 2 vocales): descarta
    // fragmentos sueltos del texto girado, no la basura larga (la filtra el
    // diccionario + la confianza + la evidencia de tabla de la selección).
    if (/^[a-záéíóúüñ]{4,}$/.test(t)) {
      const vowels = (t.match(/[aeiouáéíóúü]/g) || []).length;
      if (vowels >= 2) real++;
    }
  }
  return real / words.length;
}

async function _detect_one(worker, page, rot) {
  const canvas = await _render_page(page, rot, OCR_DETECT_SCALE);
  const r = await _ocr_canvas(worker, canvas);
  return { rot, conf: r.conf, score: r.conf + 20 * _legibility(r.text), text: r.text, words: r.words, w: r.w };
}

async function _detect_rotations(pool, page) {
  const results = await _parallel(pool, ROT_CANDIDATES, (worker, rot) => _detect_one(worker, page, rot));
  results.sort((a, b) => b.score - a.score);
  return results;
}

async function _ocr_page(worker, page, rotation) {
  const canvas = await _render_page(page, rotation, OCR_SCALE);
  const r = await _ocr_canvas(worker, canvas);
  const out = { text: r.text, words: r.words, w: r.w, h: r.h, scale: OCR_SCALE, conf: r.conf };
  canvas.width = 0;
  canvas.height = 0;
  return out;
}

async function _pdf_text(data, onProgress, onCancel) {
  const pdfjs = lib("pdfjsLib");
  if (!pdfjs) throw new Error("pdf.min.js no está cargado.");
  if (!pdfjs.GlobalWorkerOptions.workerSrc && typeof chrome !== "undefined") {
    try {
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
    } catch (e) {}
  }
  const t0 = Date.now();
  const pdf = await pdfjs.getDocument({ data }).promise;
  let text = "";
  const pages = [];
  const needOcr = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    if (tc.items.length > 0) {
      text += _text_items_to_lines(tc) + "\n";
    } else {
      needOcr.push(i);
    }
  }
  if (needOcr.length) {
    const pool = [];
    try {
      if (onCancel && onCancel()) throw new CancelError();
      for (let k = 0; k < OCR_WORKERS; k++) pool.push(await _ocr_worker());
      if (typeof console !== "undefined") console.log("[tokin] t_workers=%dms", Date.now() - t0);
      if (onProgress) onProgress("Detectando orientación de las hojas…");
      const rots = await _detect_rotations(pool, await pdf.getPage(needOcr[0]));
      const best = rots[0];
      if (typeof console !== "undefined") {
        console.log("[tokin] rotation=%s conf=%s ocr_pages=%d t_detect=%dms", best.rot, best.conf, needOcr.length, Date.now() - t0);
      }

      // Elegir la rotación con mayor evidencia combinada: confianza de Tesseract
      // + legibilidad (diccionario) + items de tabla del probe. Antes se cortaba
      // en el primer candidato "legible" y la métrica aceptaba basura alfanumérica,
      // eligiendo 0° cuando la hoja estaba girada 90° (ej: pedidos de Arcor).
      // El probe de la rotación elegida se reutiliza como OCR de la página 1.
      let chosen = null;
      let firstDone = null;
      let bestEvidence = -1;
      for (const cand of rots) {
        if (onCancel && onCancel()) throw new CancelError();
        if (onProgress) onProgress("Probando orientación " + cand.rot + "°…");
        const probePage = await pdf.getPage(needOcr[0]);
        const probe = await _ocr_page(pool[0], probePage, cand.rot);
        const items = _pdf_table_items(probe.words, probe.w, probe.scale);
        const evidence = probe.conf + 25 * _legibility(probe.text) + (items.length > 0 ? 50 : 0);
        if (!chosen || evidence > bestEvidence) {
          chosen = cand;
          firstDone = probe;
          bestEvidence = evidence;
        }
      }

      // Página 1: se reutiliza el probe (misma rotación y escala).
      text += firstDone.text + "\n";
      if (firstDone.words.length)
        pages.push({ page: needOcr[0], words: firstDone.words, w: firstDone.w, h: firstDone.h, scale: firstDone.scale });

      // Resto de páginas OCR en paralelo entre los workers del pool.
      const rest = needOcr.slice(1);
      const tProbe = Date.now();
      const results = await _parallel(pool, rest, async (worker, pageNum) => {
        if (onCancel && onCancel()) throw new CancelError();
        if (onProgress) onProgress("OCR página " + pageNum + " de " + pdf.numPages + "…");
        return await _ocr_page(worker, await pdf.getPage(pageNum), chosen.rot);
      });
      if (typeof console !== "undefined") console.log("[tokin] t_pages=%dms", Date.now() - tProbe);
      for (let k = 0; k < results.length; k++) {
        const r = results[k];
        text += r.text + "\n";
        if (r.words.length) pages.push({ page: rest[k], words: r.words, w: r.w, h: r.h, scale: r.scale });
      }

      // Re-OCR de banda para TODAS las filas (la celda de unidad b/d/a y el sku
      // son poco confiables a escala 2.0): re-renderiza la banda de cada fila a
      // mayor escala y extrae POR POSICIÓN de columna la cantidad (la celda que
      // tiene la letra b/d y el número a su derecha, excluyendo el xBulto), la
      // unidad y el sku. La cantidad solo se corrige en filas sospechosas (Cant.
      // Pedida degradada o sin unidad); la unidad y el sku en todas.
      const REFINE_SCALE = 3.5;
      for (const pg of pages) {
        const rows = _pdf_all_rows(pg.words, pg.w, pg.scale);
        if (!rows.length) continue;
        if (onProgress) onProgress("Corrigiendo filas de la página " + pg.page + "…");
        const pageObj = await pdf.getPage(pg.page);
        // La página a escala alta se renderiza UNA vez y se reutiliza en todas
        // las filas de esa página.
        const full = await _render_page(pageObj, chosen.rot, REFINE_SCALE);
        const fixes = {};
        for (const s of rows) {
          if (onCancel && onCancel()) throw new CancelError();
          const fix = await _pdf_band_refine(
            pool[0],
            pageObj,
            chosen.rot,
            s.sku,
            s.cy,
            pg.w,
            pg.h,
            pg.scale,
            REFINE_SCALE,
            full
          );
          if (!fix) continue;
          // La cantidad del re-OCR solo se aplica si la fila es sospechosa:
          // para las filas normales el valor del parse global ya es correcto.
          if (!s.suspect) delete fix.cantidad;
          if (fix.cantidad != null || fix.unidad != null || fix.sku != null) {
            fixes[s.sku] = fix;
            if (typeof console !== "undefined")
              console.log("[tokin] refine sku=%s pedida=%s -> %j", s.sku, s.pedida, fix);
          }
        }
        full.width = 0;
        full.height = 0;
        if (Object.keys(fixes).length) pg.qtyFix = fixes;
      }
    } finally {
      for (const worker of pool) {
        try { await worker.terminate(); } catch (e) {}
      }
    }
  }
  if (typeof console !== "undefined")
    console.log("[tokin] pdf_text ok pages=%d elapsed=%dms", pdf.numPages, Date.now() - t0);
  return { text, pages };
}

// Extraer renglones de la tabla de items a partir de palabras OCR con bbox.
// Columnas del pedido (proveedor): código | desc | xBulto | unid(b/d/a) |
// Cantidad Pedida | ... | Precio | Importe. Lo que importa para el carrito:
// producto (descripción), cantidad pedida y unidad (bulto/display).
function _first_digits(t) {
  const m = /\d+/.exec(String(t || ""));
  return m ? m[0] : null;
}

// Columna de unidad del proveedor: el OCR puede dar la letra (b/d/a) o la
// nomenclatura UN/DI/BU (unidad/display/bulto). Devuelve siempre la letra
// canónica que consume el carrito: a=unidad, b=bulto, d=display.
function _unit_letter(t) {
  let s = String(t || "")
    .trim()
    .toLowerCase()
    .replace(/[|\[\]()*]/g, "")
    .trim();
  if (/^(un|und|unid|unidad|u)$/.test(s)) return "a";
  if (/^(bu|bulto|bultos|b)$/.test(s)) return "b";
  if (/^(di|disp|disps|display|d)$/.test(s)) return "d";
  const m = /[bda]/.exec(s);
  return m ? m[0] : null;
}

function _pdf_build_rows(words, scale) {
  const wlist = (words || []).filter((w) => w && w.t && String(w.t).trim() !== "");
  if (wlist.length < 5) return [];
  const sorted = wlist.slice().sort((a, b) => (a.y0 + a.y1) / 2 - (b.y0 + b.y1) / 2);
  // Umbral de separación entre renglones proporcional a la escala de render
  // (a escala 2.5 los renglones están ~17px, a escala 3 ~20px). Un umbral fijo
  // de 20px unía renglones en escalas menores.
  const rowGap = Math.max(8, 4 * (scale || 3));
  const rows = [];
  let last = null;
  for (const w of sorted) {
    const cy = (w.y0 + w.y1) / 2;
    if (last === null || cy - last > rowGap) rows.push([]);
    rows[rows.length - 1].push(w);
    last = cy;
  }
  return rows;
}

// Analiza una fila (ordenada por x) y devuelve el item + metadatos de cantidad.
// Columnas del pedido (proveedor): código | desc | xBulto | unid(b/d/a) |
// Cantidad Pedida | ... | Precio | Importe. Lo que importa para el carrito:
// producto (descripción), cantidad pedida y unidad (bulto/display).
function _pdf_row_info(width, row) {
  row.sort((a, b) => a.x0 - b.x0);
    // SKU extraction: primary look for 4-6 digit numbers, fallback to any numeric token >=4 digits.
    let sku = null;
    let sku_i = -1;
    for (let i = 0; i < row.length; i++) {
      const w = row[i];
      if (w.x0 / width < 0.1 && /^\d{4,6}$/.test(w.t)) {
        sku = w.t;
        sku_i = i;
        break;
      }
    }
    // Fallback: if not found, look for any numeric token of sufficient length.
    if (sku === null) {
      for (let i = 0; i < row.length; i++) {
        const w = row[i];
        if (w.x0 / width < 0.2 && /^\d{4,}$/.test(w.t)) {
          sku = w.t;
          sku_i = i;
          break;
        }
      }
    }
    if (sku === null) return null;
  let unit = null;
  let unit_i = -1;
  for (let i = sku_i + 1; i < row.length; i++) {
    const w = row[i];
    const xf = (w.x0 + w.x1) / 2 / width;
    if (xf < 0.25 || xf > 0.31) continue;
    const u = _unit_letter(w.t);
    if (u) {
      unit = u;
      unit_i = i;
      break;
    }
  }
  let pedida = null;
  let pedidaXf = 0;
  let xbulTok = "";
  if (unit !== null) {
    for (let j = unit_i + 1; j < Math.min(unit_i + 4, row.length); j++) {
      const d = _first_digits(row[j].t);
      if (d !== null) {
        pedida = d;
        pedidaXf = (row[j].x0 + row[j].x1) / 2 / width;
        break;
      }
    }
    xbulTok = unit_i > sku_i + 1 ? String(row[unit_i - 1].t || "") : "";
  }
  const isXbul = /^\|?\s*\d{1,4}\s*\|?$/.test(xbulTok);
  let end;
  if (unit !== null) {
    end = isXbul && unit_i - 2 >= sku_i + 1 ? unit_i - 2 : unit_i - 1;
    if (end < sku_i + 1) end = unit_i - 1;
  } else {
    // Celda de unidad ilegible a esta escala: el fin de la descripción es la
    // columna xBulto (x≈0.25). La fila NO se descarta: el re-OCR de banda a
    // mayor escala recupera unidad y Cant. Pedida (ver _pdf_band_refine).
    end = sku_i;
    for (let j = sku_i + 1; j < row.length; j++) {
      if ((row[j].x0 + row[j].x1) / 2 / width >= 0.25) break;
      end = j;
    }
  }
  let desc = "";
  for (let j = sku_i + 1; j <= end && j < row.length; j++) {
    if (desc) desc += " ";
    desc += row[j].t;
  }
  desc = desc
    .replace(/^[\|\[\]\(\)]+/, "")
    .replace(/[\|\[\]\(\)]+$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!desc) return null;
  // La celda de Cant. Pedida está en x≈0.30 (a escala 2, ancho 1584). Si el
  // token que tomó el parser quedó en la columna precio (>0.33) o con 4+
  // dígitos (una cantidad de pedido nunca supera 999), el OCR global degradó la
  // celda: la fila necesita re-OCR de banda. También es sospechosa si la celda
  // de unidad (b/d/a) no se leyó.
  const suspect =
    unit === null ||
    pedida === null ||
    pedidaXf > 0.33 ||
    (pedida !== null && /^\d{4,}$/.test(pedida));
  const cy = (row[sku_i].y0 + row[sku_i].y1) / 2;
  return {
    item: {
      sku,
      producto: desc.slice(0, 200),
      cantidad: pedida || "",
      unidad: unit || "",
      categoria: medida_categoria(unit),
    },
    sku,
    cy,
    pedida,
    unit,
    suspect,
  };
}

function _pdf_table_items(words, width, scale) {
  const items = [];
  for (const row of _pdf_build_rows(words, scale)) {
    const info = _pdf_row_info(width, row);
    if (info) items.push(info.item);
  }
  return items;
}

// TODAS las filas con sku, para el re-OCR de banda: la celda de unidad b/d/a
// es poco confiable a escala 2.0 (suele degradarse a "|p"/"|>"/"la"), así que
// el re-OCR a mayor escala la corrige en cada fila. Devuelve sku, cy y si la
// fila necesita fix de cantidad (suspect).
function _pdf_all_rows(words, width, scale) {
  const out = [];
  for (const row of _pdf_build_rows(words, scale)) {
    const info = _pdf_row_info(width, row);
    if (info) out.push({ sku: info.sku, cy: info.cy, pedida: info.pedida, suspect: info.suspect });
  }
  return out;
}

function _to_num(t) {
  let s = String(t || "").replace(/[^\d.,]/g, "");
  if (s.indexOf(",") !== -1 && s.indexOf(".") !== -1) {
    s = s.replace(/\./g, "").replace(",", ".");
  } else if (s.indexOf(",") !== -1) {
    s = s.replace(",", ".");
  }
  const v = parseFloat(s);
  return isNaN(v) ? null : v;
}

// Re-OCR de la banda horizontal de una fila (cy±18 a escala 2, normalizado por
// la altura de página) a mayor escala y extracción POSICIONAL de las celdas por
// columna del pedido del proveedor: sku (xf<0.10) · desc · xBulto (≈0.24-0.28)
// · unidad b/d/a (≈0.25-0.31) · **Cantidad Pedida** (≈0.28-0.36, la celda que
// tiene la letra b/d y el número a su derecha, excluyendo el xBulto) · … ·
// Precio (≈0.36-0.43) · Importe (≈0.66-0.74). Devuelve fixes parciales
// { sku?, unidad?, cantidad? } según lo que el re-OCR logró recuperar. Si la
// celda de Cant. Pedida sale ilegible pero se leen xBulto, precio e importe, la
// cantidad se deriva de importe/(xBulto×precio). fullCanvas (opcional) permite
// reutilizar la página ya renderizada a refineScale.
async function _pdf_band_refine(worker, page, rotation, sku, cy, width, height, scale, refineScale, fullCanvas) {
  const full = fullCanvas || (await _render_page(page, rotation, refineScale));
  try {
    const ya = Math.max(0, (cy - 18) / height);
    const yb = Math.min(1, (cy + 18) / height);
    const top = full.height * ya;
    const bh = Math.max(1, Math.round(full.height * (yb - ya)));
    const band = document.createElement("canvas");
    band.width = full.width;
    band.height = bh;
    band.getContext("2d").drawImage(full, 0, top, full.width, bh, 0, 0, band.width, band.height);
    const r = await _ocr_canvas(worker, band);
    const k = scale / refineScale;
    const offset = cy - 18;
    const rowWords = (r.words || [])
      .map((w) => ({
        t: w.t,
        x0: w.x0 * k,
        x1: w.x1 * k,
        y0: w.y0 * k + offset,
        y1: w.y1 * k + offset,
      }))
      .filter((w) => w.t && String(w.t).trim() !== "" && Math.abs((w.y0 + w.y1) / 2 - cy) <= 8)
      .sort((a, b) => a.x0 - b.x0);
    const fix = {};
    // SKU: el código del proveedor es el primer token de 4-6 dígitos en la
    // primera columna; si el OCR global lo había leído mal (ej. "2848" por
    // "4848") el re-OCR lo corrige.
    const skuIdx = rowWords.findIndex((w) => (w.x0 + w.x1) / 2 / width < 0.1 && /^\d{4,6}$/.test(w.t));
    if (skuIdx >= 0 && rowWords[skuIdx].t !== sku) fix.sku = rowWords[skuIdx].t;
    // UNIDAD: la celda b/d/a está justo a la derecha del xBulto (xf≈0.27-0.31,
    // token con | como "|b"/"|d", o "6|b" degradado). Se prefiere un token con
    // | (celda de unidad real) sobre una letra suelta de ruido ("A" de la
    // separación de columnas), que el OCR de 3.5 suele inventar a la izquierda.
    let unitTok = null;
    for (let j = skuIdx + 1; j < rowWords.length; j++) {
      const xf = (rowWords[j].x0 + rowWords[j].x1) / 2 / width;
      if (xf < 0.265 || xf > 0.31) continue;
      const u = _unit_letter(rowWords[j].t);
      if (!u) continue;
      const shaped = /[|]/.test(rowWords[j].t);
      if (!unitTok || (!unitTok.shaped && shaped)) unitTok = { u, shaped };
    }
    if (unitTok) fix.unidad = unitTok.u;
    // xBulto, Cant. Pedida, precio e importe por posición de columna.
    let xbul = null;
    let pedida = null;
    let precio = null;
    let importe = null;
    for (let j = skuIdx + 1; j < rowWords.length; j++) {
      const xf = (rowWords[j].x0 + rowWords[j].x1) / 2 / width;
      const d = _first_digits(rowWords[j].t);
      if (d === null || xf < 0.24) continue;
      if (xf < 0.28 && xbul === null && /^\d{1,4}$/.test(d)) xbul = d;
      else if (xf >= 0.28 && xf <= 0.36 && pedida === null && /^[1-9]\d{0,2}$/.test(d)) pedida = d;
      else if (xf > 0.36 && xf < 0.43 && precio === null && /^\d{1,4}$/.test(d)) precio = _to_num(rowWords[j].t);
      else if (xf > 0.66 && xf < 0.74 && importe === null) importe = _to_num(rowWords[j].t);
    }
    if (pedida) {
      fix.cantidad = pedida;
    } else if (xbul !== null && precio !== null && importe !== null && precio > 0) {
      // La celda no se leyó: derivar del importe (cantidad = importe/(xBulto×precio)).
      const q = importe / (parseFloat(xbul) * precio);
      if (q > 0 && Math.abs(q - Math.round(q)) < 0.01 && Math.round(q) <= 999) {
        fix.cantidad = String(Math.round(q));
      }
    }
    return fix;
  } finally {
    if (!fullCanvas) {
      full.width = 0;
      full.height = 0;
    }
  }
}

// ------------------------------------------------------------- lineas

const PRODUCT_CONCEPTS = new Set([
  "sku", "producto", "cantidad", "medida", "precio", "importe", "marca", "porcentaje_descuento",
]);

function _find_product_header(rows) {
  for (let i = 0; i < rows.length; i++) {
    const cells = rows[i].filter((c) => c != null && String(c).trim() !== "").map((c) => String(c).trim());
    if (cells.length >= 2) {
      const matches = cells.filter((c) => PRODUCT_CONCEPTS.has(match_concept(c))).length;
      if (matches >= 2) return i;
    }
  }
  return null;
}

function _rows_to_pairs(rows, maxRows = 40) {
  rows = rows.slice(0, maxRows);
  const pairs = [];
  const seen = new Set();
  let start = 0;

  if (rows.length >= 2) {
    const r0 = rows[0].map((c) => (c == null ? "" : String(c).trim()));
    const labels = r0.filter((x) => x);
    const data = rows[1].map((c) => (c == null ? "" : String(c).trim()));
    if (
      labels.length >= 2 &&
      labels.some((l) => match_concept(l)) &&
      !labels.some((l) => /\d/.test(l) || l.includes("@")) &&
      data.some((v) => looks_like_value(v))
    ) {
      for (let j = 0; j < Math.min(r0.length, data.length); j++) {
        const key = r0[j];
        const value = data[j];
        if (!key || !value) continue;
        const concept = match_concept(key);
        if (concept || looks_like_value(value)) {
          if (!seen.has(key) && value.length < 200) {
            seen.add(key);
            pairs.push({ key, value });
          }
        }
      }
      start = 2;
    }
  }

  for (let ri = start; ri < rows.length; ri++) {
    const vals = rows[ri].filter((c) => c != null && String(c).trim() !== "").map((c) => String(c).trim());
    let i = 0;
    while (i < vals.length - 1) {
      const concept = match_concept(vals[i]);
      if (concept && vals[i + 1]) {
        const key = vals[i];
        const value = vals[i + 1];
        if (!seen.has(key) && value.length < 200) {
          seen.add(key);
          pairs.push({ key, value });
        }
        i += 2;
      } else {
        i += 1;
      }
    }
  }
  return pairs;
}

function _col_for(headerTexts, concepts) {
  for (let i = 0; i < headerTexts.length; i++) {
    if (concepts.has(match_concept(headerTexts[i]))) return i;
  }
  return null;
}

function _is_line_row(values, idxSku, idxProd, idxQty, idxPrice, idxImport) {
  const filled = values.filter((v) => v != null && String(v).trim() !== "").length;
  if (filled === 0) return false;
  const get = (idx) =>
    idx != null && values[idx] != null && String(values[idx]).trim() !== "";
  const hasProd = (idxProd != null && get(idxProd)) || (idxSku != null && get(idxSku));
  const hasQty =
    (idxQty != null && values[idxQty] != null &&
      (is_numeric(values[idxQty]) || parse_qty(values[idxQty]) !== null));
  const hasPrice =
    (idxPrice != null && values[idxPrice] != null && is_numeric(values[idxPrice])) ||
    (idxImport != null && values[idxImport] != null && is_numeric(values[idxImport]));
  if (hasProd && (hasQty || hasPrice)) return true;
  if (idxSku != null && hasQty && !hasProd) return true;
  return false;
}

function _build_table_obj(sheet, rows, headerIdx) {
  if (!rows || !rows.length) return null;
  if (headerIdx === undefined || headerIdx === null) {
    headerIdx = null;
    for (let i = 0; i < Math.min(12, rows.length); i++) {
      const nonempty = rows[i].filter((c) => c != null && String(c).trim() !== "").length;
      if (nonempty >= 2) {
        headerIdx = i;
        break;
      }
    }
  }
  if (headerIdx === null) return null;

  const headers = rows[headerIdx].map((c) => (c == null ? "" : String(c).trim()));
  const dataRows = rows.slice(headerIdx + 1);

  const rowDicts = dataRows.map((row) => {
    const d = {};
    headers.forEach((h, i) => {
      const val = row[i];
      if (val != null && String(val).trim() !== "") d[h] = String(val).trim();
    });
    return d;
  });

  const idxSku = _col_for(headers, new Set(["sku"]));
  const idxProd = _col_for(headers, new Set(["producto"]));
  const idxMed = _col_for(headers, new Set(["medida"]));
  const idxQty = _col_for(headers, new Set(["cantidad"])) ?? idxMed;
  const idxPrice = _col_for(headers, new Set(["precio"]));
  const idxImport = _col_for(headers, new Set(["importe"]));

  const lineItems = [];
  for (const row of dataRows) {
    if (_is_line_row(row, idxSku, idxProd, idxQty, idxPrice, idxImport)) {
      const cantidad = idxQty != null && idxQty < row.length ? String(row[idxQty]).trim() : "";
      let unidad = "";
      if (idxMed != null && idxMed < row.length && idxMed !== idxQty && String(row[idxMed]).trim()) {
        unidad = String(row[idxMed]).trim();
      } else {
        const q = parse_qty(cantidad);
        if (q && q.unit) unidad = q.unit;
      }
      lineItems.push({
        sku: idxSku != null && idxSku < row.length ? clean_value(row[idxSku]) : "",
        producto: idxProd != null && idxProd < row.length ? String(row[idxProd]).trim() : "",
        cantidad,
        unidad,
        categoria: medida_categoria(unidad),
        precio: idxPrice != null && idxPrice < row.length ? String(row[idxPrice]).trim() : "",
        importe: idxImport != null && idxImport < row.length ? String(row[idxImport]).trim() : "",
      });
    }
  }

  return {
    sheet,
    headers,
    rows: rowDicts,
    line_items: lineItems,
    col_indexes: { sku: idxSku, producto: idxProd, cantidad: idxQty, precio: idxPrice, importe: idxImport, medida: idxMed },
  };
}

// ------------------------------------------------------------- kv text

const _KV_RE = /^\s*([A-Za-záéíóúüñÁÉÍÓÚÜÑ0-9][^:;]{0,48}?)\s*[:;]\s*(.+?)\s*$/;

// En un renglón OCR pueden convivir varias claves ("PEDIDO NRO: 3400 FECHA: ...").
// Corta el valor en la primera clave conocida que aparezca después del ":".
const _KV_NEXT_RE =
  /\s+(?:fecha|fecha de entrega|vendedor|comprador|direccion|dirección|proveedor|cliente|domicilio|telefono|teléfono|observaciones|condicion|condición|sucursal|pedido nro|nota de pedido|importe|total|subtotal|lista de precios)\s*:/i;

function _kv_from_text(text) {
  const pairs = [];
  const seen = new Set();
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = _KV_RE.exec(line);
    if (!m || !match_concept(m[1])) continue;
    const key = m[1].trim();
    if (seen.has(key)) continue; // primera página gana
    let value = m[2].trim().replace(/\s{2,}/g, " ");
    const cut = _KV_NEXT_RE.exec(value);
    if (cut) value = value.slice(0, cut.index);
    value = value.trim().replace(/[\|\[\]•*]+$/g, "").trim();
    if (!value) continue;
    seen.add(key);
    pairs.push({ key, value: value.slice(0, 140) });
  }
  return pairs;
}

function _build_doc_from_sheets(sheets, doc) {
  const allItems = [];
  const tables = [];
  const preRows = [];
  for (const s of sheets) {
    const rows = s.rows;
    const ph = _find_product_header(rows);
    if (ph !== null) {
      preRows.push(...rows.slice(0, ph));
      const t = _build_table_obj(s.sheet, rows, ph);
      if (t) {
        tables.push(t);
        allItems.push(...t.line_items);
      }
    } else {
      preRows.push(...rows);
    }
  }
  doc.kv_pairs.push(..._rows_to_pairs(preRows));
  doc.tables.push(...tables);
  doc.line_items.push(...allItems);
  return doc;
}

async function _fingerprint(doc) {
  const fpSource = [];
  for (const t of doc.tables) fpSource.push(t.headers.join("|"));
  for (const p of doc.kv_pairs.slice(0, 12)) fpSource.push(normalize(p.key));
  const str = fpSource.join("||");
  const data = new TextEncoder().encode(str);
  const buf = await crypto.subtle.digest("SHA-256", data);
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, "0");
  return hex.slice(0, 12);
}

// ---------------------------------------------------------------- parse

export async function parseDocument(filename, data, onProgress, onCancel) {
  const ext = filename.includes(".") ? filename.split(".").pop().toLowerCase() : "";
  const doc = {
    filename,
    file_type: ext,
    markdown: "",
    kv_pairs: [],
    tables: [],
    line_items: [],
    fingerprint: "",
    error: "",
  };

  try {
    if (["xlsx", "xlsm", "xls"].includes(ext)) {
      const sheets = _xlsx_rows(data);
      doc.file_type = "excel";
      _build_doc_from_sheets(sheets, doc);
    } else if (ext === "csv") {
      _build_doc_from_sheets(_csv_rows(data), doc);
      doc.file_type = "csv";
    } else if (["pdf", "docx", "doc"].includes(ext)) {
      if (ext === "docx" || ext === "doc") {
        const res = await _docx(data);
        const { text, tables } = _docx_to_tables(res.value);
        doc.markdown = text;
        doc.file_type = "docx";
        for (const t of tables) {
          const ph = _find_product_header(t.rows);
          const obj = _build_table_obj(t.sheet, t.rows, ph !== null ? ph : undefined);
          if (obj) {
            doc.tables.push(obj);
            doc.line_items.push(...obj.line_items);
          }
        }
        doc.kv_pairs.push(..._kv_from_text(text));
      } else {
        const { text, pages } = await _pdf_text(data, onProgress, onCancel);
        doc.markdown = text;
        doc.file_type = "pdf";
        doc.kv_pairs.push(..._kv_from_text(text));
        for (const p of pages) {
          const items = _pdf_table_items(p.words, p.w, p.scale);
          if (p.qtyFix) {
            for (const it of items) {
              const f = p.qtyFix[it.sku];
              if (!f) continue;
              if (f.sku) it.sku = f.sku;
              if (f.cantidad != null) it.cantidad = f.cantidad;
              if (f.unidad) {
                it.unidad = f.unidad;
                it.categoria = medida_categoria(f.unidad);
              }
            }
          }
          // Descarta filas que no son líneas de pedido: sin Cant. Pedida NI
          // unidad aun después del re-OCR de banda (ej. el bloque de dirección
          // "1440 C.A.B.A." del encabezado, que el OCR lee con un número).
          const items2 = items.filter((it) => it.cantidad || it.unidad);
          if (!items2.length) continue;
          doc.tables.push({
            sheet: "página " + p.page,
            headers: ["sku", "producto", "cantidad", "unidad", "categoria"],
            rows: items2.map((it) => ({
              sku: it.sku,
              producto: it.producto,
              cantidad: it.cantidad,
              unidad: it.unidad,
              categoria: it.categoria,
            })),
            line_items: items2,
            col_indexes: { sku: 0, producto: 1, cantidad: 2, unidad: 3 },
          });
          doc.line_items.push(...items2);
        }
      }
    } else {
      doc.error = `Formato no soportado: .${ext}`;
      doc.kv_pairs = [{ key: "error", value: `Formato no soportado: .${ext}` }];
    }
  } catch (e) {
    if (e && e.name === "CancelError") throw e;
    doc.error = String(e && e.message ? e.message : e);
    if (!doc.kv_pairs.length) doc.kv_pairs = [{ key: "error", value: doc.error }];
  }

  doc.fingerprint = await _fingerprint(doc);
  return doc;
}

// ------------------------------------------------------------------ mapeo

function _concept_value_from_doc(doc, concept) {
  for (const p of doc.kv_pairs) {
    if (match_concept(p.key) === concept) {
      return [clean_value(p.value), p.key];
    }
  }
  for (const t of doc.tables) {
    if (t.rows.length === 1) {
      const row = t.rows[0];
      for (const h of t.headers) {
        if (match_concept(h) === concept) {
          const val = row[h] || "";
          if (val) return [clean_value(val), h];
        }
      }
    }
  }
  return [null, null];
}

function _value_from_source(doc, source) {
  for (const t of doc.tables) {
    for (const h of t.headers) {
      if (normalize(h) === normalize(source)) {
        if (t.rows.length === 1) return clean_value(t.rows[0][h] || "");
        return null;
      }
    }
  }
  for (const p of doc.kv_pairs) {
    if (normalize(p.key) === normalize(source)) return clean_value(p.value);
  }
  return null;
}

export function mapFields(formFields, doc, memory) {
  memory = memory || {};
  const memForDoc = memory[doc.fingerprint] || {};
  const mapping = [];
  const lineCols = [];

  for (const field of formFields) {
    const key = field.key || field.id || field.name || "";
    const labels = [];
    for (const attr of ["label", "placeholder", "ariaLabel", "name", "id", "dataId"]) {
      if (field[attr]) labels.push(String(field[attr]));
    }
    const normLabels = labels.map((l) => normalize(l)).filter(Boolean);

    let concept = null;
    for (const nl of normLabels) {
      const c = match_concept(nl);
      if (c) {
        concept = c;
        break;
      }
    }

    if (["sku", "producto", "cantidad", "precio", "importe", "marca"].includes(concept)) {
      lineCols.push({ field_key: key, concept, labels });
      continue;
    }

    if (concept === null) {
      mapping.push({ field_key: key, concept: null, value: null, confidence: "baja", source: "sin coincidencia" });
      continue;
    }

    let value = null;
    let source = null;
    const memorized = memForDoc[key];
    if (memorized) {
      if (typeof memorized === "object") {
        if (memorized.type === "static" && memorized.value) {
          value = memorized.value;
          source = "memoria: valor fijo";
        } else {
          const src = memorized.source || "";
          value = _value_from_source(doc, src);
          source = "memoria: " + src;
        }
      } else {
        value = _value_from_source(doc, memorized);
        source = "memoria: " + memorized;
      }
    }

    if (value === null) {
      const res = _concept_value_from_doc(doc, concept);
      value = res[0];
      source = res[1];
    }

    if (value) {
      const entry = { field_key: key, concept, value, confidence: "alta", source: source || concept };
      if (concept === "fecha" || concept === "fecha_pedido") entry.value_iso = date_iso(value);
      if (concept === "telefono") entry.value_phone = phone_clean(value);
      mapping.push(entry);
    } else {
      mapping.push({ field_key: key, concept, value: null, confidence: "media", source: "sin dato en documento" });
    }
  }

  return { mapping, line_item_columns: lineCols };
}

export function summarize(doc) {
  return {
    file_type: doc.file_type,
    filename: doc.filename,
    fingerprint: doc.fingerprint,
    error: doc.error || "",
    kv_pairs: doc.kv_pairs.slice(0, 20),
    tables: doc.tables.map((t) => ({
      sheet: t.sheet,
      headers: t.headers,
      row_count: t.rows.length,
      line_items: t.line_items.length,
    })),
    line_items: doc.line_items.slice(0, 200),
  };
}
