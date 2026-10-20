// Reproduce la CARRERA del alta: la extension agrega el producto (addItems) y
// escribe la cantidad en el carrito ANTES de que esa mutacion responda. El
// re-render del store puede resetear el input a 1 y cancelar el debounce de
// 1000ms de updateCart -> el carrito queda en 1 aunque el DOM diga otra cosa.
// Compara la funcion ACTUAL de la extension con una version con re-intento +
// espera del debounce.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());
const STORE = "https://tokintienda.com.ar/store";
const LOGIN = STORE + "/login";
const EMAIL = "druettaf@gmail.com";
const PASS = "Tresd650";
const QS = "arcor";
const CANT = 4;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[probe]", ...a);

const contentSrc = fs.readFileSync(path.join(ROOT, "extension", "content.js"), "utf8");
function extractFunction(from, name) {
  const start = from.search(new RegExp("(async\\s+)?function\\s+" + name + "\\s*\\("));
  if (start < 0) throw new Error("no encontre " + name);
  let i = from.indexOf("{", start), depth = 0, prev = "";
  for (; i < from.length; i++) {
    const ch = from[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch; i++;
      while (i < from.length) {
        if (from[i] === "\\") { i++; continue; }
        if (from[i] === q) break;
        i++;
      }
      prev = q; continue;
    }
    if (ch === "/" && from[i + 1] === "/") { while (i < from.length && from[i] !== "\n") i++; continue; }
    if (ch === "/" && from[i + 1] === "*") { i = from.indexOf("*/", i) + 1; continue; }
    if (ch === "/") {
      if ("([{,;:=!&|?+-*%<>~^".includes(prev)) {
        i++; let inClass = false;
        while (i < from.length) {
          if (from[i] === "\\") { i += 2; continue; }
          if (from[i] === "[") inClass = true;
          else if (from[i] === "]" && !inClass) break;
          else if (from[i] === "/" && !inClass) break;
          i++;
        }
      }
      prev = "/"; continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return from.slice(start, i + 1); }
    prev = ch;
  }
  throw new Error("sin cerrar " + name);
}
const BASE = [
  "async function toksleep(ms){ return new Promise(r=>setTimeout(r,ms)); }",
  extractFunction(contentSrc, "tokSetValue"),
  extractFunction(contentSrc, "tokTypeInto"),
].join("\n");
const ORIGINAL = BASE + "\n" + extractFunction(contentSrc, "tokCartSetQty");
const FIXED = BASE + `
// v2.0.98: espera el debounce de 1000ms del store (post-server) y reintenta si
// el re-render del carrito cancelo el updateCart pendiente.
async function tokCartSetQty(cartInp, wantQty) {
  if (!cartInp) return null;
  let last = null;
  for (let intento = 0; intento < 3; intento++) {
    await tokTypeInto(cartInp, wantQty);
    await toksleep(1600);
    let v = parseInt(String(cartInp.value || "").replace(/\\D+/g, ""), 10);
    if (isNaN(v) || v !== wantQty) {
      await toksleep(500);
      v = parseInt(String(cartInp.value || "").replace(/\\D+/g, ""), 10);
    }
    last = isNaN(v) ? null : v;
    if (last === wantQty) break;
  }
  return last;
}`;

const profile = path.join(os.tmpdir(), "tokin-qty-race");
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: null,
  args: ["--no-first-run", "--no-default-browser-check"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

const start = Date.now();
page.on("request", (r) => {
  if (/updateCart/i.test(r.url()) && !/analytics/.test(r.url())) {
    const b = (r.postData() || "");
    const qty = (b.match(/"variantQty":(\d+)/) || [])[1];
    const op = (b.match(/"operation":"(\w+)/) || [])[1];
    log("  net REQ updateCart op=" + op + " qty=" + qty + " t=" + (Date.now() - start));
  }
});
page.on("response", (r) => {
  if (/updateCart/i.test(r.url()) && !/analytics/.test(r.url())) {
    log("  net RES updateCart status=" + r.status() + " t=" + (Date.now() - start));
  }
});

async function login() {
  const SE = 'button:has-text("mail y contraseña"), button:has-text("Ingresar"), [data-id=login-with-password]';
  for (let intento = 0; intento < 3; intento++) {
    await page.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
    await sleep(5000);
    // la tienda a veces redirige a /store/home con el login embebido
    const pm = page.locator(SE);
    if (await pm.count()) {
      await pm.first().click({ timeout: 8000 }).catch(() => pm.first().evaluate((el) => el.click()));
      await sleep(4000);
    }
    const emailIn = page.locator("input[type=email]").first();
    if (await emailIn.count()) {
      await emailIn.fill(""); await emailIn.type(EMAIL, { delay: 40 }); await sleep(400);
      const emailNext = page.locator("[data-id=email-next-buton]").first();
      if (await emailNext.count()) {
        for (let t = 0; t < 40; t++) { if (!(await emailNext.isDisabled().catch(() => true))) break; await sleep(400); }
        await emailNext.click({ timeout: 8000 }).catch(() => emailNext.evaluate((el) => el.click()));
      }
      await sleep(4000);
      const passIn = page.locator("input[type=password]").first();
      if (!(await passIn.count())) throw new Error("sin campo password");
      await passIn.fill(""); await passIn.type(PASS, { delay: 40 }); await sleep(400);
      const submit = page.locator("[data-id=password-next-button], button[type=submit], button:has-text('Ingresar')").first();
      if (await submit.count()) {
        for (let t = 0; t < 40; t++) { if (!(await submit.isDisabled().catch(() => true))) break; await sleep(400); }
        await submit.click({ timeout: 8000 }).catch(() => submit.evaluate((el) => el.click()));
      } else await passIn.press("Enter");
      await sleep(8000);
      if (await page.evaluate(() => /salir|cerrar sesion|mi cuenta|mis pedidos/i.test(document.body.innerText || ""))) {
        log("login OK (url=" + page.url() + ")");
        return;
      }
    }
    log("login intento " + (intento + 1) + " no confirmado; url=" + page.url());
    await sleep(5000);
  }
  throw new Error("login no confirmado");
}

const openSearch = async () => {
  await page.goto("https://tokintienda.com.ar/store/search?q=" + encodeURIComponent(QS), { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(6000);
};

const addFromCard = async () => {
  const r = await page.evaluate(() => {
    for (const a of document.querySelectorAll("article")) {
      if (a.getAttribute("data-id") === "cart-product-card") continue;
      const sel = a.querySelector("[data-id=sku-selector-button]");
      const add = a.querySelector("[data-id=add-to-cart-button]");
      if (sel) { sel.click(); return "sel"; }
      if (add) { add.click(); return "add"; }
    }
    return "none";
  });
  if (r === "sel") {
    await sleep(1500);
    await page.evaluate(() => {
      const b = document.querySelector("[data-id=add-to-cart-button]");
      if (b && !b.disabled) b.click();
    });
  }
  return r;
};

const openDrawer = async () => {
  const vis = await page.evaluate(() =>
    Array.from(document.querySelectorAll("article[data-id=cart-product-card]")).some((c) => c.offsetParent !== null)
  );
  if (!vis) {
    await page.evaluate(() => { const b = document.querySelector("[data-id=navbar-minicart-button]"); if (b) b.click(); });
    await sleep(1200);
  }
};

// Espera el input del carrito y avisa CUANDO aparecio (para medir la carrera).
const waitCartInput = async (label, fromClick) => {
  const t0 = Date.now();
  try {
    await page.waitForSelector("article[data-id=cart-product-card] input[type=number]", { timeout: 8000 });
  } catch (e) {}
  log(label, "input aparecio a +" + Math.round((Date.now() - t0)) + "ms (click hizo +" + Math.round((Date.now() - fromClick)) + "ms)");
};

const readInputs = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll("article[data-id=cart-product-card]")).map((el) => {
      const inp = el.querySelector("input[type=number]");
      return inp ? inp.value : "(sin input)";
    })
  );

const setAndSample = async (src, label) => {
  const ret = await page.evaluate(async ({ src, cant }) => {
    const F = new Function(src + "\nreturn { tokTypeInto, tokCartSetQty, tokSetValue };")();
    let inp = null;
    for (const el of document.querySelectorAll("article[data-id=cart-product-card]")) {
      const i = el.querySelector("input[type=number]");
      if (i) { inp = i; break; }
    }
    if (!inp) return { err: "sin input" };
    const v = await F.tokCartSetQty(inp, cant);
    return { ret: v, dom: inp.value };
  }, { src, cant: CANT });
  log(label, "tokCartSetQty devolvio", ret.ret, "dom=", ret.dom);
  return ret;
};

const clearCartLine = async () => {
  await openDrawer();
  await page.evaluate(async () => {
    for (const el of document.querySelectorAll("article[data-id=cart-product-card]")) {
      const inp = el.querySelector("input[type=number]");
      if (inp) { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"); d.set.call(inp, "0"); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); break; }
    }
  });
  await sleep(3500);
};

const reloadTruth = async () => {
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(6000);
  await openDrawer();
  await sleep(1500);
  return readInputs();
};

try {
  await login();
  await openSearch();
  log(">>> ESCENARIO 1: funcion ACTUAL + carrera (add -> tipo sin esperar respuesta del add)");
  const tClick1 = Date.now();
  await addFromCard();
  await sleep(150); // CARRERA: no espero el addItems
  await openDrawer();
  await waitCartInput("ESC1", tClick1);
  log("inputs tras abrir drawer:", JSON.stringify(await readInputs()));
  await setAndSample(ORIGINAL, "ACTUAL");
  const verdad1 = await reloadTruth();
  log("ESCENARIO 1 -> VERDAD tras reload:", JSON.stringify(verdad1));

  log(">>> limpiando linea");
  await clearCartLine();
  await openSearch();
  await sleep(1500);

  log(">>> ESCENARIO 2: funcion CON reintento/espera de debounce + carrera");
  const tClick2 = Date.now();
  await addFromCard();
  await sleep(150); // misma carrera
  await openDrawer();
  await waitCartInput("ESC2", tClick2);
  log("inputs tras abrir drawer:", JSON.stringify(await readInputs()));
  await setAndSample(FIXED, "FIX");
  const verdad2 = await reloadTruth();
  log("ESCENARIO 2 -> VERDAD tras reload:", JSON.stringify(verdad2));

  log(">>> limpiando linea");
  await clearCartLine();
  await sleep(1500);
} catch (e) {
  console.log("ERR:", e && e.stack ? e.stack.slice(0, 1200) : e);
} finally {
  try { await ctx.close(); } catch (e) {}
}