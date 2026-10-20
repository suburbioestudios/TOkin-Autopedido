// Por qué aparecen "1440 MATADEROS" / "2048 MATADEROS" como productos: compara
// esos renglones del membrete contra un renglón real y contra el caso "ama3"
// (código degradado) que motivó el fallback de sku provisional.
import fs from "node:fs";
import path from "node:path";
import { leerFuentes, cargarFunciones } from "./_extract.mjs";
import { medida_categoria, match_concept } from "../extension/core/normalize.js";

const ROOT = path.resolve(process.cwd());
const { agent, normalize } = leerFuentes(ROOT);
const M = cargarFunciones({
  agent, normalize, constantes: ["_OCR_FIX"],
  funciones: ["_first_digits", "_es_unidad_sospechosa", "_unit_letter", "_ocr_fix", "_pdf_build_rows", "_pdf_row_info"],
})(medida_categoria, match_concept, { log() {} });

const dump = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "ocr-dump.json"), "utf8"));
const ESC = 4.5;

const filas = [];
for (const pg of dump.paginas) {
  if (!pg.words.length) continue;
  for (const row of M._pdf_build_rows(pg.words, ESC)) {
    const info = M._pdf_row_info(pg.w, row);
    if (!info) continue;
    filas.push({ pag: pg.n, w: pg.w, row, info });
  }
}

const conUnidad = filas.filter((f) => f.info.unidad !== null);
const sinUnidad = filas.filter((f) => f.info.unidad === null);
console.log("renglones con info: " + filas.length + " | con unidad: " + conUnidad.length + " | sin unidad: " + sinUnidad.length + "\n");

// Señales de "fila de tabla": números y palabras a la derecha del código.
const senales = (f) => {
  const { row, w: width, info } = f;
  const sku = row.find((x) => x.t === info.sku);
  if (!sku) return null;
  const iSku = row.indexOf(sku);
  const der = row.slice(iSku + 1);
  const xf = (x) => (x.x0 + x.x1) / 2 / width;
  const numeros = der.filter((x) => /\d/.test(x.t));
  const palabrasDesc = der.filter((x) => /^[A-Za-z]{3,}/.test(x.t) && xf(x) < 0.25);
  const numDerecha = numeros.filter((x) => xf(x) >= 0.25);
  return {
    der: der.length,
    palabras: palabrasDesc.length,
    numDer: numDerecha.length,
    puntos: der.map((x) => x.t + "@" + xf(x).toFixed(2)).join(" "),
  };
};

console.log("=== renglones SIN unidad ===");
for (const f of sinUnidad) {
  const s = senales(f) || { der: 0, palabras: 0, numDer: 0, puntos: "" };
  console.log("p" + f.pag + " sku=" + String(f.info.sku).padEnd(6) + " ped=" + String(f.info.pedida).padEnd(5) + " der=" + String(s.der).padEnd(3) + " pal=" + String(s.palabras).padEnd(3) + " numDer=" + String(s.numDer).padEnd(3) + " | " + s.puntos.slice(0, 62));
}
console.log("\n=== 6 renglones CON unidad (referencia de fila real) ===");
for (const f of conUnidad.slice(0, 6)) {
  const s = senales(f) || { der: 0, palabras: 0, numDer: 0, puntos: "" };
  console.log("p" + f.pag + " sku=" + String(f.info.sku).padEnd(6) + " ped=" + String(f.info.pedida).padEnd(5) + " der=" + String(s.der).padEnd(3) + " pal=" + String(s.palabras).padEnd(3) + " numDer=" + String(s.numDer).padEnd(3) + " | " + s.puntos.slice(0, 62));
}
