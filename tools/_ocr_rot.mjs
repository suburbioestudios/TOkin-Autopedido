// ¿Cuál rotación es la correcta? OCR de la página 1 en los 4 ángulos, para ver
// cuál da texto legible. Mismo pdf.js + tesseract que usa la extensión.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());
const PDF = path.resolve(ROOT, "..", "PEDIDO ARCOR LA PLATA 13 NOV 250926.pdf");
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

const escala = Number(process.argv[2] || 4.5);
const r = await page.evaluate(async ({ pdfB64, escala }) => {
  const bin = atob(pdfB64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const pdf = await window.pdfjsLib.getDocument({ data: u8 }).promise;
  const w = await window.Tesseract.createWorker({ workerBlobURL: false, workerPath: "/extension/lib/tesseract/worker.min.js", corePath: "/extension/lib/tesseract/tesseract-core.wasm.js", langPath: "/extension/lib/tesseract/lang/", logger: () => {} });
  await w.loadLanguage("spa"); await w.initialize("spa");
  const salida = [];
  for (const rot of [0, 90, 180, 270]) {
    const pg = await pdf.getPage(1);
    const vp = pg.getViewport({ scale: escala, rotation: rot });
    const cv = document.createElement("canvas");
    cv.width = Math.ceil(vp.width); cv.height = Math.ceil(vp.height);
    const ctx = cv.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, cv.width, cv.height);
    await pg.render({ canvasContext: ctx, viewport: vp }).promise;
    const { data } = await w.recognize(cv);
    salida.push({ rot, conf: data.confidence, text: data.text });
  }
  await w.terminate();
  return salida;
}, { pdfB64: fs.readFileSync(PDF).toString("base64"), escala });

fs.writeFileSync(path.join(ROOT, "..", "rot-dump.json"), JSON.stringify(r, null, 1));
for (const s of r) {
  console.log("\n############ ROTACIÓN " + s.rot + "  conf=" + Math.round(s.conf) + " ############");
  console.log(s.text.split("\n").filter((l) => l.trim()).slice(0, 6).join("\n"));
}
await browser.close();
server.close();
