// Arma el XLSX de prueba con SOLO los bloques 2 y 5 del pedido Adrogué 19 OCT.
// Los "bloques" son lotes de 19 ítems (así los carga la extensión). Se leen los
// ítems en orden del PDF y se cortan por bloque. Encabezados CODIGO/CANTIDAD/
// PRODUCTO para que la extensión los lea.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import XLSX from "xlsx";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BLOQUE = 19;
const pages = JSON.parse(fs.readFileSync(path.join(ROOT, "tools", "_adrogue_ocr_pages.json"), "utf8"));

const items = [];
for (const pg of pages) {
  if (!pg.text) continue;
  for (const line of pg.text.split(/\r?\n/)) {
    if (!/^\s*\d{3,6}\s*[\[\|]/.test(line) || !/\d,\d\d\s*\|/.test(line)) continue;
    // El layout es: cod | desc | xBul | [unidad][cantidad] | piezas | precios...
    // El OCR mete separadores "|" o "[" y ruido en el token de unidad
    // ("la 6", "d al O", "eb 2"). El campo de unidad+cantidad es el que está
    // entre el xBulto y las piezas: la CANTIDAD son sus dígitos y la UNIDAD su
    // última letra válida (b/d/u).
    // El OCR mete separadores "|" o "[" y a veces el nombre arranca con "["
    // pegado al separador ("| [MOGUL..."). Se normaliza "|[", "| [" y "["
    // inicial de descripción a "|" antes de partir, para no romper el nombre.
    const norm = line.replace(/\|\s*\[/g, "|").replace(/\[/g, "|");
    const parts = norm.split(/\|/).map((s) => s.trim());
    const cod = (parts[0] || "").match(/^(\d{3,6})/);
    if (!cod) continue;
    // La celda "xBul" y la de unidad+cantidad pueden venir juntas en un token
    // ("20 ld 1") o separadas ("12" + "a al 0"): el OCR es inconsistente. La
    // cantidad real es el ÚLTIMO número del bloque unidad/cantidad y la unidad
    // es la letra b/d/u. Se busca en los campos 2/3 y, si falla, en el resto
    // antes de las piezas (que es 0/o/O).
    let cant = 0, unidad = "";
    for (let k = 2; k <= 4; k++) {
      const seg = String(parts[k] || "");
      const letters = seg.toLowerCase().replace(/[^a-z]/g, "");
      const nums = seg.match(/\d+/g);
      const u = /b/.test(letters) ? "b" : /d/.test(letters) ? "d" : /u/.test(letters) ? "u" : "";
      if (u && nums && nums.length) {
        // el token mezcla unidad + cantidad: la cantidad es el último número
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

function bloqueSlice(n) {
  return items.slice((n - 1) * BLOQUE, n * BLOQUE);
}

const b2 = bloqueSlice(2);
const b5 = bloqueSlice(5);
console.log("bloque 2:", b2.length, "items | bloque 5:", b5.length, "items");

const u = (row) => ({ CODIGO: row.CODIGO, PRODUCTO: row.PRODUCTO, CANTIDAD: row.CANTIDAD, UNIDAD: row.UNIDAD });

const ws2 = XLSX.utils.json_to_sheet(b2.map(u));
const ws5 = XLSX.utils.json_to_sheet(b5.map(u));
const wb = XLSX.utils.book_new();
XLSX.utils.book_append_sheet(wb, ws2, "Bloque 2");
XLSX.utils.book_append_sheet(wb, ws5, "Bloque 5");
const outXlsx = path.join(ROOT, "adrogue_bloques_2_y_5.xlsx");
XLSX.writeFile(wb, outXlsx);
console.log("OK ->", outXlsx);

console.log("\n--- BLOQUE 2 ---");
b2.forEach((r, i) => console.log(i + 1, r.CODIGO, r.PRODUCTO.slice(0, 40), r.XBULTO + r.UNIDAD, "x" + r.CANTIDAD));
console.log("\n--- BLOQUE 5 ---");
b5.forEach((r, i) => console.log(i + 1, r.CODIGO, r.PRODUCTO.slice(0, 40), r.XBULTO + r.UNIDAD, "x" + r.CANTIDAD));
