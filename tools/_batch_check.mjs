// Prueba de EQUIVALENCIA del re-OCR de banda: corre en el navegador el camino
// viejo (una llamada de OCR por fila) y el nuevo (todas las bandas de la página
// apiladas en una sola imagen, una llamada de OCR) sobre el PDF real, y compara
// los fixes fila por fila. También cuenta las llamadas de OCR de cada camino.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { leerFuentes, extractFunction, extractConst } from "./_extract.mjs";

const ROOT = path.resolve(process.cwd());
const PDF = path.resolve(ROOT, "..", "PEDIDO ARCOR LA PLATA 13 NOV 250926.pdf");
const { agent, normalize } = leerFuentes(ROOT);

// Fuentes de todo lo que hace falta, tal cual están en agent.js / normalize.js.
const fnsAgent = [
  "_first_digits", "_es_unidad_sospechosa", "_unit_letter", "_ocr_fix",
  "_pdf_build_rows", "_pdf_row_info", "_pdf_all_rows",
  "_render_page", "_ocr_canvas", "_band_row_fix", "_band_geom", "_band_row_words",
  "_pdf_band_refine", "_pdf_bands_refine",
];
const partes = [
  "const _OCR_FIX = " + extractConst(agent, "_OCR_FIX") + ";",
  "const _BAND_MAX = " + extractConst(agent, "_BAND_MAX") + ";",
  "const _BAND_CANVAS_MAX = " + extractConst(agent, "_BAND_CANVAS_MAX") + ";",
  ...fnsAgent.map((f) => extractFunction(agent, f)),
  extractFunction(agent, "_band_estirar"),
  extractFunction(normalize, "medida_categoria"),
  extractFunction(normalize, "match_concept"),
  // helper de normalize que usa medida_categoria, y _to_num tal cual está en agent.js
  "function normalize(x){ return String(x==null?'':x).normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }",
  extractFunction(agent, "_to_num"),
];
const FUENTE = partes.join("\n\n");

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
page.on("console", (m) => console.log("   [browser] " + m.text()));

const soloPaginas = process.argv[2] ? process.argv[2].split(",").map(Number) : [1, 2];

const res = await page.evaluate(async ({ pdfB64, dump, FUENTE, REFINE, soloPaginas, ESCALA, ROT }) => {
  const M = new Function(FUENTE + "\nreturn { _pdf_all_rows, _pdf_band_refine, _pdf_bands_refine, _render_page, _ocr_canvas, _band_geom, _band_row_fix, _band_row_words };")();

  // Contador de llamadas de OCR, para medir el ahorro real.
  let llamadas = 0;
  const w = await window.Tesseract.createWorker({ workerBlobURL: false, workerPath: "/extension/lib/tesseract/worker.min.js", corePath: "/extension/lib/tesseract/tesseract-core.wasm.js", langPath: "/extension/lib/tesseract/lang/", logger: () => {} });
  await w.loadLanguage("spa"); await w.initialize("spa");
  // Worker con la misma API que usa agent.js, pero contando cada recognize().
  const workerContador = { recognize: (c) => { llamadas++; return w.recognize(c); } };

  const bin = atob(pdfB64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const pdf = await window.pdfjsLib.getDocument({ data: u8 }).promise;

  const salida = [];
  let totalLlamadasA = 0, totalLlamadasB = 0, filasTotales = 0;

  for (const pg of dump.paginas) {
    if (soloPaginas && !soloPaginas.includes(pg.n)) continue;
    if (!pg.words || !pg.words.length) continue;
    const words = pg.words.map((x) => ({ t: x.t, x0: x.x0, y0: x.y0, x1: x.x1, y1: x.y1 }));
    const rows = M._pdf_all_rows(words, pg.w, ESCALA);
    if (!rows.length) continue;
    const pageObj = await pdf.getPage(pg.n);
    const full = await M._render_page(pageObj, ROT, REFINE);
    filasTotales += rows.length;
    console.log("pagina " + pg.n + ": " + rows.length + " filas, probando camino A (uno por fila)…");

    // --- Camino A: una banda por fila (el de antes)
    llamadas = 0;
    const fixesA = {};
    for (const s of rows) {
      const fix = await M._pdf_band_refine(workerContador, pageObj, ROT, s.sku, s.cy, pg.w, pg.h, ESCALA, REFINE, full);
      if (!fix) continue;
      if (fix.cantidad != null || fix.unidad != null || fix.sku != null) fixesA[String(s.cy)] = fix;
    }
    const llamadasA = llamadas;
    totalLlamadasA += llamadas;

    // --- Camino B: todas las bandas apiladas, un OCR por página
    console.log("pagina " + pg.n + ": probando camino B (lote de " + rows.length + " bandas)…");
    llamadas = 0;
    const fixesB = await M._pdf_bands_refine(workerContador, full, rows, pg.w, pg.h, ESCALA, REFINE);
    const llamadasB = llamadas;
    totalLlamadasB += llamadas;

    // --- Comparación
    const clavesA = Object.keys(fixesA).sort();
    const clavesB = Object.keys(fixesB).sort();
    const diffs = [];
    for (const k of new Set([...clavesA, ...clavesB])) {
      const a = fixesA[k], b = fixesB[k];
      const sa = JSON.stringify(a || null), sb = JSON.stringify(b || null);
      if (sa !== sb) diffs.push("  cy=" + k + "  A=" + sa + "  B=" + sb);
    }
    salida.push({
      pag: pg.n, filas: rows.length,
      fixesA: clavesA.length, fixesB: clavesB.length,
      llamadasA, llamadasB, diffs,
    });
    full.width = 0; full.height = 0;
  }
  await w.terminate();
  return { salida, _: { totalLlamadasA, totalLlamadasB, filasTotales } };
}, {
  pdfB64: fs.readFileSync(PDF).toString("base64"),
  dump: JSON.parse(fs.readFileSync(path.join(ROOT, "..", "ocr-dump.json"), "utf8")),
  FUENTE, REFINE: 3.5, soloPaginas,
  ESCALA: 4.5, ROT: 90,
});

console.log("pag  filas  ocr-A  ocr-B  fixes-A  fixes-B  diferencias");
let totDif = 0;
for (const s of res.salida) {
  console.log(
    String(s.pag).padEnd(5) + String(s.filas).padEnd(7) + String(s.llamadasA).padEnd(6) +
    String(s.llamadasB).padEnd(6) + String(s.fixesA).padEnd(9) +
    String(s.fixesB).padEnd(9) + (s.diffs.length ? s.diffs.length + " <-- DISTINTO" : "iguales")
  );
  for (const d of s.diffs) console.log(d);
  totDif += s.diffs.length;
}
console.log("\nfilas totales refidadas: " + res._.filasTotales);
console.log("llamadas OCR camino A (uno por fila): " + res._.totalLlamadasA);
console.log("llamadas OCR camino B (por lotes):    " + res._.totalLlamadasB);
console.log("\n" + (totDif === 0
  ? "OK: el lote produce EXACTAMENTE los mismos fixes que el camino de a uno."
  : "FALLA: " + totDif + " filas difieren entre los dos caminos."));
await browser.close();
server.close();
process.exit(totDif === 0 ? 0 : 1);
