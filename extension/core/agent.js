// Motor de extraccion y mapeo, 100% en el navegador.
// Portado de server/agent.py (sin Python): parsea XLSX/XLS/CSV (SheetJS),
// DOCX (mammoth) y PDF (pdf.js, best-effort) y arma mapeos campo->valor.
import {
  normalize,
  clean_value,
  date_iso,
  phone_clean,
  is_numeric,
  match_concept,
  looks_like_value,
} from "./normalize.js";

function lib(name) {
  return (typeof globalThis !== "undefined" && globalThis[name]) || null;
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

function _pdf_text(data) {
  const pdfjs = lib("pdfjsLib");
  if (!pdfjs) throw new Error("pdf.min.js no está cargado.");
  if (!pdfjs.GlobalWorkerOptions.workerSrc && typeof chrome !== "undefined") {
    try {
      pdfjs.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("lib/pdf.worker.min.js");
    } catch (e) {}
  }
  return pdfjs.getDocument({ data }).promise.then(async (pdf) => {
    let text = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const tc = await page.getTextContent();
      const byY = {};
      for (const item of tc.items) {
        if (!item.str) continue;
        const y = Math.round(item.transform[5]);
        const x = Math.round(item.transform[4]);
        (byY[y] = byY[y] || []).push({ x, str: item.str });
      }
      const ys = Object.keys(byY).map(Number).sort((a, b) => a - b);
      for (const y of ys) {
        byY[y].sort((a, b) => a.x - b.x);
        text += byY[y].map((l) => l.str).join(" ") + "\n";
      }
      text += "\n";
    }
    return text;
  });
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
  const hasQty = idxQty != null && values[idxQty] != null && is_numeric(values[idxQty]);
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
  const idxQty = _col_for(headers, new Set(["cantidad", "medida"]));
  const idxPrice = _col_for(headers, new Set(["precio"]));
  const idxImport = _col_for(headers, new Set(["importe"]));

  const lineItems = [];
  for (const row of dataRows) {
    if (_is_line_row(row, idxSku, idxProd, idxQty, idxPrice, idxImport)) {
      lineItems.push({
        sku: idxSku != null && idxSku < row.length ? clean_value(row[idxSku]) : "",
        producto: idxProd != null && idxProd < row.length ? String(row[idxProd]).trim() : "",
        cantidad: idxQty != null && idxQty < row.length ? String(row[idxQty]).trim() : "",
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
    col_indexes: { sku: idxSku, producto: idxProd, cantidad: idxQty, precio: idxPrice, importe: idxImport },
  };
}

// ------------------------------------------------------------- kv text

const _KV_RE = /^\s*([A-Za-záéíóúüñÁÉÍÓÚÜÑ0-9][^:;]{0,48}?)\s*[:;]\s*(.+?)\s*$/;

function _kv_from_text(text) {
  const pairs = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = _KV_RE.exec(line);
    if (m && match_concept(m[1])) {
      pairs.push({ key: m[1], value: m[2] });
    }
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

export async function parseDocument(filename, data) {
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
        const text = await _pdf_text(data);
        doc.markdown = text;
        doc.file_type = "pdf";
        doc.kv_pairs.push(..._kv_from_text(text));
      }
    } else {
      doc.error = `Formato no soportado: .${ext}`;
      doc.kv_pairs = [{ key: "error", value: `Formato no soportado: .${ext}` }];
    }
  } catch (e) {
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
