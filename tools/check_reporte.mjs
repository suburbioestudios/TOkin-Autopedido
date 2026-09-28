// Verifica el reporte final ejecutando el descargarExcel REAL de popup.js
// (extraído del archivo, no reimplementado) contra un escenario que mezcla:
//   - dos lotes del pedido (1..19, 20..23),
//   - una línea sin stock que quedó para revisión manual,
//   - una línea sin match de código (no se puede cargar sola),
//   - una línea corregida a mano que SÍ terminó cargada (tanda A1).
// Comprueba que las 5 hojas existan, que cada fila tenga autantas celdas como
// encabezados, y que la línea corregida haya SALIDO de las hojas de pendientes
// y esté en la de ajustes manuales.
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
const code = ["isCargada", "estadoDe", "estadoCounts", "resultadosConAjuste", "descargarExcel"]
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

// 7) sin stock -> revision manual
Object.assign(res[6], {
  ok: false, added: 0, cantCargada: 0, usedUnit: "unidad", convFactor: 12,
  message: "revisión manual: el store no registró 2 caja (2 caja), quedó 0 caja en el carrito",
  sugUnit: "unidad", sugQty: 24, sugTotal: 48, manual: true,
});
// 12) corregida a mano en la tanda A1: ahora SI quedo cargada
Object.assign(res[11], {
  message: "agregado 24 unidad al carrito", ok: true, usedUnit: "unidad",
  added: 24, cantCargada: 24, manualRound: 1, grupo: "A1", sugUnit: "", sugQty: 0, sugTotal: 0,
});
// 23) sin match de codigo: no hay como cargarla sola
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
    prodAdded: 21,
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
ok(hojas.length === 5, "son 5 hojas");
ok(["Reporte General", "Faltantes y Observados", "Requiere revisión manual", "Ajustes manuales", "Carrito antes de Revisar"]
  .every((n) => !!porNombre(n)), "están las 5 hojas con los nombres acordados");

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

// Cantidad cargada combinada con la unidad.
const f12 = lineasGen.find((r) => r[0] === 12);
ok(f12 && f12[7] === "24 unidad", 'la línea corregida muestra "24 unidad" en Cant. cargada');
ok(f12 && /AJUSTES MANUALES A1/.test(String(f12[6])), "la línea corregida dice que se cargó en AJUSTES MANUALES A1");
const f7 = lineasGen.find((r) => r[0] === 7);
ok(f7 && f7[7] === "0 caja", 'la línea sin stock muestra "0 caja" (cantidad y unidad en la misma celda)');
const f1 = lineasGen.find((r) => r[0] === 1);
ok(f1 && f1[7] === "2 caja", 'la línea cargada muestra "2 caja" en Cant. cargada');

// La corregida NO puede figurar como pendiente/faltante.
const pend = porNombre("Faltantes y Observados");
const nrosPend = filasDeDatos(pend).filter((r) => !/^LOTE |^AJUSTES /.test(String(r[0]))).map((r) => r[0]);
ok(!nrosPend.includes(12), "la línea corregida a mano SALIÓ de Faltantes y Observados");
ok(nrosPend.includes(7), "la línea sin stock sigue en Faltantes y Observados");
ok(nrosPend.includes(23), "la línea sin match de código sigue en Faltantes y Observados");
ok(pend.aoa[1][7] === "Cant. cargada", 'Faltantes usa "Cant. cargada" (ya no "Unidad Usada")');

const man = porNombre("Requiere revisión manual");
const nrosMan = filasDeDatos(man).filter((r) => !/^LOTE |^AJUSTES /.test(String(r[0]))).map((r) => r[0]);
ok(!nrosMan.includes(12), "la línea corregida a mano SALIÓ de Requiere revisión manual");
ok(nrosMan.includes(7), "la sin stock queda en Requiere revisión manual (coincide con la pantalla)");
ok(nrosMan.includes(23), "la sin match de código también queda en Requiere revisión manual");

const aj = porNombre("Ajustes manuales");
const filasAj = filasDeDatos(aj).filter((r) => r[0] !== "(no hubo correcciones manuales en esta carga)");
ok(filasAj.length === 1 && filasAj[0][0] === 12, "Ajustes manuales documenta la línea corregida");
ok(filasAj[0] && /AJUSTES MANUALES A1/.test(String(filasAj[0][5])), "la corrección indica la tanda A1");
ok(filasAj[0] && filasAj[0][7] === "CARGADO", "la corrección queda con estado final CARGADO");
ok(filasAj[0] && filasAj[0][6] === "24 unidad", "la corrección muestra la cantidad realmente cargada");

const foto = porNombre("Carrito antes de Revisar");
const filasFoto = filasDeDatos(foto);
ok(filasFoto.length === 3, "la foto del carrito trae una fila por grupo (3)");
ok(filasFoto.some((r) => /ARC-10001/.test(String(r[7]))), "el grupo 1 muestra el carrito que había");
ok(filasFoto.some((r) => /no verificable/i.test(String(r[7]))), "el grupo 2 sin foto queda como NO VERIFICABLE (no se inventa)");
ok(filasFoto.some((r) => /ARC-10012/.test(String(r[7])) && /24 unidad/.test(String(r[7]))), "el grupo A1 muestra la corrección cargada");
ok(filasFoto.some((r) => /SÍ/.test(String(r[6]))), "un grupo quedó con compra confirmada");

ok(/Pendientes: 2/.test(String(gen.aoa[0][0])), "el encabezado informa las 2 líneas pendientes");
ok(/Resueltas con ajuste manual: 1/.test(String(gen.aoa[0][0])), "el encabezado informa la resuelta con ajuste manual");
ok(status && status.indexOf("ok") === 0, "descargarExcel terminó sin error: " + status);

console.log(bad ? "\nFALLAS: " + bad : "\nOK: reporte final correcto");
process.exit(bad ? 1 : 0);
