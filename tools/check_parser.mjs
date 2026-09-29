// Verifica el PARSER real de agent.js (extraído del archivo, no reimplementado)
// contra el pedido real "PEDIDO OSLO PRUEBA 25.09.xlsx", y además el camino de
// CSV con el caso nuevo de "1 unidad" explícito.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { normalize, clean_value, is_numeric, parse_qty, match_concept, medida_categoria }
  from "../extension/core/normalize.js";

const root = path.resolve(process.cwd());
const agentPath = path.join(root, "extension", "core", "agent.js");
const src = fs.readFileSync(agentPath, "utf8");

// --- Extracción de código real -------------------------------------------
function extractFunction(from, name) {
  const start = from.search(new RegExp("(async\\s+)?function\\s+" + name + "\\s*\\("));
  if (start < 0) throw new Error("no encontre la funcion " + name);
  let i = from.indexOf("{", start), depth = 0, prev = "";
  for (; i < from.length; i++) {
    const ch = from[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch; i++;
      while (i < from.length) {
        if (from[i] === "\\") { i++; continue; }
        if (from[i] === q) break;
        i++;
      }
      prev = q; continue;
    }
    if (ch === "/" && from[i + 1] === "/") { while (i < from.length && from[i] !== "\n") i++; continue; }
    if (ch === "/" && from[i + 1] === "*") { i = from.indexOf("*/", i) + 1; continue; }
    if (ch === "/") {
      if ("([{,;:=!&|?+-*%<>~^".includes(prev)) {
        i++; let inClass = false;
        while (i < from.length) {
          if (from[i] === "\\") { i += 2; continue; }
          if (from[i] === "[") inClass = true;
          else if (from[i] === "]") inClass = false;
          else if (from[i] === "/" && !inClass) break;
          i++;
        }
      } else { while (i < from.length && from[i] !== "\n") i++; }
      prev = "/"; continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return from.slice(start, i + 1); }
    if (!/\s/.test(ch)) prev = ch;
  }
  throw new Error("no pude cerrar la funcion " + name);
}

const require_ = createRequire(import.meta.url);
const XLSXLIB = require_("xlsx");

const code = [
  "const lib = () => globalThis.__XLSX;",
  extractFunction(src, "sniffDelimiter"),
  extractFunction(src, "parseCsv"),
  extractFunction(src, "_first_digits"),
  extractFunction(src, "_es_unidad_sospechosa"),
  extractFunction(src, "_col_for"),
  extractFunction(src, "_is_line_row"),
  extractFunction(src, "_build_table_obj"),
  "return { parseCsv, _es_unidad_sospechosa, _build_table_obj };",
].join("\n\n");

globalThis.__XLSX = XLSXLIB;
// Se usa el normalize.js REAL (importado, no reimplementado) para el mapeo de
// columnas y las unidades.
const api = new Function("normalize", "clean_value", "is_numeric", "parse_qty", "match_concept", "medida_categoria", code)
  (normalize, clean_value, is_numeric, parse_qty, match_concept, medida_categoria);

// --- Aserciones ------------------------------------------------------------
let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log("  FALLA " + msg); } else console.log("  ok    " + msg); };

console.log("\n1) El pedido real OSLO se lee completo");
const fixture = path.join(root, "..", "PEDIDO OSLO PRUEBA 25.09.xlsx");
const wb = XLSXLIB.readFile(fixture);
let lineas = null;
let tabla = null;
for (const nombre of wb.SheetNames) {
  const rows = XLSXLIB.utils.sheet_to_json(wb.Sheets[nombre], { header: 1, raw: true, defval: "" });
  const t = api._build_table_obj(nombre, rows, null);
  if (t && t.line_items && t.line_items.length > (lineas ? lineas.length : 0)) { tabla = t; lineas = t.line_items; }
}
ok(!!lineas, "se encontró una tabla con líneas en " + wb.SheetNames.join(" / "));
ok(lineas && lineas.length === 83, "el pedido OSLO da 83 líneas (obtenidas: " + (lineas ? lineas.length : 0) + ")");
ok(lineas && lineas.every((l) => l.producto), "ninguna línea viene sin producto");
ok(lineas && lineas.every((l) => l.cantidad !== "" && l.cantidad != null), "ninguna línea viene sin cantidad");
ok(lineas && lineas.every((l) => l.unidadSospechosa === false || l.unidadSospechosa === true),
  "todas las líneas traen el booleano unidadSospechosa");

// La regla: unidadSospechosa solo puede ser true si la cantidad es 1 y la unidad
// es un alias explícito de UNIDAD. Nunca para display/bulto/caja, nunca sin
// columna de unidad, nunca con cantidad distinta de 1.
const ALIAS = new Set(["unidad", "unidades", "un", "und", "unid", "uni", "uds", "ud", "u", "a"]);
const norm = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
const sospechosos = lineas.filter((l) => l.unidadSospechosa === true);
console.log("  info  líneas marcadas como '1 unidad' en el OSLO: " + sospechosos.length +
  (sospechosos.length ? " -> " + sospechosos.slice(0, 5).map((l) => l.cantidad + " " + l.unidad + " " + l.producto.slice(0, 22)).join(" | ") : ""));
ok(sospechosos.every((l) => String(l.cantidad).trim() === "1"), "sólo se marcan líneas con cantidad 1");
ok(sospechosos.every((l) => ALIAS.has(norm(l.unidad))), "sólo se marcan líneas con unidad explícita de UNIDAD");
ok(lineas.every((l) => l.unidadSospechosa !== true || !/^(display|bulto|caja)/.test(norm(l.unidad))),
  "1 display / 1 bulto / 1 caja nunca se marcan");
const sinUnidad = lineas.filter((l) => !norm(l.unidad || l.categoria));
ok(sinUnidad.every((l) => l.unidadSospechosa !== true), "las líneas sin columna de unidad NO se marcan");

console.log("\n2) El camino de CSV marca el '1 unidad' explícito");
// Mismo _build_table_obj, pero sobre filas venidas de un CSV.
const filasCsv = [
  ["SKU", "Producto", "Cantidad", "U.M"],
  ["10001", "GASEOSA 2,25 LT", "2", "caja"],
  ["10002", "PAN", "1", "UN"],
  ["10003", "QUESO", "1", "unidad"],
  ["10004", "JAMON", "1", "bulto"],
  ["10005", "LECHE", "1", "display"],
  ["10006", "QUESO", "3", "UN"],
  ["10007", "PAN", "", "UN"],
];
const tCsv = api._build_table_obj("csv", filasCsv, 0);
const porSku = {};
for (const l of tCsv.line_items) porSku[l.sku] = l;
ok(tCsv.line_items.length === 6, "el CSV de prueba da 6 líneas: la fila sin cantidad se descarta (obtenidas: " + tCsv.line_items.length + ")");
ok(!porSku["10007"], "una línea sin cantidad no es una línea del pedido");
ok(porSku["10001"].unidadSospechosa === false, "2 caja NO se marca");
ok(porSku["10002"].unidadSospechosa === true, "1 UN (abreviatura) SÍ se marca");
ok(porSku["10003"].unidadSospechosa === true, "1 unidad SÍ se marca");
ok(porSku["10004"].unidadSospechosa === false, "1 bulto NO se marca");
ok(porSku["10005"].unidadSospechosa === false, "1 display NO se marca");
ok(porSku["10006"].unidadSospechosa === false, "3 UN NO se marca (no es 1)");
ok(porSku["10002"].categoria === "unidad" && porSku["10004"].categoria === "bulto",
  "la categoría sigue saliendo bien ('unidad' / 'bulto')");

console.log("\n3) El detector, directo");
ok(api._es_unidad_sospechosa("1", "UN") === true, "_es_unidad_sospechosa(1, UN) = true");
ok(api._es_unidad_sospechosa("1", "caja") === false, "_es_unidad_sospechosa(1, caja) = false");
ok(api._es_unidad_sospechosa("2", "unidad") === false, "_es_unidad_sospechosa(2, unidad) = false");
ok(api._es_unidad_sospechosa("1", "") === false, "sin unidad no hay sospecha");

console.log(bad ? "\nFALLAS: " + bad : "\nOK: parser correcto (" + (lineas ? lineas.length : 0) + " líneas OSLO)");
process.exit(bad ? 1 : 0);
