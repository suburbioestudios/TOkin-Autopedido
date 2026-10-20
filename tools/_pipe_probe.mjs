// Harness interno: corre el PARSER REAL de la extension (agent.js) sobre el
// dump OCR ya capturado (escala 4.5, la misma que usa OCR_SCALE) y muestra que
// item produce cada renglon del pedido. Sin navegador, sin render.
import fs from "node:fs";
import path from "node:path";
import { leerFuentes, cargarFunciones } from "./_extract.mjs";
import { medida_categoria, match_concept } from "../extension/core/normalize.js";

const ROOT = path.resolve(process.cwd());
const { agent, normalize } = leerFuentes(ROOT);

const factory = cargarFunciones({
  agent,
  normalize,
  constantes: ["_OCR_FIX"],
  funciones: ["_first_digits", "_es_unidad_sospechosa", "_unit_letter", "_ocr_fix", "_pdf_build_rows", "_pdf_row_info", "_pdf_table_items", "_pdf_all_rows"],
});
const M = factory(medida_categoria, match_concept, { log() {} });

const dump = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "ocr-dump.json"), "utf8"));

const ESCALA = 4.5;
const solo = process.argv[2] ? process.argv[2].split(",") : null;

let todos = [];
for (const pg of dump.paginas) {
  if (!pg.words.length) continue;
  const words = pg.words.map((w) => ({ t: w.t, x0: w.x0, y0: w.y0, x1: w.x1, y1: w.y1 }));
  const items = M._pdf_table_items(words, pg.w, ESCALA);
  for (const it of items) todos.push({ pag: pg.n, ...it });
}

console.log("items totales del pedido: " + todos.length + "\n");
const cuenta = {};
for (const it of todos) {
  const k = it.categoria || "(vacia)";
  (cuenta[k] = cuenta[k] || []).push(it);
}
console.log("=== categorias que devuelve el parser real ===");
for (const k of Object.keys(cuenta).sort()) {
  console.log(k.padEnd(12) + cuenta[k].length + " productos" + (k === "unidad" ? "   <<<<" : ""));
}
console.log("");

const foco = solo || ["13331", "2190", "6934"];
console.log("=== renglones pedidos ===");
for (const it of todos.filter((i) => foco.includes(i.sku))) {
  console.log("  " + it.sku + "  cat=" + (it.categoria || "-") + "  um=" + JSON.stringify(it.unidad) + "  cant=" + JSON.stringify(it.cantidad) + "  sospechosa=" + it.unidadSospechosa + "  | " + it.producto.slice(0, 44));
}
console.log("\n=== todos los que salen como 'unidad' ===");
for (const it of todos.filter((i) => i.categoria === "unidad")) {
  console.log("  p" + it.pag + " " + it.sku + "  cat=" + it.categoria + "  um=" + JSON.stringify(it.unidad) + "  cant=" + JSON.stringify(it.cantidad) + "  sospechosa=" + it.unidadSospechosa + "  | " + it.producto.slice(0, 40));
}
console.log("\n=== distribucion de unidad leida ===");
const dist = {};
for (const it of todos) { const k = JSON.stringify(it.unidad); (dist[k] = dist[k] || []).push(it.sku); }
for (const k of Object.keys(dist).sort()) {
  console.log("  um=" + k.padEnd(7) + " -> " + String(dist[k].length).padEnd(5) + (k.includes("a") ? "  <<< UNIDAD" : ""));
  if (k.includes("a")) console.log("       " + dist[k].join(", "));
}
console.log("\n=== items sin unidad (posible basura) ===");
for (const it of todos.filter((i) => !i.categoria)) {
  console.log("  p" + it.pag + " " + it.sku + " cant=" + JSON.stringify(it.cantidad) + " | " + it.producto.slice(0, 50));
}
