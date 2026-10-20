// Recorta la celda U.M. (y el contexto xBul/Cant) de renglones concretos y los
// guarda como PNG ampliados, para leer el glifo de verdad y no adivinarlo.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());
const PDF = path.resolve(ROOT, "..", "PEDIDO ARCOR LA PLATA 13 NOV 250926.pdf");
const DUMP = path.resolve(ROOT, "..", "ocr-dump.json");
const OUT = path.resolve(ROOT, "..", "celdas");
fs.mkdirSync(OUT, { recursive: true });

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

// Codigos a recortar: los que el parser marcaria mal + los de referencia.
const OBJETIVO = process.argv[2].split(",");
const ESC_REF = 4.5;
const dump = JSON.parse(fs.readFileSync(DUMP, "utf8"));
const ESC = 14;
const k = ESC / ESC_REF;

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

const consultas = [];
for (const pg of dump.paginas) {
  if (!pg.words.length) continue;
  for (const f of filasDe(pg.words)) {
    const cod = f.ws.filter((w) => (w.x0 + w.x1) / 2 < 300).map((w) => w.t).join("");
    if (OBJETIVO.includes(cod)) consultas.push({ pag: pg.n, cod, y: f.c });
  }
}

const imgs = await page.evaluate(async ({ pdfB64, consultas, ESC, k }) => {
  const bin = atob(pdfB64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  const pdf = await window.pdfjsLib.getDocument({ data: u8 }).promise;
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
  const out = [];
  for (const c of consultas) {
    const cv = await canvasDe(c.pag);
    // Contexto: xBul | U.M. | Cant.Pedida (bandas 885..1130 en escala 4.5)
    const x0 = 880 * k, x1 = 1140 * k;
    const y0 = (c.y - 24) * k, y1 = (c.y + 24) * k;
    const out2 = document.createElement("canvas");
    out2.width = Math.round((x1 - x0) * 1.1); out2.height = Math.round((y1 - y0) * 1.1);
    const ctx = out2.getContext("2d");
    ctx.fillStyle = "#fff"; ctx.fillRect(0, 0, out2.width, out2.height);
    ctx.imageSmoothingQuality = "high";
    ctx.drawImage(cv, x0, y0, x1 - x0, y1 - y0, 0, 0, out2.width, out2.height);
    // Linea divisoria para ubicar donde cae la celda U.M. (banda 985..1050 ref).
    ctx.fillStyle = "#ff0000";
    ctx.fillRect(Math.round((985 - 880) * k * 1.1), 0, 2, out2.height);
    ctx.fillRect(Math.round((1050 - 880) * k * 1.1), 0, 2, out2.height);
    out.push({ cod: c.cod, pag: c.pag, png: out2.toDataURL("image/png") });
  }
  return out;
}, { pdfB64: fs.readFileSync(PDF).toString("base64"), consultas, ESC, k });

for (const im of imgs) {
  const arch = path.join(OUT, "celda_" + im.cod + "_p" + im.pag + ".png");
  fs.writeFileSync(arch, Buffer.from(im.png.split(",")[1], "base64"));
  console.log("guardado " + arch);
}
await browser.close();
server.close();
