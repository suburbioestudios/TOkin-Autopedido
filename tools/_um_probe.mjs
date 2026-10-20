// Extrae (codigo, U.M., cantidad pedida) de cada renglon del pedido, usando las
// bandas x de los encabezados, y marca los productos cuya U.M. trae una "u".
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const dump = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "ocr-dump.json"), "utf8"));

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

const cx = (w) => (w.x0 + w.x1) / 2;
// Bandas de columna (centro x) derivadas de los encabezados de la pagina 1.
const C = { codigo: 300, desc: 883, xbul: 985, unid: 1050, pedida: 1180, piezas: 1240 };
const enCol = (w, desde, hasta) => cx(w) >= desde && cx(w) < hasta;

const filas1 = renglones(dump.paginas[0].words);
const hdr = filas1.find((f) => f.ws.some((w) => /c[oó]digo/i.test(w.t)));
console.log("encabezado y=" + Math.round(hdr.c) + ": " + hdr.ws.map((w) => w.t + "@" + Math.round(cx(w))).join(" "));
console.log("");

const resumen = [];
for (const pg of dump.paginas) {
  if (!pg.words.length) { console.log("--- pagina " + pg.n + ": vacia ---"); continue; }
  console.log("--- pagina " + pg.n + " ---");
  for (const f of renglones(pg.words)) {
    if (f.c < hdr.c + 40) continue; // solo cuerpo
    const cod = f.ws.filter((w) => cx(w) < C.codigo).map((w) => w.t).join("");
    if (!/^\d{3,6}$/.test(cod)) continue;
    const unid = f.ws.filter((w) => enCol(w, C.xbul, C.unid)).map((w) => w.t).join(" ").trim();
    const xbul = f.ws.filter((w) => enCol(w, C.desc, C.xbul)).map((w) => w.t).join(" ").trim();
    const ped = f.ws.filter((w) => enCol(w, C.unid, C.pedida)).map((w) => w.t).join(" ").trim();
    const desc = f.ws.filter((w) => enCol(w, C.codigo, C.desc)).map((w) => w.t).join(" ");
    const marca = /u/i.test(unid) ? "   <<< TIENE U" : (/^\s*$/.test(unid) ? "  (vacia)" : (/^\d+$/.test(unid) ? "  (numero, sin letra)" : ""));
    console.log(cod + " | xBul=" + (xbul || "-") + " | UM=" + (unid || "-") + " | ped=" + (ped || "-") + " | " + desc.slice(0, 40) + marca);
    resumen.push({ pag: pg.n, cod, xbul, unid, ped });
  }
}
console.log("\n===== RESUMEN U.M. =====");
const porUnidad = {};
for (const r of resumen) {
  const k = (r.unid || "(vacia)").replace(/\s+/g, " ");
  (porUnidad[k] = porUnidad[k] || []).push(r.cod);
}
for (const k of Object.keys(porUnidad).sort()) {
  console.log("UM=" + k + "  ->  " + porUnidad[k].length + " productos" + (/u/i.test(k) ? "   <<<<< CON U" : ""));
  if (/u/i.test(k)) console.log("      codigos: " + porUnidad[k].join(", "));
}
console.log("\ntotal renglones: " + resumen.length);
