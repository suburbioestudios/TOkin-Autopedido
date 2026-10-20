// Aísla por qué el lote lee "d" donde el camino individual lee "a" en la columna
// de unidad. Prueba variantes (PSM, gap, zoom) sobre las filas que fallaron.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { leerFuentes, extractFunction, extractConst } from "./_extract.mjs";

const ROOT = path.resolve(process.cwd());
const PDF = path.resolve(ROOT, "..", "PEDIDO ARCOR LA PLATA 13 NOV 250926.pdf");
const { agent, normalize } = leerFuentes(ROOT);
const FUENTE = [
  "const _OCR_FIX = " + extractConst(agent, "_OCR_FIX") + ";",
  "const _BAND_MAX = " + extractConst(agent, "_BAND_MAX") + ";",
  "const _BAND_CANVAS_MAX = " + extractConst(agent, "_BAND_CANVAS_MAX") + ";",
  ...["_first_digits", "_es_unidad_sospechosa", "_unit_letter", "_ocr_fix", "_pdf_build_rows",
    "_pdf_row_info", "_pdf_all_rows", "_render_page", "_ocr_canvas", "_band_row_fix",
    "_band_geom", "_band_row_words"].map((f) => extractFunction(agent, f)),
  extractFunction(agent, "_to_num"),
  extractFunction(normalize, "medida_categoria"),
  extractFunction(normalize, "match_concept"),
  "function normalize(x){ return String(x==null?'':x).normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/[^a-z0-9]+/g,' ').trim(); }",
].join("\n\n");

// Filas que difirieron, con el valor que produce el camino individual.
const ESPERADO = {
  1: { 1125.5: "1", 1206.5: "10", 1287.5: "3" },
  2: { 1223.5: "10", 1547.5: "1", 1628.5: "1", 1668.5: "1", 1709.5: "1", 1749.5: "1", 2033.5: "3", 939.5: "3" },
};

const MIME = { ".html": "text/html", ".js": "text/javascript" };
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
page.on("console", (m) => { const t = m.text(); if (!/Estimating|Deprecated/.test(t)) console.log("   [browser] " + t); });

const res = await page.evaluate(async ({ pdfB64, dump, FUENTE, REFINE, ESCALA, ROT, ESPERADO, PSM }) => {
  const M = new Function(FUENTE + "\nreturn { _pdf_all_rows, _render_page, _band_geom, _band_row_words, _band_row_fix, _ocr_canvas };")();
  const bin = atob(pdfB64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const pdf = await window.pdfjsLib.getDocument({ data: u8 }).promise;
  const w = await window.Tesseract.createWorker({ workerBlobURL: false, workerPath: "/extension/lib/tesseract/worker.min.js", corePath: "/extension/lib/tesseract/tesseract-core.wasm.js", langPath: "/extension/lib/tesseract/lang/", logger: () => {} });
  await w.loadLanguage("spa"); await w.initialize("spa");
  const k = ESCALA / REFINE;

  const apilar = (full, geoms, gap, zoom) => {
    const bh = Math.round(geoms[0].bh * zoom);
    const pila = document.createElement("canvas");
    pila.width = Math.round(full.width * zoom);
    pila.height = geoms.length * (bh + gap) - gap;
    const ctx = pila.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, pila.width, pila.height);
    ctx.imageSmoothingEnabled = zoom > 1;
    let acc = 0;
    for (const g of geoms) { ctx.drawImage(full, 0, g.top, full.width, g.bh, 0, acc, pila.width, bh); acc += bh + gap; }
    return { pila, bh };
  };

  const variantes = [
    { nombre: "PSM AUTO(3)  gap21 1x", psm: PSM.AUTO_PAGE_SEGMENTATION, gap: 21, zoom: 1 },
    { nombre: "PSM COLUMNA(4) gap21 1x", psm: PSM.SINGLE_COLUMN, gap: 21, zoom: 1 },
    { nombre: "PSM BLOQUE(6) gap21 1x", psm: PSM.SINGLE_BLOCK, gap: 21, zoom: 1 },
    { nombre: "PSM SPARSE(11) gap21 1x", psm: PSM.SPARSE_TEXT, gap: 21, zoom: 1 },
    { nombre: "PSM AUTO(3)  gap12 1x", psm: PSM.AUTO_PAGE_SEGMENTATION, gap: 12, zoom: 1 },
    { nombre: "PSM AUTO(3)  gap48 1x", psm: PSM.AUTO_PAGE_SEGMENTATION, gap: 48, zoom: 1 },
    { nombre: "PSM AUTO(3)  gap21 2x", psm: PSM.AUTO_PAGE_SEGMENTATION, gap: 21, zoom: 2 },
    { nombre: "PSM BLOQUE(6) gap21 2x", psm: PSM.SINGLE_BLOCK, gap: 21, zoom: 2 },
  ];

  const resumen = [];
  for (const [nPag, objetivo] of Object.entries(ESPERADO)) {
    const pg = dump.paginas[Number(nPag) - 1];
    const rows = M._pdf_all_rows(pg.words, pg.w, ESCALA);
    const pageObj = await pdf.getPage(Number(nPag));
    const full = await M._render_page(pageObj, ROT, REFINE);
    const orden = rows.slice().sort((a, b) => a.cy - b.cy);
    const geoms = orden.map((s) => M._band_geom(full, s.cy, pg.h));
    let sliceTop = 0;
    const mapa = geoms.map((g) => { const t = sliceTop; sliceTop += g.bh + 21; return t; });

    for (const v of variantes) {
      await w.setParameters({ tessedit_pageseg_mode: v.psm });
      const { pila, bh } = apilar(full, geoms, v.gap, v.zoom);
      // _ocr_canvas es el adaptador que aplana blocks/paragraphs/lines/words a
      // {t,x0,y0,x1,y1}; sin él, data.words no tiene coordenadas planas.
      const words = (await M._ocr_canvas(w, pila)).words;
      if (v === variantes[0]) {
        console.log("DEBUG full=" + full.width + "x" + full.height + " bh=" + bh + " gap=" + v.gap +
          " k=" + k + " geoms[0]=" + JSON.stringify(geoms[0]) + " pilaH=" + pila.height +
          " palabras=" + words.length);
        const ys = words.map((q) => q.y0);
        console.log("DEBUG y0 min=" + Math.min(...ys) + " max=" + Math.max(...ys) +
          "  ejemplo: " + words.slice(0, 8).map((q) => q.t + "@" + Math.round(q.y0)).join(" "));
        const hist = {};
        for (const q of words) { const b = Math.floor(q.y0 / (bh + v.gap)); hist[b] = (hist[b] || 0) + 1; }
        console.log("DEBUG palabras por banda (indice:n): " + Object.keys(hist).sort((a, b) => a - b).map((b) => b + ":" + hist[b]).join(" "));
        console.log("DEBUG cys: " + orden.map((s) => s.cy).join(" "));
        orden.forEach((s, i) => {
          if (!Object.prototype.hasOwnProperty.call(objetivo, s.cy)) return;
          const top = i * (bh + v.gap);
          const ws = words.filter((q) => q.y1 > top && q.y0 < top + bh);
          const rw = M._band_row_words(ws, s.cy, k, s.cy - 18 - top * k);
          console.log("DEBUG cy=" + s.cy + " top=" + top + " palabrasEnBanda=" + ws.length +
            " trasFiltro=" + rw.length + " crudos=" +
            ws.slice(0, 6).map((q) => q.t + "@" + Math.round(q.y0) + "-" + Math.round(q.y1)).join(" "));
        });
      }
      let ok = 0, malos = [];
      orden.forEach((s, i) => {
        const cy = s.cy;
        if (!Object.prototype.hasOwnProperty.call(objetivo, cy)) return;
        const top = i * (bh + v.gap);
        const ws = words.filter((w) => w.y1 > top && w.y0 < top + bh);
        const rowWords = M._band_row_words(ws, cy, k, cy - 18 - top * k);
        const fix = M._band_row_fix(rowWords, s.sku, cy, pg.w);
        const esperado = objetivo[cy];
        if (fix.unidad === "a" && fix.cantidad === esperado) ok++;
        else malos.push("cy=" + cy + " -> " + JSON.stringify(fix) + " (esperado a/" + esperado + ")");
      });
      const total = Object.keys(objetivo).length;
      resumen.push("pag " + nPag + "  " + v.nombre.padEnd(24) + "  " + ok + "/" + total + " correctas");
      for (const m of malos) resumen.push("      " + m);
      pila.width = 0; pila.height = 0;
    }
    full.width = 0; full.height = 0;
  }
  await w.terminate();
  return resumen;
}, {
  pdfB64: fs.readFileSync(PDF).toString("base64"),
  dump: JSON.parse(fs.readFileSync(path.join(ROOT, "..", "ocr-dump.json"), "utf8")),
  FUENTE, REFINE: 3.5, ESCALA: 4.5, ROT: 90, ESPERADO,
  PSM: { AUTO_PAGE_SEGMENTATION: 3, SINGLE_COLUMN: 4, SINGLE_BLOCK: 6, SPARSE_TEXT: 11 },
});

res.forEach((l) => console.log(l));
await browser.close();
server.close();
