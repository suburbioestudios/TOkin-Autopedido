// Verifica las tres reglas nuevas de v2.0.84 ejecutando el código REAL de
// content.js (extraído del archivo, no reimplementado):
//   1) el bloqueo de "1 unidad" (que mira el TOTAL del producto en todo el
//      pedido, no el de la línea, para no bloquear duplicados de "1 unidad"),
//   2) el cuarto requisito del match: la conversión tiene que estar resuelta
//      para poder confirmar un "sin stock",
//   3) tokSinStockConfirmado: código flexible + nombre + gramaje + conversión.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const src = fs.readFileSync(path.join(root, "extension", "content.js"), "utf8");
const agentSrc = fs.readFileSync(path.join(root, "extension", "core", "agent.js"), "utf8");

// --- Extracción de código real -------------------------------------------
// Escáner que salta strings, comentarios y regex para recién ahí contar llaves.
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
      }
      // Si no introduce una regex es division (ej. "w.x0 / width"): avanzar un
      // caracter. Tratarla como comentario se comia el cierre de llaves de la
      // fila y cortaba la extraccion de _pdf_row_info.
      prev = "/"; continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return from.slice(start, i + 1); }
    if (!/\s/.test(ch)) prev = ch;
  }
  throw new Error("no pude cerrar la funcion " + name);
}

const code = [
  'const TOK_PACK_TYPES = new Set(["display", "bulto", "caja"]);',
  'const TOK_UNIDAD_ALIASOS = new Set(["unidad", "unidades", "un", "und", "unid", "uni", "uds", "ud", "u", "a"]);',
  // stubs mínimos de los helpers que usan las reglas probadas
  'function tokNorm(s){return String(s||"").toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g,"").replace(/[^a-z0-9]+/g," ").trim();}',
  extractFunction(src, "tokTitlePack"),
  extractFunction(src, "tokCaptFactors"),
  extractFunction(src, "tokConvFactor"),
  extractFunction(src, "tokUnidadSospechosa"),
  extractFunction(src, "tokConversionResuelta"),
  extractFunction(src, "tokSinStockConfirmado"),
  "return { tokUnidadSospechosa, tokConversionResuelta, tokSinStockConfirmado, tokCaptFactors };",
].join("\n\n");

const api = new Function(code)();

// --- Aserciones ------------------------------------------------------------
let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log("  FALLA " + msg); } else console.log("  ok    " + msg); };

console.log("\n1) Bloqueo de '1 unidad' (mira el TOTAL del pedido, no la línea)");
const linea1 = { producto: "GASEOSA", cantidad: "1", categoria: "unidad", sku: "11777" };
ok(api.tokUnidadSospechosa(linea1, 1), "1 unidad explícito con total 1 → sospechoso (se bloquea)");
ok(!api.tokUnidadSospechosa(linea1, 2), "1 unidad en la línea pero total 2 → NO sospechoso (líneas duplicadas)");
ok(!api.tokUnidadSospechosa({ ...linea1, cantidad: "2" }, 2), "2 unidades → no es el caso '1 unidad'");
ok(!api.tokUnidadSospechosa({ producto: "X", cantidad: "1", categoria: "caja", sku: "1" }, 1), "1 caja NO se bloquea (1 display/1 bulto/1 caja son válidos)");
ok(!api.tokUnidadSospechosa({ producto: "X", cantidad: "1", categoria: "bulto", sku: "1" }, 1), "1 bulto NO se bloquea");
ok(!api.tokUnidadSospechosa({ producto: "X", cantidad: "1", categoria: "display", sku: "1" }, 1), "1 display NO se bloquea");
ok(!api.tokUnidadSospechosa({ producto: "X", cantidad: "3", categoria: "unidad", sku: "1" }, 3), "3 unidades no se bloquean");
ok(!api.tokUnidadSospechosa({ producto: "X", cantidad: "", unidad: "", sku: "1" }, 1), "sin columna de unidad no se bloquea (no se inventa una unidad)");
ok(api.tokUnidadSospechosa({ producto: "X", cantidad: "1", categoria: "UN", sku: "1" }, 1), "abrevia la 'UN' del PDF también se reconoce");
ok(api.tokUnidadSospechosa({ producto: "X", cantidad: "1", categoria: "UND", sku: "1" }, 1), "abrevia la 'UND' del PDF también se reconoce");
ok(!api.tokUnidadSospechosa(null, 1), "sin línea no hay bloqueo");

console.log("\n2) La conversión tiene que estar resuelta para afirmar un faltante");
// Ojo con el formato: el factor del título se lee "12x2", no "CAJA x12" (la x
// tiene que ir PRECEDIDA por el número); el de la card se lee "caja 12 unidades".
const cardPack = "Gaseosa 2,25 LT caja 12 unidades";
const cap = api.tokCaptFactors(cardPack);
ok((cap.caja || 0) > 0, "tokCaptFactors real lee el factor de la card: " + JSON.stringify(cap));
ok(api.tokConversionResuelta({ producto: "GASEOSA", pack_factors: {} }, "caja", cardPack),
  "pack con factor en la card → resuelta");
ok(api.tokConversionResuelta({ producto: "GASEOSA CAJA 12x2", pack_factors: {} }, "caja", "Gaseosa"),
  "pack con factor en el título (12x2) → resuelta");
ok(api.tokConversionResuelta({ producto: "GASEOSA", pack_factors: {} }, "unidad", cardPack),
  "unidad suelta es 1:1 → resuelta");
ok(api.tokConversionResuelta({ producto: "COMBO 2", pack_factors: {} }, "combo", cardPack),
  "combo se carga 1:1 → resuelta");
ok(!api.tokConversionResuelta({ producto: "GASEOSA CAJA x12", pack_factors: {} }, "caja", "Gaseosa sin pack declarado"),
  "'CAJA x12' NO es un factor (la x va precedida por el número) → NO resuelta");
ok(!api.tokConversionResuelta({ producto: "PRODUCTO", pack_factors: {} }, "caja", "Gaseosa sin pack declarado"),
  "caja sin factor en ningún lado → NO resuelta (el faltante no es afirmable)");
ok(!api.tokConversionResuelta(null, "bulto", cardPack), "sin línea no hay conversión resuelta");
const conHeader = { producto: "PRODUCTO", pack_factors: { bulto: 24 } };
ok(api.tokConversionResuelta(conHeader, "bulto", "Gaseosa sin pack declarado"),
  "el factor del encabezado del pedido (pack_factors) cuenta como resolución");

console.log("\n3) SIN STOCK CONFIRMADO: código + nombre + gramaje + conversión");
const candOk = { matchByCode: true, matchName: "ok", matchGrams: "ok" };
const itCaja = { producto: "GASEOSA 2,25 LT CAJA 12x2", categoria: "caja", pack_factors: { caja: 12 } };
const mk = () => ({ ok: false, message: "encontrado pero sin stock (11777)", convFactor: 0 });

let out = mk();
ok(api.tokSinStockConfirmado(out, candOk, 2, itCaja, "caja", "Gaseosa sin pack declarado"),
  "sin stock + match entero + conversión resuelta → CONFIRMADO");
ok(out.confirmado === true, "el resultado queda marcado confirmado para el reporte");
out = mk();
ok(api.tokSinStockConfirmado(out, candOk, 2, { producto: "GASEOSA 2,25 LT CAJA 12x2", categoria: "caja", pack_factors: {} }, "caja", "Gaseosa sin pack declarado"),
  "el factor también puede venir del título del pedido (12x2) → CONFIRMADO");

out = mk();
ok(!api.tokSinStockConfirmado(out, { matchByCode: false, matchName: "ok", matchGrams: "ok" }, 2, itCaja, "caja", "card"),
  "sin coincidencia de código → NO confirmado (puede ser otro producto)");
out = mk();
ok(!api.tokSinStockConfirmado(out, { matchByCode: true, matchName: "skip", matchGrams: "ok" }, 2, itCaja, "caja", "card"),
  "nombre no verificado → NO confirmado");
out = mk();
ok(!api.tokSinStockConfirmado(out, { matchByCode: true, matchName: "ok", matchGrams: "skip" }, 2, itCaja, "caja", "card"),
  "gramaje no verificado → NO confirmado");
out = mk();
ok(!api.tokSinStockConfirmado(out, candOk, 2, { producto: "PRODUCTO", categoria: "caja", pack_factors: {} }, "caja", "Gaseosa sin pack declarado"),
  "caja sin ningún factor conocido → NO confirmado (no se puede afirmar cuántas unidades faltaron)");
out = mk();
ok(!api.tokSinStockConfirmado({ ...mk(), ok: true }, candOk, 2, itCaja, "caja", "card"),
  "si la línea quedó cargada no hay nada que confirmar");
out = mk();
ok(!api.tokSinStockConfirmado({ ...mk(), message: "no se encontró el producto" }, candOk, 2, itCaja, "caja", "card"),
  "un 'no encontrado' NO se disfraza de sin stock confirmado");
out = mk();
ok(!api.tokSinStockConfirmado({ ...mk(), message: "sin stock pero no se pudo verificar la cantidad" }, candOk, 2, itCaja, "caja", "card"),
  "cuando no se pudo verificar la cantidad no se confirma");

console.log("\n4) El parser marca '1 unidad' explícito (agent.js)");
ok(/_es_unidad_sospechosa/.test(agentSrc), "agent.js define el detector _es_unidad_sospechosa");
ok(/unidadSospechosa/.test(agentSrc), "agent.js propaga el flag unidadSospechosa");
const filas = agentSrc.match(/unidadSospechosa/g) || [];
ok(filas.length >= 3, "el flag aparece en el ítem, en las filas del PDF y en la salida (usos: " + filas.length + ")");

console.log("\n5) La columna U.M. se lee por su ULTIMA letra (PEDIDO ARCOR LA PLATA, _unit_letter)");
const umCode = [extractFunction(agentSrc, "_unit_letter")].join("\n");
const um = new Function(umCode + "\nreturn _unit_letter;")();
// Tokens REALES leidos por Tesseract en esa columna del pedido, con la verdad de
// campo verificada por OCR dirigido de la celda (escala 14) y comparacion de
// pixeles contra las celdas "b" y "d" limpias del mismo pedido. La barra de la
// tabla antecede siempre a la letra real, y a la derecha esta el valor numerico
// pedido, asi que el ULTIMO caracter es el glifo y todo lo anterior es ruido de
// la serif (la barra se lee "l"/"i"/"1"/"a").
ok(um("|b") === "bulto" && um("b") === "bulto", 'la celda "b" (bulto) se lee como bulto');
ok(um("|d") === "display" && um("d") === "display", 'la celda "d" (display) se lee como display, no como unidad');
ok(um("|ad") === "display" && um("ad") === "display",
  '"|ad" (pipe leido como "a" + d) es display, NO unidad: manda la ultima letra');
ok(um("elb") === "bulto" && um("1b") === "bulto", 'xBul pegado al bulto ("elb", "1b") sigue siendo bulto');
ok(um("lb") === "bulto" && um("Ib") === "bulto" && um("Xb") === "bulto",
  'el pipe como "l"/"I"/"X" no rompe el bulto');
ok(um("1lu") === "unidad" && um("lu") === "unidad" && um("u") === "unidad" && um("|u") === "unidad",
  'la U.M. real "u" (CABSHA 2190, "1lu") es unidad, con el xBul o el pipe pegados');
ok(um("display") === "display" && um("bulto") === "bulto" && um("unidad") === "unidad",
  "los nombres completos siguen funcionando");
ok(um("displays") === "display" && um("bultos1") === "bulto",
  "una palabra completa con ruido pegado todavia se reconoce");
// Falla cerrado: el separador de columna que la serif leyo como "a" NO es una
// unidad. Antes un /[bda]/ devolvia esa "a" como si fuera una U (falsa unidad).
ok(um("a") === null && um("la") === null && um("|a") === null && um("|la") === null,
  'el ruido "a"/"la" de la barra NO se convierte mas en unidad');
ok(!/\/\[bda\]\/\.(exec|test|match)/.test(umCode),
  "el fallback /[bda]/ (que solo podia devolver la 'a' del separador) ya no se ejecuta");
ok(um("") === null && um(null) === null && um("0") === null && um("36|") === null,
  "una celda sin letra no inventa unidad");

console.log("\n6) El re-OCR de banda no pisa la unidad que ya leyo el global (agent.js)");
ok(/if \(f\.unidad && !it\.unidad\)/.test(agentSrc),
  "el fix de banda solo RELLENA una unidad ausente, no sobreescribe la del parse global");
ok(/const last = s\.slice\(-1\)/.test(umCode), "el fix se decide por el ultimo caracter");
ok(!/unit: "[abd]"|categoria: medida_categoria\("[abd]"\)/.test(agentSrc),
  "nadie mas consume la unidad como letra suelta: se emite la palabra entera");
ok(/unidad: unit \|\| ""/.test(agentSrc) && /categoria: medida_categoria\(unit\)/.test(agentSrc),
  "el item del parser sigue categorizando con medida_categoria(unidad)");

console.log(bad ? "\nFALLAS: " + bad : "\nOK: reglas de unidad, conversión y sin stock correctas");
process.exit(bad ? 1 : 0);
