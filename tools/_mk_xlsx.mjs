// Arma un XLSX de prueba con bloques de un pedido ARCOR. Los "bloques" son
// lotes de 19 ítems (así los carga la extensión). Se leen los ítems en orden
// del PDF (dump OCR en tools/_ocr_pages.json) y se cortan por bloque.
// Uso: node tools/_mk_xlsx.cjs <out.xlsx> <bloque1> <bloque2> ...
// Requiere haber corrido antes: node tools/_ocr_dump_adrogue.mjs "<pdf>"
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLOQUE = 19;
const args = process.argv.slice(2);
const outName = args[0] || "bloques.xlsx";
const bloquesPedidos = args.slice(1).map(Number).filter(Boolean);
if (!bloquesPedidos.length) {
  console.error("Indicá al menos un número de bloque. Ej: node tools/_mk_xlsx.cjs out.xlsx 2 5");
  process.exit(1);
}

const pages = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "_ocr_pages.json"), "utf8"));

const items = [];
for (const pg of pages) {
  if (!pg.text) continue;
  for (const line of pg.text.split(/\r?\n/)) {
    if (!/^\s*\d{3,6}\s*[\[\|]/.test(line) || !/\d,\d\d\s*\|/.test(line)) continue;
    // El OCR mete separadores "|" o "[" y a veces el nombre arranca con "["
    // pegado al separador ("| [MOGUL..."). Se normaliza "|[", "| [" y "["
    // inicial de descripción a "|" antes de partir, para no romper el nombre.
    const norm = line.replace(/\|\s*\[/g, "|").replace(/\[/g, "|");
    const parts = norm.split(/\|/).map((s) => s.trim());
    const cod = (parts[0] || "").match(/^(\d{3,6})/);
    if (!cod) continue;
    // La celda "xBul" y la de unidad+cantidad pueden venir juntas en un token
    // ("20 ld 1") o separadas ("12" + "a al 0"). La cantidad es el ÚLTIMO
    // número del bloque unidad/cantidad y la unidad la letra b/d/u.
    let cant = 0, unidad = "";
    for (let k = 2; k <= 4; k++) {
      const seg = String(parts[k] || "");
      const letters = seg.toLowerCase().replace(/[^a-z]/g, "");
      const nums = seg.match(/\d+/g);
      const u = /b/.test(letters) ? "b" : /d/.test(letters) ? "d" : /u/.test(letters) ? "u" : "";
      if (u && nums && nums.length) {
        cant = Number(nums[nums.length - 1]);
        unidad = u;
      } else if (!unidad && u) {
        unidad = u;
      } else if (!cant && nums && nums.length) {
        cant = Number(nums[nums.length - 1]);
      }
      if (cant && unidad) break;
    }
    if (!cant) continue;
    items.push({
      CODIGO: cod[1],
      PRODUCTO: (parts[1] || "").trim(),
      XBULTO: Number((String(parts[2] || "").match(/\d+/) || ["0"])[0]),
      UNIDAD: unidad || "b",
      CANTIDAD: cant,
    });
  }
}

console.log("items totales:", items.length, "| bloques:", Math.ceil(items.length / BLOQUE));

const u = (row) => ({ CODIGO: row.CODIGO, PRODUCTO: row.PRODUCTO, CANTIDAD: row.CANTIDAD, UNIDAD: row.UNIDAD });

const wb = XLSX.utils.book_new();
for (const n of bloquesPedidos) {
  const slice = items.slice((n - 1) * BLOQUE, n * BLOQUE);
  if (!slice.length) {
    console.warn("bloque " + n + ": vacío (fuera de rango)");
    continue;
  }
  const ws = XLSX.utils.json_to_sheet(slice.map(u));
  XLSX.utils.book_append_sheet(wb, ws, "Bloque " + n);
  console.log("\n--- BLOQUE " + n + " (" + slice.length + " items) ---");
  slice.forEach((r, i) => console.log(i + 1, r.CODIGO, r.PRODUCTO.slice(0, 42), r.XBULTO + r.UNIDAD, "x" + r.CANTIDAD));
}
const outXlsx = path.join(ROOT, outName);
XLSX.writeFile(wb, outXlsx);
console.log("\nOK ->", outXlsx);
