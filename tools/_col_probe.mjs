// Analiza el dump OCR (rotacion correcta) agrupando palabras en renglones y
// columnas segun los encabezados, y lista la columna U.M. de cada producto.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const dump = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "ocr-dump.json"), "utf8"));

// Agrupa palabras en renglones por closeness vertical del centro.
function renglones(palabras) {
  const filas = [];
  for (const p of palabras.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0)) {
    const c = (p.y0 + p.y1) / 2;
    let f = filas.find((x) => Math.abs(x.c - c) < Math.min(p.y1 - p.y0, x.h) * 0.6);
    if (!f) { f = { c, h: p.y1 - p.y0, ws: [] }; filas.push(f); }
    f.c = (f.c * f.ws.length + c) / (f.ws.length + 1);
    f.h = Math.max(f.h, p.y1 - p.y0);
    f.ws.push(p);
  }
  for (const f of filas) f.ws.sort((a, b) => a.x0 - b.x0);
  return filas;
}

const pag = dump.paginas[0];
const filas = renglones(pag.words);
console.log("=== renglones de la pagina 1 (primeros 16) ===");
for (const f of filas.slice(0, 16)) {
  console.log("y=" + Math.round(f.c) + "  " + f.ws.map((w) => w.t + "@" + Math.round((w.x0 + w.x1) / 2)).join(" "));
}
