// Por qué se cuelga el OCR de la pila de bandas: mide tiempo de OCR para
// distinta cantidad de bandas apiladas y distinto PSM, sobre la página 1 real.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { leerFuentes, extractFunction } from "./_extract.mjs";

const ROOT = path.resolve(process.cwd());
const PDF = path.resolve(ROOT, "..", "PEDIDO ARCOR LA PLATA 13 NOV 250926.pdf");
const { agent } = leerFuentes(ROOT);
const FUENTE = [
  extractFunction(agent, "_render_page"),
  extractFunction(agent, "_band_geom"),
].join("\n\n");

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

const dump = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "ocr-dump.json"), "utf8"));
const REFINE = 3.5, ESCALA = 4.5;
const k = ESCALA / REFINE;
const limit = Number(process.argv[2] || 8);

const res = await page.evaluate(async ({ pdfB64, dump, FUENTE, REFINE, k, PSM, limit }) => {
  const M = new Function(FUENTE + "\nreturn { _render_page, _band_geom };")();
  const bin = atob(pdfB64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const pdf = await window.pdfjsLib.getDocument({ data: u8 }).promise;
  const w = await window.Tesseract.createWorker({ workerBlobURL: false, workerPath: "/extension/lib/tesseract/worker.min.js", corePath: "/extension/lib/tesseract/tesseract-core.wasm.js", langPath: "/extension/lib/tesseract/lang/", logger: () => {} });
  await w.loadLanguage("spa"); await w.initialize("spa");

  const pg = dump.paginas[0];
  const pageObj = await pdf.getPage(1);
  const full = await M._render_page(pageObj, 90, REFINE);

  // Celdas de las filas de producto, en coordenadas de página (escala 4.5).
  const cys = [];
  {
    const words = pg.words.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
    const filas = [];
    for (const p of words) {
      const c = (p.y0 + p.y1) / 2;
      let f = filas.find((x) => Math.abs(x.c - c) < Math.min(p.y1 - p.y0, x.h) * 0.6);
      if (!f) { f = { c, h: p.y1 - p.y0, ws: [] }; filas.push(f); }
      f.c = (f.c * f.ws.length + c) / (f.ws.length + 1);
      f.h = Math.max(f.h, p.y1 - p.y0);
      f.ws.push(p);
    }
    for (const f of filas) {
      const cod = f.ws.filter((x) => (x.x0 + x.x1) / 2 < 300).map((x) => x.t).join("");
      if (/^\d{4,6}$/.test(cod)) cys.push(f.c);
    }
  }
  cys.sort((a, b) => a - b);
  console.log("filas de producto en la pagina 1: " + cys.length);

  const apilar = (n, gap) => {
    const geoms = cys.slice(0, n).map((cy) => M._band_geom(full, cy, pg.h));
    const maxBh = Math.max(...geoms.map((g) => g.bh));
    const pila = document.createElement("canvas");
    pila.width = full.width;
    pila.height = geoms.reduce((a, g) => a + g.bh + gap, 0) - gap;
    const ctx = pila.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, pila.width, pila.height);
    let acc = 0;
    for (const g of geoms) { ctx.drawImage(full, 0, g.top, full.width, g.bh, 0, acc, full.width, g.bh); acc += g.bh + gap; }
    return pila;
  };

  const salida = [];
  for (const n of [2, 4, 8].filter((x) => x <= limit)) {
    for (const [nombre, psm] of [["AUTO(3)", null], ["COLUMNA(4)", PSM.SINGLE_COLUMN], ["BLOQUE(6)", PSM.SINGLE_BLOCK], ["SPARSE(11)", PSM.SPARSE_TEXT]]) {
      const pila = apilar(n, 12);
      if (psm !== null) await w.setParameters({ tessedit_pageseg_mode: psm });
      else await w.setParameters({ tessedit_pageseg_mode: PSM.AUTO_PAGE_SEGMENTATION });
      const t0 = performance.now();
      const { data } = await w.recognize(pila);
      const ms = Math.round(performance.now() - t0);
      salida.push({ n, psm: nombre, ms, palabras: (data.words || []).length, dims: pila.width + "x" + pila.height });
      console.log("  " + n + " bandas, PSM " + nombre.padEnd(11) + " -> " + String(ms).padStart(6) + " ms  (" + pila.width + "x" + pila.height + ", " + (data.words || []).length + " palabras)");
      pila.width = 0; pila.height = 0;
    }
  }
  await w.terminate();
  return salida;
}, { pdfB64: fs.readFileSync(PDF).toString("base64"), dump: { ...dump, paginas: [dump.paginas[0]] }, FUENTE, REFINE, k, PSM: null, limit })
  .catch(async (e) => {
    // PSM vive en la pagina
    const PSM = await page.evaluate(() => window.__PSM);
    return page.evaluate(async ({ pdfB64, dump, FUENTE, REFINE, k, PSM, limit }) => {
      const M = new Function(FUENTE + "\nreturn { _render_page, _band_geom };")();
      const bin = atob(pdfB64);
      const u8 = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
      const pdf = await window.pdfjsLib.getDocument({ data: u8 }).promise;
      const w = await window.Tesseract.createWorker({ workerBlobURL: false, workerPath: "/extension/lib/tesseract/worker.min.js", corePath: "/extension/lib/tesseract/tesseract-core.wasm.js", langPath: "/extension/lib/tesseract/lang/", logger: () => {} });
      await w.loadLanguage("spa"); await w.initialize("spa");
      const pg = dump.paginas[0];
      const pageObj = await pdf.getPage(1);
      const full = await M._render_page(pageObj, 90, REFINE);
      const cys = [];
      {
        const words = pg.words.slice().sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
        const filas = [];
        for (const p of words) {
          const c = (p.y0 + p.y1) / 2;
          let f = filas.find((x) => Math.abs(x.c - c) < Math.min(p.y1 - p.y0, x.h) * 0.6);
          if (!f) { f = { c, h: p.y1 - p.y0, ws: [] }; filas.push(f); }
          f.c = (f.c * f.ws.length + c) / (f.ws.length + 1);
          f.h = Math.max(f.h, p.y1 - p.y0);
          f.ws.push(p);
        }
        for (const f of filas) {
          const cod = f.ws.filter((x) => (x.x0 + x.x1) / 2 < 300).map((x) => x.t).join("");
          if (/^\d{4,6}$/.test(cod)) cys.push(f.c);
        }
      }
      cys.sort((a, b) => a - b);
      console.log("filas de producto en la pagina 1: " + cys.length);
      const apilar = (n, gap) => {
        const geoms = cys.slice(0, n).map((cy) => M._band_geom(full, cy, pg.h));
        const pila = document.createElement("canvas");
        pila.width = full.width;
        pila.height = geoms.reduce((a, g) => a + g.bh + gap, 0) - gap;
        const ctx = pila.getContext("2d");
        ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, pila.width, pila.height);
        let acc = 0;
        for (const g of geoms) { ctx.drawImage(full, 0, g.top, full.width, g.bh, 0, acc, full.width, g.bh); acc += g.bh + gap; }
        return pila;
      };
      for (const n of [2, 4, 8].filter((x) => x <= limit)) {
        for (const [nombre, psm] of [["AUTO(3)", PSM.AUTO_PAGE_SEGMENTATION], ["COLUMNA(4)", PSM.SINGLE_COLUMN], ["BLOQUE(6)", PSM.SINGLE_BLOCK], ["SPARSE(11)", PSM.SPARSE_TEXT]]) {
          const pila = apilar(n, 12);
          await w.setParameters({ tessedit_pageseg_mode: psm });
          const t0 = performance.now();
          const { data } = await w.recognize(pila);
          const ms = Math.round(performance.now() - t0);
          console.log("  " + n + " bandas, PSM " + nombre.padEnd(11) + " -> " + String(ms).padStart(6) + " ms  (" + pila.width + "x" + pila.height + ", " + (data.words || []).length + " palabras)");
          pila.width = 0; pila.height = 0;
        }
      }
      await w.terminate();
      return [];
    }, { pdfB64: fs.readFileSync(PDF).toString("base64"), dump: { ...dump, paginas: [dump.paginas[0]] }, FUENTE, REFINE, k, PSM, limit });
  });

await browser.close();
server.close();
