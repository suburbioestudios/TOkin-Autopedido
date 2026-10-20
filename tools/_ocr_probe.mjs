// Reproduce el OCR REAL de la extensión (pdf.js + tesseract, mismos archivos)
// sobre el PDF, sirviendo la carpeta por HTTP para que el worker pueda cargar.
// Sirve para ver palabra por palabra qué lee el OCR, sin tocar nada del repo.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());                       // .../tokinext
const PDF = path.resolve(ROOT, "..", "PEDIDO ARCOR LA PLATA 13 NOV 250926.pdf");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".wasm": "application/wasm", ".json": "application/json", ".gz": "application/gzip", ".pdf": "application/pdf", ".traineddata": "application/octet-stream" };

const server = http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split("?")[0]);
  const f = path.join(ROOT, u);
  if (!f.startsWith(ROOT) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); res.end("no"); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
console.log("sirviendo en http://127.0.0.1:" + port);

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage();
page.on("console", (m) => { const t = m.text(); if (/tesseract|error|Error/.test(t)) console.log("  [page]", t.slice(0, 160)); });
await page.goto("http://127.0.0.1:" + port + "/tools/_ocr_scratch.html");
await page.waitForFunction(() => window.__ready === true, null, { timeout: 30000 });

const escala = Number(process.argv[2] || 4.5);
const rot = Number(process.argv[3] || 90);
const soloPag = Number(process.argv[4] || 0);
console.log("OCR con escala " + escala + " y rotación " + rot + "…");

const res = await page.evaluate(async ({ pdfB64, escala, rot, soloPag }) => {
  const bin = atob(pdfB64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const pdf = await window.pdfjsLib.getDocument({ data: u8 }).promise;
  const out = { paginas: [] };
  const w = await window.Tesseract.createWorker({ workerBlobURL: false, workerPath: "/extension/lib/tesseract/worker.min.js", corePath: "/extension/lib/tesseract/tesseract-core.wasm.js", langPath: "/extension/lib/tesseract/lang/", logger: () => {} });
  await w.loadLanguage("spa"); await w.initialize("spa");
  for (let p = 1; p <= pdf.numPages; p++) {
    if (soloPag && p !== soloPag) continue;
    const pg = await pdf.getPage(p);
    const vp = pg.getViewport({ scale: escala, rotation: rot });
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const { data } = await w.recognize(cv);
    out.paginas.push({
      n: p, w: cv.width, h: cv.height, conf: data.confidence,
      text: data.text,
      words: (data.words || []).filter((x) => String(x.text || "").trim()).map((x) => ({ t: x.text, x0: x.bbox.x0, y0: x.bbox.y0, x1: x.bbox.x1, y1: x.bbox.y1, c: x.confidence })),
    });
  }
  await w.terminate();
  return out;
}, { pdfB64: fs.readFileSync(PDF).toString("base64"), escala, rot, soloPag });

fs.writeFileSync(path.join(ROOT, "..", "ocr-dump.json"), JSON.stringify(res, null, 1));
for (const p of res.paginas) {
  console.log("\n=== página " + p.n + " (" + p.w + "x" + p.h + ") conf=" + Math.round(p.conf) + " palabras=" + p.words.length + " ===");
  console.log(p.text);
}
await browser.close();
server.close();
console.log("\n(guarde ocr-dump.json junto al PDF)");
