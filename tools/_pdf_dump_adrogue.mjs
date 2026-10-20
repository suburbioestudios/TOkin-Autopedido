// Extrae el texto crudo de un PDF usando el pdf.js del proyecto dentro de un
// navegador (no arranca el store): sirve para inspeccionar como vienen los
// bloques del pedido y armar el XLSX de prueba.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const pdfArg = args.find((a) => !a.startsWith("--")) || null;
const PDF = pdfArg
  ? path.resolve(pdfArg)
  : path.resolve(ROOT, "..", "PEDIDO ARCOR ADROGUE 19 OCT.pdf");

const pdfJs = fs.readFileSync(path.join(ROOT, "extension", "lib", "pdf.min.js"), "utf8");
const worker = fs.readFileSync(path.join(ROOT, "extension", "lib", "pdf.worker.min.js"), "utf8");
const data = fs.readFileSync(PDF).toString("base64");

const browser = await chromium.launch();
const page = await browser.newPage();
const workerBlob = "data:text/javascript;base64," + Buffer.from(worker).toString("base64");
await page.setContent(
  `<script>window.__WORKER__=${JSON.stringify(workerBlob)};</script><script>${pdfJs}</script>`,
  { waitUntil: "load" }
);

const out = await page.evaluate(async (b64) => {
  const pdfjs = window.pdfjsLib;
  pdfjs.GlobalWorkerOptions.workerSrc = window.__WORKER__;
  const raw = atob(b64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  const pdf = await pdfjs.getDocument({ data: arr }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const tc = await p.getTextContent();
    pages.push(tc.items.map((it) => it.str).join(" "));
  }
  return { numPages: pdf.numPages, pages };
}, data);

console.log("PAGINAS:", out.numPages, "| PDF:", PDF);
fs.writeFileSync(path.join(ROOT, "tools", "_adrogue_raw_pages.json"), JSON.stringify(out, null, 2));
out.pages.forEach((t, i) => {
  console.log("\n===== PAGE " + (i + 1) + " =====");
  console.log(t);
});

await browser.close();
