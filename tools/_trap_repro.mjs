// Reproduccion del trap del core WASM de Tesseract (tesseract-core.wasm.js:33
// (dh)) corriendo el FLUJO REAL de agent.js: deteccion de rotacion (3 workers en
// paralelo) + OCR de las paginas en paralelo + re-OCR de banda. Captura TODA la
// salida de consola y TODA excepcion para poder ver si el trap es fatal, en que
// paso salta y con que mensaje real (la linea del trap no dice nada).
//
//   node tools\_trap_repro.mjs [paginas]      (por defecto todas)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { leerFuentes, extractFunction, extractConst } from "./_extract.mjs";

const ROOT = path.resolve(process.cwd());
const PDF = path.resolve(ROOT, "..", "PEDIDO ARCOR LA PLATA 13 NOV 250926.pdf");
const { agent, normalize } = leerFuentes(ROOT);

// Todo lo que _pdf_text necesita, tal cual esta en agent.js / normalize.js.
const NEED = [
  "_ocr_worker", "_render_page", "_ocr_canvas", "_parallel", "_legibility",
  "_detect_one", "_detect_rotations", "_ocr_page",
  "_first_digits", "_es_unidad_sospechosa", "_unit_letter", "_ocr_fix",
  "_pdf_build_rows", "_pdf_row_info", "_pdf_all_rows", "_pdf_table_items",
  "_band_row_fix", "_band_geom", "_band_row_words", "_pdf_band_refine",
  "_to_num",
];
const partes = [
  "const _OCR_FIX = " + extractConst(agent, "_OCR_FIX") + ";",
  "const OCR_WORKERS = " + extractConst(agent, "OCR_WORKERS") + ";",
  "const ROT_CANDIDATES = " + extractConst(agent, "ROT_CANDIDATES") + ";",
  "const OCR_SCALE = " + extractConst(agent, "OCR_SCALE") + ";",
  "const OCR_DETECT_SCALE = " + extractConst(agent, "OCR_DETECT_SCALE") + ";",
  "function lib(n){ return window[n]; }",
  ...NEED.map((f) => extractFunction(agent, f)),
  extractFunction(normalize, "medida_categoria"),
  extractFunction(normalize, "match_concept"),
  "function normalize(x){ return String(x==null?'':x).normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }",
];
const FUENTE = partes.join("\n\n");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".gz": "application/gzip", ".traineddata": "application/octet-stream" };
const server = http.createServer((req, res) => {
  const f = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("no"); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();

const consola = [];
page.on("console", (m) => {
  const t = m.type() + ": " + m.text();
  consola.push(t);
  console.log("   [browser " + m.type() + "] " + m.text());
});
page.on("pageerror", (e) => {
  consola.push("PAGEERROR: " + e.name + ": " + e.message);
  console.log("   [PAGEERROR] " + e.name + ": " + e.message + "\n" + (e.stack || ""));
});
page.on("weberror", (e) => {
  consola.push("WEBERROR: " + String(e.error()));
  console.log("   [WEBERROR] " + String(e.error()));
});

await page.goto("http://127.0.0.1:" + server.address().port + "/tools/_ocr_scratch.html");
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

const soloPaginas = process.argv[2] ? process.argv[2].split(",").map(Number) : null;
const pdfB64 = fs.readFileSync(PDF).toString("base64");

const r = await page.evaluate(async ({ pdfB64, FUENTE, soloPaginas }) => {
  const M = new Function(FUENTE + "\nreturn { _ocr_worker, _render_page, _ocr_canvas, _parallel, _detect_rotations, _ocr_page, _pdf_all_rows, _pdf_table_items, _pdf_band_refine };" )();

  const bin = atob(pdfB64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const pdf = await window.pdfjsLib.getDocument({ data: u8 }).promise;

  const t0 = Date.now();
  const etapas = [];
  const paso = (n, extra) => { etapas.push(n + (extra ? " " + extra : "")); console.log("[etapa] " + n + (extra ? " " + extra : "") + " (" + (Date.now() - t0) + "ms)"); };

  const pool = [];
  let fatal = null;
  let rot = 270;
  let filas = 0;
  let bandas = 0;
  let sinFallo = 0;
  const paginas = [];

  try {
    paso("creando " + M._ocr_worker.name + " x pool");
    for (let k = 0; k < 3; k++) pool.push(await M._ocr_worker());
    paso("pool listo");

    paso("detectando rotacion (3 en paralelo)");
    const rots = await M._detect_rotations(pool, await pdf.getPage(1));
    rot = rots[0].rot;
    paso("rotacion ganadora = " + rot + " conf=" + rots[0].conf.toFixed(1) + " score=" + rots[0].score.toFixed(1));

    const need = [];
    for (let p = 1; p <= pdf.numPages; p++) need.push(p);
    if (soloPaginas) need.splice(0, need.length, ...need.filter((p) => soloPaginas.includes(p)));

    const primera = rots.filter((x) => x.rot === rot)[0];
    const paginas = [{ page: 1, words: primera.words, w: primera.w, h: primera.h, scale: primera.scale }];
    const rest = need.filter((p) => p !== 1);
    if (rest.length) {
      paso("OCR de " + rest.length + " paginas en paralelo");
      const res = await M._parallel(pool, rest, (wkr, pnum) => M._ocr_page(wkr, null, rot, pnum));
      for (let k = 0; k < res.length; k++) {
        const x = res[k];
        if (x && x.words && x.words.length) paginas.push({ page: rest[k], words: x.words, w: x.w, h: x.h, scale: x.scale });
      }
      paso("paginas OCR: " + paginas.length);
    }

    paso("re-OCR de banda");
    for (const pg of paginas) {
      const rows = M._pdf_all_rows(pg.words, pg.w, pg.scale);
      if (!rows.length) continue;
      filas += rows.length;
      const pageObj = await pdf.getPage(pg.page);
      const full = await M._render_page(pageObj, rot, 3.5);
      for (const s of rows) {
        try {
          const fix = await M._pdf_band_refine(pool[0], pageObj, rot, s.sku, s.cy, pg.w, pg.h, pg.scale, 3.5, full);
          bandas++;
          if (fix) sinFallo++;
        } catch (e) {
          throw new Error("banda de la pagina " + pg.page + " (cy=" + Math.round(s.cy) + ") lanzo: " + (e && e.name) + " " + (e && e.message));
        }
      }
      full.width = 0; full.height = 0;
      paso("pagina " + pg.page + ": " + rows.length + " filas ok");
    }
  } catch (e) {
    const desc = (e && (e.name || e.message)) ? e.name + ": " + e.message : "valor lanzado: " + JSON.stringify(e);
    fatal = desc + " | " + String((e && e.stack) || "(sin stack)").split("\n").slice(0, 5).join(" / ");
    try { console.log("[FATAL] " + fatal); } catch (x) {}
  } finally {
    for (const wkr of pool) { try { await wkr.terminate(); } catch (e) {} }
  }

  return { etapas, fatal, filas, bandas, sinFallo, ms: Date.now() - t0, paginas: paginas.length };
}, { pdfB64, FUENTE, soloPaginas });

console.log("\n================ RESULTADO ================");
console.log("paginas procesadas: " + r.paginas);
console.log("filas: " + r.filas + " · bandas: " + r.bandas + " · con fix: " + r.sinFallo);
console.log("tiempo: " + r.ms + "ms");
console.log("FATAL: " + (r.fatal || "(ninguno)"));
const traps = consola.filter((c) => /wasm|\(dh\)|RuntimeError|unreachable|abort/i.test(c));
console.log("lineas de consola que mencionan el core WASM: " + traps.length);
for (const t of traps) console.log("   > " + t);

await browser.close();
server.close();
process.exit(r.fatal ? 1 : 0);
