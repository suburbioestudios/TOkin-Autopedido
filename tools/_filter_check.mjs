// Aplica el filtro real de agent.js:1223 (it.cantidad || it.unidad) sobre los
// items parseados del PDF, para comprobar si las filas fantasma del membrete
// llegan a doc.line_items / doc.tables.
import fs from "node:fs";
import path from "node:path";
import { leerFuentes, cargarFunciones } from "./_extract.mjs";
import { medida_categoria, match_concept } from "../extension/core/normalize.js";

const ROOT = path.resolve(process.cwd());
const { agent, normalize } = leerFuentes(ROOT);
const M = cargarFunciones({
  agent, normalize, constantes: ["_OCR_FIX"],
  funciones: ["_first_digits", "_es_unidad_sospechosa", "_unit_letter", "_ocr_fix", "_pdf_build_rows", "_pdf_row_info", "_pdf_table_items"],
})(medida_categoria, match_concept, { log() {} });

const dump = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "ocr-dump.json"), "utf8"));
let crudos = 0, trasFiltro = 0;
const fantasma = [];
const trasFiltroLista = [];
const porPag = [];

for (const pg of dump.paginas) {
  if (!pg.words.length) continue;
  const items = M._pdf_table_items(pg.words, pg.w, 4.5);
  crudos += items.length;
  // agent.js:1223
  const items2 = items.filter((it) => it.cantidad || it.unidad);
  trasFiltro += items2.length;
  for (const it of items2) trasFiltroLista.push("p" + pg.n + " " + it.sku + " | " + it.producto);
  porPag.push("  pagina " + pg.n + ": " + items.length + " crudos -> " + items2.length + " filas de pedido");
  for (const it of items) {
    if (!it.cantidad && !it.unidad) fantasma.push("p" + pg.n + " " + it.sku + " | " + it.producto);
  }
}

console.log("items crudos:            " + crudos);
console.log("items tras el filtro:    " + trasFiltro);
console.log("fantasma descartadas:    " + fantasma.length);
console.log("\n" + porPag.join("\n"));
console.log("\ndescartadas por el filtro:");
for (const f of fantasma) console.log("  " + f);
const sobreviven = trasFiltroLista.filter((f) => /MATADEROS|CABA/.test(f));
console.log("\n" + (sobreviven.length === 0
  ? "OK: ninguna fila del membrete llega a line_items ni a tables."
  : "FALLA: " + sobreviven.length + " filas fantasma sobreviven: " + sobreviven.join(" | ")));
