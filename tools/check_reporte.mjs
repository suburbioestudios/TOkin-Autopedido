// Verifica el reporte final ejecutando el descargarExcel REAL de popup.js
// (extraído del archivo, no reimplementado) contra un escenario que mezcla:
//   - dos lotes del pedido (1..19, 20..23),
//   - una línea SIN STOCK CONFIRMADO (match entero: código+nombre+gramaje+
//     conversión) → entra al reporte y NO se reabre para ajuste,
//   - una línea corregida a mano que SÍ terminó cargada (tanda A1),
//   - una línea corregida a mano que aun así quedó sin stock → resultado
//     DEFINITIVO, sin segunda ronda de ajuste,
//   - una línea sin match de código (no se puede cargar sola).
// v2.0.84: el Excel pasó de 5 hojas a 2 (Reporte General · Faltantes y
// Observados), las dos ordenadas por bloques con los ajustes manuales al final,
// y el estado de cada línea sale de esSinStockConfirmado/esAjusteDefinitivo/
// esPendienteDeAjuste.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const popupPath = path.join(root, "extension", "popup", "popup.js");
const src = fs.readFileSync(popupPath, "utf8");

// --- Extracción de código real -------------------------------------------
// Escáner que salta strings, comentarios y regex para recién ahí contar llaves.
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
    if (ch === "/") {
      // regex si lo anterior es un inicio de expresión o un operador
      if ("([{,;:=!&|?+-*%<>~^".includes(prev)) {
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
    }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return src.slice(start, i + 1); }
    if (!/\s/.test(ch)) prev = ch;
  }
  throw new Error("no pude cerrar la funcion " + name);
}

const GROUP = Number((src.match(/const\s+GROUP\s*=\s*(\d+)/) || [])[1] || 19);
// v2.0.84: "resultadosConAjuste" ya no existe (era la hoja "Ajustes manuales").
// Ahora el Excel es de 2 hojas y el estado de cada línea sale de los tres
// predicados nuevos: sin stock confirmado, ajuste definitivo y pendiente de
// ajuste.
const code = ["isCargada", "esSinStockConfirmado", "esAjusteDefinitivo", "esPendienteDeAjuste",
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
const chrome = { storage: { local: { get: (_k, cb) => cb({}) } } };
let status = null;

// --- Escenario -------------------------------------------------------------
const items = [];
for (let n = 1; n <= 23; n++) {
  items.push({ nro: n, sku: String(10000 + n), producto: "PRODUCTO " + n, cantidad: "2", categoria: "caja" });
}
items[6].sku = "11777";
items[6].producto = "GASEOSA 2,25 LT CAJA x12";
items[22].sku = "";
items[22].producto = "SIN CODIGO CAFE";

const res = items.map((it) => ({
  producto: it.producto, ok: true, nro: it.nro, sku: it.sku,
  cantidad: it.cantidad, unidad: it.categoria, usedUnit: it.categoria,
  added: 2, cantCargada: 2, message: "agregado 2 caja al carrito",
  storeName: it.producto, storeText: "ARC-" + it.sku,
  grupo: it.nro <= GROUP ? "1" : "2",
}));

// 7) SIN STOCK CONFIRMADO: el store lo verifico por codigo+nombre+gramaje y no
// lo tiene. Es un hecho, entra al reporte y NO se reabre para ajuste manual.
Object.assign(res[6], {
  ok: false, added: 0, cantCargada: 0, usedUnit: "unidad", convFactor: 12, confirmado: true,
  message: "encontrado pero sin stock (11777)",
  sugUnit: "unidad", sugQty: 24, sugTotal: 48,
});
// 12) corregida a mano en la tanda A1: ahora SI quedo cargada
Object.assign(res[11], {
  message: "agregado 24 unidad al carrito", ok: true, usedUnit: "unidad",
  added: 24, cantCargada: 24, manualRound: 1, grupo: "A1", sugUnit: "", sugQty: 0, sugTotal: 0,
});
// 19) corregida a mano en la tanda A1 y aun asi quedo sin stock: resultado
// DEFINITIVO. No hay segunda ronda de ajuste para esta linea.
Object.assign(res[18], {
  message: "sin stock: el store tomo menos de lo pedido (2 caja = 24 unidad), quedo 0 caja",
  ok: false, added: 0, cantCargada: 0, usedUnit: "caja", convFactor: 12, manualRound: 1,
  grupo: "A1", manual: true, sugUnit: "unidad", sugQty: 24, sugTotal: 48,
});
// 23) sin match de codigo: no hay como cargarla sola -> sigue ajustable a mano
Object.assign(res[22], {
  ok: false, added: 0, cantCargada: 0, usedUnit: "",
  message: "no se encontró el producto en el store", storeName: "", storeText: "", grupo: "2",
});

const grupos = {
  "1": {
    grupo: "1", manual: false, fecha: "2026-09-28T14:05:03.000Z", checkouts: 1, confirmado: true,
    lineas: [], totalLineas: 19, cargadas: 18, productosEnCarrito: 18, verificado: true,
    foto: [{ code: "10001", nombre: "PRODUCTO 1", qty: 2, unidad: "caja" }],
  },
  "2": {
    grupo: "2", manual: false, fecha: "2026-09-28T14:12:40.000Z", checkouts: 1, confirmado: false,
    lineas: [], totalLineas: 4, cargadas: 2, productosEnCarrito: 2, verificado: false, foto: [],
  },
  A1: {
    grupo: "A1", manual: true, fecha: "2026-09-28T14:20:11.000Z", checkouts: 1, confirmado: true,
    lineas: [], totalLineas: 1, cargadas: 1, productosEnCarrito: 1, verificado: true,
    foto: [{ code: "10012", nombre: "PRODUCTO 12", qty: 24, unidad: "unidad" }],
  },
};

const ui = {
  cart: {
    results: res,
    allLineItems: items,
    docName: "PEDIDO PRUEBA 28.09",
    prodAdded: 20,
    totalProducts: 23,
  },
  lineItems: items,
  manualEdits: {},
  sessionState: { lotChecks: { 1: true, 2: false, A1: true }, grupos },
};

const fn = new Function("ui", "chrome", "XLSX", "setStatus", "GROUP", code + "\nreturn descargarExcel();");
await fn(ui, chrome, XLSX, (m, k) => { status = k + ": " + m; }, GROUP);

// --- Aserciones ------------------------------------------------------------
let bad = 0;
const ok = (cond, msg) => { if (!cond) { bad++; console.log("  FALLA " + msg); } else console.log("  ok    " + msg); };
const porNombre = (n) => hojas.find((h) => h.nombre === n);
const filasDeDatos = (h) => h.aoa.slice(2).filter((r) => r && r.length > 1);
const sep = (h) => filasDeDatos(h).filter((r) => /^LOTE |^AJUSTES MANUALES /.test(String(r[0])));

console.log("\nHojas generadas: " + hojas.map((h) => h.nombre).join(" | "));
ok(hojas.length === 2, "son 2 hojas (v2.0.84: el informe ya no se parte en 5)");
ok(["Reporte General", "Faltantes y Observados"].every((n) => !!porNombre(n)), "están las 2 hojas con los nombres acordados");
ok(hojas.map((h) => h.nombre).join("|") === "Reporte General|Faltantes y Observados", "las hojas van en ese orden y no hay ninguna más");

// Alineacion celdas / encabezados en todas las hojas.
for (const h of hojas) {
  const cab = h.aoa[1].length;
  const malas = filasDeDatos(h).filter((r) => r.length !== cab);
  ok(malas.length === 0, `"${h.nombre}": ${cab} columnas, ${filasDeDatos(h).length} filas de datos, 0 desalineadas` +
    (malas.length ? " -> " + malas.map((r) => r.length).join(",") : ""));
}

const gen = porNombre("Reporte General");
const cabGen = gen.aoa[1];
const lineasGen = filasDeDatos(gen).filter((r) => !/^LOTE |^AJUSTES MANUALES /.test(String(r[0])));
ok(cabGen.includes("Cargó en"), 'Reporte General tiene la columna "Cargó en"');
ok(cabGen.includes("Cant. cargada"), 'Reporte General tiene la columna "Cant. cargada"');
ok(lineasGen.length === 23, "Reporte General trae las 23 líneas del pedido (más los separadores de grupo)");
ok(sep(gen).length === 3, "Reporte General separa 3 grupos: LOTE 1, LOTE 2 y AJUSTES MANUALES A1");
ok(sep(gen).some((r) => /LOTE 1/.test(r[0]) && /PEDIDO REALIZADO/.test(r[8])), "LOTE 1 marcado PEDIDO REALIZADO");
ok(sep(gen).some((r) => /LOTE 2/.test(r[0]) && /SIN CONFIRMAR/.test(r[8])), "LOTE 2 marcado SIN CONFIRMAR (honesto)");
ok(sep(gen).some((r) => /AJUSTES MANUALES A1/.test(r[0]) && /PEDIDO REALIZADO/.test(r[8])), "Ajustes manuales A1 marcado PEDIDO REALIZADO");
// v2.0.84: la foto del carrito no es una hoja, pero su estado sigue en el
// separador del bloque, para no perder la evidencia.
ok(sep(gen).some((r) => /LOTE 1/.test(r[0]) && /foto del carrito: 1 producto/.test(r[8])), "el separador del LOTE 1 dice cuántas fotos del carrito hay");
ok(sep(gen).some((r) => /LOTE 2/.test(r[0]) && /carrito NO verificable/.test(r[8])), "el LOTE 2 sin foto queda como NO verificable (no se inventa)");
ok(sep(gen).some((r) => /AJUSTES MANUALES A1/.test(r[0]) && /tanda de ajustes manuales/.test(r[8])), "el bloque de ajustes manuales se identifica como tal");

// Cantidad cargada combinada con la unidad.
const f12 = lineasGen.find((r) => r[0] === 12);
ok(f12 && f12[7] === "24 unidad", 'la línea corregida muestra "24 unidad" en Cant. cargada');
ok(f12 && /AJUSTES MANUALES A1/.test(String(f12[6])), "la línea corregida dice que se cargó en AJUSTES MANUALES A1");
const f7 = lineasGen.find((r) => r[0] === 7);
ok(f7 && f7[7] === "0 caja", 'la línea sin stock muestra "0 caja" (cantidad y unidad en la misma celda)');
ok(f7 && /SIN STOCK CONFIRMADO/.test(String(f7[5])), "la línea sin stock verificada figura como SIN STOCK CONFIRMADO");
const f19 = lineasGen.find((r) => r[0] === 19);
ok(f19 && /DEFINITIVO/.test(String(f19[5])), "la línea corregida a mano que quedó sin stock figura como DEFINITIVA");
const f1 = lineasGen.find((r) => r[0] === 1);
ok(f1 && f1[7] === "2 caja", 'la línea cargada muestra "2 caja" en Cant. cargada');

// El orden de las hojas es por BLOQUE (lotes 1..N y los ajustes manuales al
// final), igual que antes, y la hoja de observados usa el mismo criterio.
const ordenSep = sep(gen).map((r) => String(r[0]));
ok(/^LOTE 1$/.test(ordenSep[0]) && /^LOTE 2$/.test(ordenSep[1]) && /^AJUSTES MANUALES A1$/.test(ordenSep[2]),
  "los bloques van en orden real de compra: LOTE 1, LOTE 2, A1 al final");

// Faltantes y Observados: todo lo que no quedó cargado, incluidos los sin stock
// confirmados y las líneas con resultado definitivo tras el ajuste.
const pend = porNombre("Faltantes y Observados");
ok(pend.aoa[1].includes("Cargó en"), 'Faltantes y Observados tiene la columna "Cargó en"');
ok(pend.aoa[1].includes("Cant. cargada"), 'Faltantes usa "Cant. cargada" (ya no "Unidad Usada")');
const nrosPend = filasDeDatos(pend).filter((r) => !/^LOTE |^AJUSTES /.test(String(r[0]))).map((r) => r[0]);
ok(!nrosPend.includes(12), "la línea corregida a mano y CARGADA salió de Faltantes y Observados");
ok(nrosPend.includes(7), "el sin stock confirmado está en Faltantes y Observados (es una observación, no un pendiente)");
ok(nrosPend.includes(19), "la línea corregida a mano que siguió sin stock está en Faltantes y Observados");
ok(nrosPend.includes(23), "la línea sin match de código sigue en Faltantes y Observados");
ok(nrosPend.length === 3, "Faltantes y Observados trae las 3 líneas que no quedaron cargadas");
const ordenPend = sep(pend).map((r) => String(r[0]));
ok(/^LOTE 1$/.test(ordenPend[0]) && /^LOTE 2$/.test(ordenPend[1]) && /^AJUSTES MANUALES A1$/.test(ordenPend[2]),
  "Faltantes y Observados también está ordenado por bloques, con los ajustes manuales al final");
const p7 = filasDeDatos(pend).find((r) => r[0] === 7);
ok(p7 && /^LOTE 1$/.test(String(p7[6])), "el sin stock confirmado queda bajo el bloque del lote que lo pidió (no bajo A1)");
ok(p7 && /SIN STOCK CONFIRMADO/.test(String(p7[5])), "el sin stock confirmado se distingue de lo ajustable");
ok(p7 && /CONFIRMADO/.test(String(p7[9])), "el diagnóstico del sin stock confirmado explica por qué no se ajusta");
const p19 = filasDeDatos(pend).find((r) => r[0] === 19);
ok(p19 && /DEFINITIVO/.test(String(p19[5])), "la línea con resultado definitivo se marca como tal");
ok(p19 && /no hay segunda ronda/i.test(String(p19[9])), "el diagnóstico aclara que no hay segunda ronda de ajuste");
ok(p19 && /AJUSTES MANUALES A1/.test(String(p19[6])), "la línea definitiva conserva el bloque donde se corrigió");
ok(p7 && /24 unidad/.test(String(p7[9])), "el sin stock confirmado deja la carga manual sugerida a la vista");

// Encabezado: los tres números que el cliente necesita, con la ronda única.
ok(/Pendientes: 3/.test(String(gen.aoa[0][0])), "el encabezado informa las 3 líneas que no quedaron cargadas");
ok(/Sin stock: 2 \(confirmados: 1\)/.test(String(gen.aoa[0][0])), "el encabezado separa el sin stock confirmado del que no se pudo verificar");
ok(/Definitivos tras ajuste manual: 1/.test(String(gen.aoa[0][0])), "el encabezado informa el resultado definitivo del ajuste manual");
ok(/Ajustables a mano: 1/.test(String(gen.aoa[0][0])), "el encabezado dice que queda 1 línea ajustable (solo la que no tiene match)");
ok(/Ajustables a mano: 0/.test(String(gen.aoa[0][0])) === false, "no se anuncia una segunda ronda de ajuste");
ok(status && status.indexOf("ok") === 0, "descargarExcel terminó sin error: " + status);
ok(/2 hojas/.test(status), "el popup confirma que el Excel sale con 2 hojas");

console.log(bad ? "\nFALLAS: " + bad : "\nOK: reporte final correcto");
process.exit(bad ? 1 : 0);
