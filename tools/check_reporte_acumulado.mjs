// v2.0.91 — Regresión del incidente CUENCA 29 SEP: tras un F5 el popup perdía
// los primeros lotes y el Excel salía SOLO con el último bloque.
//
// Cubre las tres piezas del fix:
//   1) popup: descargarExcel() prefiere el reporte ACUMULADO persistido
//      (allResults/allLineItems) cuando el estado vivo quedó corto o vacío.
//   2) content.js: persiste allResults/allLineItems fusionados por batchIdx y
//      conserva grupos/lotChecks (antes los pisaba en cada bloque).
//   3) recuperación: resumeCart recierra un job phase="done" y restoreSession
//      del offscreen no borra la sesión si el reporte del bloque coincide.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const popupPath = path.join(root, "extension", "popup", "popup.js");
const contentPath = path.join(root, "extension", "content.js");
const offscreenPath = path.join(root, "extension", "offscreen", "offscreen.js");
const src = fs.readFileSync(popupPath, "utf8");
const contentSrc = fs.readFileSync(contentPath, "utf8");
const offscreenSrc = fs.readFileSync(offscreenPath, "utf8");

function extractFunction(name) {
  const start = src.search(new RegExp("(async\\s+)?function\\s+" + name + "\\s*\\("));
  if (start < 0) throw new Error("no encontre la funcion " + name);
  let i = src.indexOf("{", start), depth = 0, prev = "";
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch; i++;
      while (i < src.length) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === q) break;
        i++;
      }
      prev = q; continue;
    }
    if (ch === "/" && src[i + 1] === "/") { while (i < src.length && src[i] !== "\n") i++; continue; }
    if (ch === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 1; continue; }
    if (ch === "/" && "([{,;:=!&|?+-*%<>~^".includes(prev)) {
      i++; let inClass = false;
      while (i < src.length) {
        if (src[i] === "\\") { i++; continue; }
        if (src[i] === "[") inClass = true;
        else if (src[i] === "]") inClass = false;
        else if (src[i] === "/" && !inClass) break;
        i++;
      }
      prev = "/"; continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
    if (!/\s/.test(ch)) prev = ch;
  }
  throw new Error("no pude cerrar la funcion " + name);
}

const GROUP = Number((src.match(/const\s+GROUP\s*=\s*(\d+)/) || [])[1] || 19);
const code = ["isCargada", "esSinStockConfirmado", "esSinStock", "esAjusteDefinitivo", "esPendienteDeAjuste",
  "estadoBase", "estadoDe", "estadoCounts", "descargarExcel"]
  .map(extractFunction).join("\n\n");

// --- Stubs -----------------------------------------------------------------
const hojas = [];
const XLSX = {
  utils: {
    book_new: () => ({}),
    aoa_to_sheet: (aoa) => ({ "!aoa": aoa }),
    book_append_sheet: (wb, ws, nombre) => hojas.push({ nombre, aoa: ws["!aoa"] }),
  },
  writeFile: () => {},
};

// --- Escenario: 23 líneas, lote 1 (1..19) y lote 2 (20..23) ---
const items = [];
for (let n = 1; n <= 23; n++) {
  items.push({ nro: n, sku: String(10000 + n), producto: "PRODUCTO " + n, cantidad: "2", categoria: "caja" });
}
const res = items.map((it) => ({
  producto: it.producto, ok: true, nro: it.nro, sku: it.sku,
  cantidad: it.cantidad, unidad: it.categoria, usedUnit: it.categoria,
  added: 2, cantCargada: 2, message: "agregado 2 caja al carrito",
  storeName: it.producto, storeText: "ARC-" + it.sku,
  grupo: it.nro <= GROUP ? "1" : "2",
}));

const grupos = {
  "1": { grupo: "1", manual: false, fecha: "2026-09-29T11:05:00.000Z", checkouts: 1, confirmado: true, lineas: [], totalLineas: 19, cargadas: 19, productosEnCarrito: 19, verificado: true, foto: [{ code: "10001", nombre: "PRODUCTO 1", qty: 2, unidad: "caja" }] },
  "2": { grupo: "2", manual: false, fecha: "2026-09-29T11:14:00.000Z", checkouts: 1, confirmado: true, lineas: [], totalLineas: 4, cargadas: 4, productosEnCarrito: 4, verificado: false, foto: [] },
};

// Reporte ACUMULADO tal como lo deja el content script v2.0.91:
//  - allResults/allLineItems indexados por línea original (1..23)
//  - results/batchIdx del ÚLTIMO bloque (block-indexed, para tryRecoverReport)
const saved = {
  savedAt: Date.now(),
  docName: "PEDIDO ARCOR CUENCA 29 SEP",
  orderTotal: 23,
  totalProducts: 23,
  prodAdded: 23,
  allResults: res.slice(),
  allLineItems: items.slice(),
  results: res.slice(GROUP),               // solo lote 2 (20..23)
  batchIdx: [19, 20, 21, 22],
  grupos,
  lotChecks: { 1: true, 2: true },
};

// Estado vivo DESPUÉS del F5: la sesión del offscreen quedó vacía.
const ui = { cart: { results: [] }, lineItems: [], manualEdits: {}, sessionState: null };

const chrome = { storage: { local: { get: (_k, cb) => cb({ tokinCartReport: saved }) } } };
let status = null;

const fn = new Function("ui", "chrome", "XLSX", "setStatus", "GROUP", code + "\nreturn descargarExcel();");
await fn(ui, chrome, XLSX, (m, k) => { status = k + ": " + m; }, GROUP);

// --- Aserciones ------------------------------------------------------------
let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log("  FALLA " + msg); } else console.log("  ok    " + msg); };
const porNombre = (n) => hojas.find((h) => h.nombre === n);
const filasDeDatos = (h) => h.aoa.slice(2).filter((r) => r && r.length > 1);
const sep = (h) => filasDeDatos(h).filter((r) => /^LOTE |^AJUSTES MANUALES /.test(String(r[0])));

console.log("\n[1] El popup recupera el pedido COMPLETO desde el reporte acumulado");
const gen = porNombre("Reporte General");
ok(!!gen, "se generó la hoja Reporte General");
const lineasGen = filasDeDatos(gen).filter((r) => !/^LOTE |^AJUSTES MANUALES /.test(String(r[0])));
ok(lineasGen.length === 23, "el Excel trae las 23 líneas (antes: solo el último lote de 4) — obtenidas " + lineasGen.length);
const nros = lineasGen.map((r) => Number(r[0]));
ok(nros.includes(1) && nros.includes(19) && nros.includes(20) && nros.includes(23),
  "están el lote 1 (1..19) y el lote 2 (20..23), no solo el último");
ok(sep(gen).length === 2, "se separan LOTE 1 y LOTE 2 (2 grupos)");
ok(sep(gen).some((r) => /LOTE 1/.test(r[0]) && /PEDIDO REALIZADO/.test(r[8])), "LOTE 1 recuperó su estado PEDIDO REALIZADO");
ok(sep(gen).some((r) => /LOTE 2/.test(r[0]) && /PEDIDO REALIZADO/.test(r[8])), "LOTE 2 recuperó su estado PEDIDO REALIZADO");
ok(/Pedido cargado: 23 de 23/.test(String(gen.aoa[0][0])), "el encabezado cuenta 23 de 23 (no mezcla contadores de bloque)");
ok(/Pendientes: 0/.test(String(gen.aoa[0][0])), "no quedan pendientes: el pedido está completo");

console.log("\n[2] content.js persiste el reporte acumulado y conserva grupos/lotChecks");
ok(/allResults:\s*allRes/.test(contentSrc), "content.js escribe allResults (acumulado por línea original)");
ok(/allResults:\s*allItems/.test(contentSrc) === false, "no confunde allResults con allLineItems");
ok(/allLineItems:\s*allItems/.test(contentSrc), "content.js escribe allLineItems (pedido entero)");
ok(/merged\.grupos\s*=\s*prev\.grupos/.test(contentSrc), "conserva los grupos confirmados del reporte previo");
ok(/merged\.lotChecks\s*=\s*prev\.lotChecks/.test(contentSrc), "conserva los lotChecks del reporte previo");
ok(/job\.phase === "done"[\s\S]{0,220}return tokFinishCart\(job\)/.test(contentSrc),
  "resumeCart recierra un job phase=done (reenvía el CART_DONE perdido)");
ok(/recién AHORA que el bloque quedó persistido[\s\S]{0,400}tokStoreRemove\(CART_JOB_KEY\)/.test(contentSrc),
  "el job se libera DESPUÉS de mandar el CART_DONE (ventana recuperable)");

console.log("\n[3] offscreen: no borra la sesión si el bloque puede recuperarse");
ok(/contentDone/.test(offscreenSrc), "restoreSession contempla job phase=done");
ok(/repMatches/.test(offscreenSrc), "restoreSession contempla el reporte persistido que matchea el batchIdx");
ok(/liveJob \|\| contentDone \|\| repMatches/.test(offscreenSrc), "solo borra la sesión cuando NO hay nada que recuperar");

console.log("\n[4] popup: el respaldo prioriza la fuente con más líneas resueltas");
ok(/resolvedCount/.test(src), "descargarExcel compara cuántas líneas resueltas tiene cada fuente");
ok(/saved\.allResults/.test(src), "descargarExcel usa saved.allResults (acumulado)");
ok(/savedItems\.filter\(Boolean\)\.length/.test(src), "prefiere el allLineItems más completo");
ok(status && status.indexOf("ok") === 0, "descargarExcel terminó sin error: " + status);

console.log(bad ? "\nFALLAS: " + bad : "\nOK: reporte acumulado correcto");
process.exit(bad ? 1 : 0);
