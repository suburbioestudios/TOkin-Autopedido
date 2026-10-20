// OCR dirigido de la celda U.M.: recorta la columna y hace OCR celda por celda
// a alta escala, con PSM de linea simple y de caracter unico, para separar
// letras que a escala completa se pegan ("elb", "1b", "1lu").
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());
const PDF = path.resolve(ROOT, "..", "PEDIDO ARCOR LA PLATA 13 NOV 250926.pdf");
const DUMP = path.resolve(ROOT, "..", "ocr-dump.json");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".gz": "application/gzip" };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("no"); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:" + port + "/tools/_ocr_scratch.html");
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

const ESCALA_REF = 4.5; // escala del dump con las coordenadas de referencia
const ESCALA = Number(process.argv[2] || 9);
const dump = JSON.parse(fs.readFileSync(DUMP, "utf8"));
const k = ESCALA / ESCALA_REF;

// Geometria de columnas tomada de los encabezados reales del PDF.
const BANDAS = { codigo: 300, desc: 883, xbul: 985, unid: 1050, pedida: 1180 };
const filasDe = (palabras) => {
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
};

// Renglones a consultar: los que tienen codigo de producto.
const consultas = [];
for (const pg of dump.paginas) {
  if (!pg.words.length) continue;
  for (const f of filasDe(pg.words)) {
    const cod = f.ws.filter((w) => (w.x0 + w.x1) / 2 < BANDAS.codigo).map((w) => w.t).join("");
    if (!/^\d{3,6}$/.test(cod)) continue;
    consultas.push({ pag: pg.n, cod, y: f.c, ref: f.ws.filter((w) => (w.x0 + w.x1) / 2 >= BANDAS.xbul && (w.x0 + w.x1) / 2 < BANDAS.unid).map((w) => w.t).join(" ").trim() });
  }
}
console.log("consultas: " + consultas.length + " renglones, escala " + ESCALA + "\n");

const PSM = await page.evaluate(() => window.__PSM);
const res = await page.evaluate(async ({ pdfB64, consultas, ESCALA, k, PSM }) => {
  const bin = atob(pdfB64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const pdf = await window.pdfjsLib.getDocument({ data: u8 }).promise;
  const w = await window.Tesseract.createWorker({ workerBlobURL: false, workerPath: "/extension/lib/tesseract/worker.min.js", corePath: "/extension/lib/tesseract/tesseract-core.wasm.js", langPath: "/extension/lib/tesseract/lang/", logger: () => {} });
  await w.loadLanguage("spa"); await w.initialize("spa");

  const cache = {};
  const canvasDe = async (n) => {
    if (cache[n]) return cache[n];
    const pg = await pdf.getPage(n);
    const vp = pg.getViewport({ scale: ESCALA, rotation: 90 });
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    cache[n] = cv;
    return cv;
  };
  const recorte = (cv, x0, y0, x1, y1, agr) => {
    const out = document.createElement("canvas");
    out.width = Math.max(1, Math.round((x1 - x0) * agr));
    out.height = Math.max(1, Math.round((y1 - y0) * agr));
    const c = out.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, out.width, out.height);
    c.imageSmoothingQuality = "high";
    c.drawImage(cv, x0, y0, x1 - x0, y1 - y0, 0, 0, out.width, out.height);
    return out;
  };

  const salida = [];
  for (const c of consultas) {
    const cv = await canvasDe(c.pag);
    const x0 = 960 * k, x1 = 1055 * k;
    const y0 = (c.y - 26) * k, y1 = (c.y + 26) * k;
    const celda = recorte(cv, x0, y0, x1, y1, 2);
    await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_LINE, tessedit_char_whitelist: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" });
    const psm7 = (await w.recognize(celda)).data.text.replace(/[^a-zA-Z]/g, "");
    await w.setParameters({ tessedit_pageseg_mode: PSM.SINGLE_CHAR });
    const psm10 = (await w.recognize(celda)).data.text.replace(/[^a-zA-Z]/g, "");
    await w.setParameters({ tessedit_char_whitelist: "", tessedit_pageseg_mode: PSM.SINGLE_LINE });
    const libre = (await w.recognize(celda)).data.text.replace(/\s+/g, " ").trim();
    const libreBul = (await w.recognize(recorte(cv, 885 * k, y0, 960 * k, y1, 2))).data.text.replace(/\s+/g, " ").trim();
    salida.push({ pag: c.pag, cod: c.cod, ref: c.ref, psm7, psm10, libre, libreBul });
  }
  await w.terminate();
  return salida;
}, { pdfB64: fs.readFileSync(PDF).toString("base64"), consultas, ESCALA, k, PSM });
fs.writeFileSync(path.join(ROOT, "..", "cell-dump.json"), JSON.stringify(res, null, 1));

const conteo = {};
let conU = 0;
console.log("cod    pag  ref(4.5)  psm7  psm10  libre        xBul");
for (const r of res) {
  const marca = /u/i.test(r.psm7 + r.psm10) ? "  <<< U" : "";
  if (marca) conU++;
  console.log(r.cod.padEnd(6) + String(r.pag).padEnd(5) + (r.ref || "-").padEnd(10) + (r.psm7 || "-").padEnd(6) + (r.psm10 || "-").padEnd(7) + (r.libre || "-").padEnd(12) + (r.libreBul || "-") + marca);
  const kk = (r.libre || "(vacio)").toLowerCase();
  (conteo[kk] = conteo[kk] || []).push(r.cod);
}
console.log("\n===== valores de celda U.M. (psm7, escala " + ESCALA + ") =====");
for (const kk of Object.keys(conteo).sort()) {
  console.log("'" + kk + "' -> " + conteo[kk].length + "  " + (/u/.test(kk) ? " <<<< CON U" : ""));
  if (/u/.test(kk)) console.log("     codigos: " + conteo[kk].join(", "));
}
console.log("\nrenglones con U: " + conU + " / " + res.length);
await browser.close();
server.close();
