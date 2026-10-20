// Suelo de verdad para la celda U.M.: (1) voto mayoritario de OCR con varias
// variantes y (2) comparacion de pixeles contra las celdas "b" y "d" que el OCR
// de pagina leyo limpias. Asi un token "|ad" se resuelve sin adivinar.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { leerFuentes, cargarFunciones } from "./_extract.mjs";
import { medida_categoria, match_concept } from "../extension/core/normalize.js";

const ROOT = path.resolve(process.cwd());
const PDF = path.resolve(ROOT, "..", "PEDIDO ARCOR LA PLATA 13 NOV 250926.pdf");
const DUMP = path.resolve(ROOT, "..", "ocr-dump.json");

// --- filas del pedido segun el parser real ( sku, cy, unidad, token )
const { agent, normalize } = leerFuentes(ROOT);
const M = cargarFunciones({
  agent, normalize, constantes: ["_OCR_FIX"],
  funciones: ["_first_digits", "_es_unidad_sospechosa", "_unit_letter", "_ocr_fix", "_pdf_build_rows", "_pdf_row_info"],
})(medida_categoria, match_concept, { log() {} });

const dump = JSON.parse(fs.readFileSync(DUMP, "utf8"));
const ESC_REF = 4.5;
const filas = [];
for (const pg of dump.paginas) {
  if (!pg.words.length) continue;
  for (const row of M._pdf_build_rows(pg.words, ESC_REF)) {
    const info = M._pdf_row_info(pg.w, row);
    if (!info || !/^\d{4,6}$/.test(info.sku)) continue;
    // Token exacto de la columna U.M. segun el bandeo del parser.
    const tok = row.find((w) => {
      const xf = (w.x0 + w.x1) / 2 / pg.w;
      return xf >= 0.25 && xf <= 0.31 && M._unit_letter(w.t) !== null;
    });
    filas.push({
      pag: pg.n, w: pg.w, sku: info.sku, cy: info.cy, unidad: info.unidad,
      tok: tok ? tok.t : null,
      caja: tok ? { x0: tok.x0, x1: tok.x1 } : { x0: 975, x1: 1050 },
    });
  }
}

const MIME = { ".html": "text/html", ".js": "text/javascript", ".gz": "application/gzip" };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("no"); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
await page.goto("http://127.0.0.1:" + server.address().port + "/tools/_ocr_scratch.html");
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });
const PSM = await page.evaluate(() => window.__PSM);

const ESC = 14;
const k = ESC / ESC_REF;
const res = await page.evaluate(async ({ pdfB64, filas, ESC, k, PSM }) => {
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
    const vp = pg.getViewport({ scale: ESC, rotation: 90 });
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    cache[n] = cv; return cv;
  };
  const recorte = (cv, x0, y0, x1, y1, agr) => {
    const out = document.createElement("canvas");
    out.width = Math.max(8, Math.round((x1 - x0) * agr));
    out.height = Math.max(8, Math.round((y1 - y0) * agr));
    const c = out.getContext("2d");
    c.fillStyle = "#fff"; c.fillRect(0, 0, out.width, out.height);
    c.imageSmoothingQuality = "high";
    c.drawImage(cv, x0, y0, x1 - x0, y1 - y0, 0, 0, out.width, out.height);
    return out;
  };
  // Binariza, recorta al contenido y reescala a 24x32 para comparar pixeles.
  const firma = (cv) => {
    const c = cv.getContext("2d");
    const d = c.getImageData(0, 0, cv.width, cv.height).data;
    let xmin = cv.width, xmax = -1, ymin = cv.height, ymax = -1;
    for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) {
      if (d[(y * cv.width + x) * 4] < 140) { if (x < xmin) xmin = x; if (x > xmax) xmax = x; if (y < ymin) ymin = y; if (y > ymax) ymax = y; }
    }
    if (xmax < 0) return null;
    const N = 24, A = 32;
    const out = document.createElement("canvas");
    out.width = N; out.height = A;
    const oc = out.getContext("2d");
    oc.fillStyle = "#fff"; oc.fillRect(0, 0, N, A);
    oc.imageSmoothingQuality = "high";
    oc.drawImage(cv, xmin - 2, ymin - 2, xmax - xmin + 5, ymax - ymin + 5, 0, 0, N, A);
    const od = oc.getImageData(0, 0, N, A).data;
    const bits = [];
    for (let y = 0; y < A; y++) for (let x = 0; x < N; x++) bits.push(od[(y * N + x) * 4] < 140 ? 1 : 0);
    return bits;
  };
  const dist = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) s++; return s / a.length; };

  const salida = [];
  for (const f of filas) {
    const cv = await canvasDe(f.pag);
    const m = 6;
    const x0 = (f.caja.x0 - m) * k, x1 = (f.caja.x1 + m) * k;
    const y0 = (f.cy - 20) * k, y1 = (f.cy + 20) * k;
    const grande = recorte(cv, x0, y0, x1, y1, 2);
    const votos = [];
    for (const psm of [PSM.SINGLE_LINE, PSM.SINGLE_WORD, PSM.SINGLE_CHAR, PSM.RAW_LINE]) {
      for (const agr of [2, 3]) {
        const img = recorte(cv, x0, y0, x1, y1, agr);
        await w.setParameters({ tessedit_pageseg_mode: psm, tessedit_char_whitelist: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ" });
        const t = (await w.recognize(img)).data.text.replace(/[^a-zA-Z]/g, "").toLowerCase();
        if (t) votos.push(t);
      }
    }
    const cuenta = {};
    for (const v of votos) cuenta[v] = (cuenta[v] || 0) + 1;
    const orden = Object.keys(cuenta).sort((a, b) => cuenta[b] - cuenta[a]);
    salida.push({ ...f, votos: orden.map((k2) => k2 + ":" + cuenta[k2]).join(" "), ganador: orden[0] || "", firma: firma(grande) });
  }
  await w.terminate();
  return salida;
}, { pdfB64: fs.readFileSync(PDF).toString("base64"), filas, ESC, k, PSM });

// --- referencias: filas donde el token leido es limpio "b" o "d"
const refB = res.filter((r) => /^[|lI\[ ]*b$/i.test(r.tok || ""));
const refD = res.filter((r) => /^[|lI\[ ]*d$/i.test(r.tok || ""));
const centroB = refB.length ? promedio(refB.map((r) => r.firma)) : null;
const centroD = refD.length ? promedio(refD.map((r) => r.firma)) : null;
function promedio(bits) {
  const n = bits[0].length;
  const out = new Array(n).fill(0);
  for (const b of bits) for (let i = 0; i < n; i++) out[i] += b[i] / bits.length;
  return out.map((v) => (v > 0.35 ? 1 : 0));
}
function d(a, b) { let s = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) s++; return s / a.length; }

console.log("referencias limpias: " + refB.length + " celdas 'b', " + refD.length + " celdas 'd'\n");
console.log("sku    token   unidad-parseada  voto-OCR              pix-b  pix-d  -> letra");
const filasOut = res.map((r) => {
  const db = centroB && r.firma ? d(r.firma, centroB) : NaN;
  const dd = centroD && r.firma ? d(r.firma, centroD) : NaN;
  const letraPix = Math.abs(db - dd) < 0.02 ? "?" : db < dd ? "b" : "d";
  return { ...r, db, dd, letraPix };
});
for (const r of filasOut) {
  const voto = r.ganador;
  const marca = /u/.test(voto) ? "  <<< U" : "";
  console.log(
    r.sku.padEnd(7) + (r.tok || "-").padEnd(8) + (r.unidad || "-").padEnd(17) +
    (r.votos || "-").padEnd(22) + r.db.toFixed(3).padEnd(7) + r.dd.toFixed(3).padEnd(7) + "-> " + r.letraPix + (marca)
  );
}
const conU = filasOut.filter((r) => /u/.test(r.ganador));
console.log("\n=== celdas con U segun el voto de OCR ===");
for (const r of conU) console.log("  " + r.sku + " (pag " + r.pag + ") token=" + r.tok + " votos=" + r.votos + " pix-b=" + r.db.toFixed(3) + " pix-d=" + r.dd.toFixed(3));
console.log("\ntotal filas: " + filasOut.length + " | con U: " + conU.length);
fs.writeFileSync(path.join(ROOT, "..", "cell-verdict.json"), JSON.stringify(filasOut.map(({ firma, ...x }) => x), null, 1));
await browser.close();
server.close();
