// OCR del PDF real de Adrogué reutilizando EXACTAMENTE los libs del proyecto
// (pdf.js + Tesseract spa) servidos por http local, para volcar el texto y las
// filas por página y así identificar los "bloques" del pedido.
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LIB = path.join(ROOT, "extension", "lib");
const pdfPath = process.argv[2] || path.resolve(ROOT, "..", "PEDIDO ARCOR ADROGUE 19 OCT.pdf");

const MIME = { ".js": "text/javascript", ".gz": "application/gzip", ".mjs": "text/javascript", ".html": "text/html" };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split("?")[0]).replace(/^\/+/, "");
  if (rel === "" || rel === "index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(`<!doctype html><meta charset="utf-8"><script src="/tesseract/tesseract.min.js"></script><script src="/pdf.min.js"></script>`);
    return;
  }
  const file = path.join(LIB, rel);
  if (!file.startsWith(LIB) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("nf"); return;
  }
  res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const PORT = server.address().port;
const base = `http://127.0.0.1:${PORT}/`;

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(base, { waitUntil: "load" });

const pdfB64 = fs.readFileSync(pdfPath).toString("base64");
const res = await page.evaluate(async ({ pdfB64, base }) => {
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = base + "pdf.worker.min.js";
  const raw = atob(pdfB64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  const pdf = await pdfjs.getDocument({ data: arr }).promise;
  const Tesseract = window.Tesseract;
  const worker = await Tesseract.createWorker({
    workerBlobURL: false,
    workerPath: base + "tesseract/worker.min.js",
    corePath: base + "tesseract/tesseract-core.wasm.js",
    langPath: base + "tesseract/lang/",
    logger: () => {},
  });
  await worker.loadLanguage("spa");
  await worker.initialize("spa");
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const viewport = p.getViewport({ scale: 3, rotation: 90 });
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    await p.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    const r = await worker.recognize(canvas);
    out.push({ page: i, text: r.data.text });
    canvas.width = 0; canvas.height = 0;
  }
  await worker.terminate();
  return out;
}, { pdfB64, base });

await browser.close();
server.close();

fs.writeFileSync(path.join(ROOT, "tools", "_ocr_pages.json"), JSON.stringify(res, null, 2));
for (const pg of res) {
  console.log("\n===== PAGE " + pg.page + " =====");
  console.log(pg.text);
}
