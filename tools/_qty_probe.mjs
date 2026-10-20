// Probe vivo: ¿qué hace DE VERDAD el store cuando escribimos una cantidad en el
// input del carrito? Mide la línea de tiempo del valor del input, los requests
// updateCart que salen al server y el valor real tras un RELOAD.
// Uso: node tools/_qty_probe.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());
const STORE = "https://tokintienda.com.ar/store";
const LOGIN = STORE + "/login";
const EMAIL = "druettaf@gmail.com";
const PASS = "Tresd650";
const QS = process.argv.includes("--q") ? process.argv[process.argv.indexOf("--q") + 1] : "arcor";
const CANT = Number(process.argv.includes("--cant") ? process.argv[process.argv.indexOf("--cant") + 1] : 4);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[probe]", ...a);

// --- funciones REALES de la extension -------------------------------------
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
const EXT_FN = [
  "async function toksleep(ms){ return new Promise(r=>setTimeout(r,ms)); }",
  extractFunction(contentSrc, "tokSetValue"),
  extractFunction(contentSrc, "tokTypeInto"),
  extractFunction(contentSrc, "tokCartSetQty"),
].join("\n");

// ------------------------------------------------------------------ login
async function login(page) {
  log("login…");
  await page.goto(STORE, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(5000);
  if (!(await page.locator("input[type=password]").count())) {
    await page.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 90000 });
    await sleep(4000);
  }
  const passMode = page.locator('button:has-text("mail y contraseña"), [data-id=login-with-password]');
  if (await passMode.count()) { await passMode.first().click().catch(() => {}); await sleep(3000); }
  const emailIn = page.locator("input[type=email], input[name*=email i], input[placeholder*=mail i]").first();
  await emailIn.fill("");
  await emailIn.type(EMAIL, { delay: 40 });
  await sleep(400);
  const emailNext = page.locator("[data-id=email-next-buton]").first();
  for (let t = 0; t < 40; t++) { if (!(await emailNext.isDisabled().catch(() => true))) break; await sleep(400); }
  await emailNext.click({ timeout: 8000 }).catch(() => emailNext.evaluate((el) => el.click()));
  await sleep(3000);
  const passIn = page.locator("input[type=password]").first();
  if (!(await passIn.count())) throw new Error("sin campo password");
  await passIn.fill("");
  await passIn.type(PASS, { delay: 40 });
  await sleep(400);
  const submit = page.locator("[data-id=password-next-button]").first();
  if (await submit.count()) {
    for (let t = 0; t < 40; t++) { if (!(await submit.isDisabled().catch(() => true))) break; await sleep(400); }
    await submit.click({ timeout: 8000 }).catch(() => submit.evaluate((el) => el.click()));
  } else await passIn.press("Enter");
  await sleep(8000);
  const ok = await page.evaluate(() => /salir|cerrar sesion|mi cuenta|mis pedidos/i.test(document.body.innerText || ""));
  if (!ok) throw new Error("login no confirmado");
  log("login OK");
}

const profile = path.join(os.tmpdir(), "tokin-qty-probe");
const ctx = await chromium.launchPersistentContext(profile, {
  headless: false,
  viewport: null,
  args: ["--no-first-run", "--no-default-browser-check"],
});
const page = ctx.pages()[0] || (await ctx.newPage());

const net = [];
page.on("request", (r) => {
  const u = r.url();
  if (/tokin|updateCart|getCart|cart/i.test(u)) {
    const b = (r.postData() || "").slice(0, 500);
    net.push({ t: Date.now(), k: "REQ", u: u.replace(/^https?:\/\//, ""), b });
    log("REQ", u.replace(/^https?:\/\/[^/]+/, ""), b ? b.slice(0, 260) : "");
  }
});
page.on("response", async (r) => {
  const u = r.url();
  if (/tokin|updateCart|getCart/i.test(u)) {
    let b = "";
    try { b = (await r.text()).slice(0, 700); } catch (e) {}
    net.push({ t: Date.now(), k: "RES", s: r.status(), u: u.replace(/^https?:\/\//, ""), b });
    log("RES", r.status(), u.replace(/^https?:\/\/[^/]+/, ""), b.slice(0, 300));
  }
});

try {
  await login(page);

  // --- busco una card y la agrego ------------------------------------------
  await page.goto(STORE + "/store/search?q=" + encodeURIComponent(QS), { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
  await page.goto("https://tokintienda.com.ar/store/search?q=" + encodeURIComponent(QS), { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(6000);
  const cardInfo = await page.evaluate(() => {
    for (const a of document.querySelectorAll("article")) {
      if (a.getAttribute("data-id") === "cart-product-card") continue;
      const add = a.querySelector("[data-id=add-to-cart-button]");
      const sel = a.querySelector("[data-id=sku-selector-button]");
      if (add || sel) return { text: (a.innerText || "").replace(/\s+/g, " ").slice(0, 120), hasAdd: !!add, hasSel: !!sel };
    }
    return null;
  });
  log("card encontrada:", JSON.stringify(cardInfo));
  if (!cardInfo) throw new Error("no hay cards en la busqueda");

  await page.evaluate(() => {
    for (const a of document.querySelectorAll("article")) {
      if (a.getAttribute("data-id") === "cart-product-card") continue;
      const sel = a.querySelector("[data-id=sku-selector-button]");
      const add = a.querySelector("[data-id=add-to-cart-button]");
      if (sel) { sel.click(); return "sel"; }
      if (add) { add.click(); return "add"; }
    }
    return "none";
  });
  await sleep(2500);
  // por si el click de unidad solo selecciona y falta el alta
  await page.evaluate(() => {
    const b = document.querySelector("[data-id=add-to-cart-button]");
    if (b && !b.disabled) b.click();
  });
  await sleep(3000);

  // --- abro el drawer -------------------------------------------------------
  const drawer = async () => {
    const open = await page.evaluate(() => {
      const cards = document.querySelectorAll("article[data-id=cart-product-card]");
      const vis = Array.from(cards).find((c) => c.offsetParent !== null);
      if (vis) return true;
      const b = document.querySelector("[data-id=navbar-minicart-button]");
      if (b) { b.click(); return "clicked"; }
      return false;
    });
    if (open !== true) await sleep(1500);
    return open;
  };
  await drawer();
  await sleep(1500);

  const findInput = () =>
    page.evaluate(() => {
      for (const el of document.querySelectorAll("article[data-id=cart-product-card]")) {
        const inp = el.querySelector("input[type=number]");
        if (inp) return { text: (el.innerText || "").replace(/\s+/g, " ").slice(0, 90), v: inp.value };
      }
      return null;
    });
  const before = await findInput();
  log("carrito ANTES:", JSON.stringify(before));
  if (!before) throw new Error("no hay input en el carrito");

  // --- escribo la cantidad con la funcion REAL de la extension --------------
  log("escribiendo " + CANT + " con tokCartSetQty…");
  const t0 = Date.now();
  const returned = await page.evaluate(async ({ src, cant }) => {
    const F = new Function(src + "\nreturn { tokSetValue, tokTypeInto, tokCartSetQty };")();
    let inp = null;
    for (const el of document.querySelectorAll("article[data-id=cart-product-card]")) {
      const i = el.querySelector("input[type=number]");
      if (i) { inp = i; break; }
    }
    if (!inp) return { err: "sin input" };
    const out = await F.tokCartSetQty(inp, cant);
    return { ret: out, dom: inp.value };
  }, { src: EXT_FN, cant: CANT });
  log("tokCartSetQty devolvió", JSON.stringify(returned), "en", Date.now() - t0, "ms");

  // --- línea de tiempo del valor ------------------------------------------
  const sample = async (label) => {
    const v = await page.evaluate(() => {
      const arr = [];
      for (const el of document.querySelectorAll("article[data-id=cart-product-card]")) {
        const inp = el.querySelector("input[type=number]");
        if (inp) arr.push(inp.value);
      }
      return arr;
    });
    log(label, "t=+" + (Date.now() - t0) + "ms inputs=", JSON.stringify(v));
    return v;
  };
  for (const ms of [400, 900, 1300, 2000, 3000]) {
    const elapsed = Date.now() - t0;
    if (ms > elapsed) await sleep(ms - elapsed);
    await sample("muestra");
  }

  // --- cierro el drawer (como hace la extension) y espero -------------------
  await page.evaluate(() => { const c = document.querySelector("[data-id=minicart-close-drawer-button]"); if (c) c.click(); });
  log("drawer cerrado");
  await sleep(4000);
  await drawer();
  await sleep(1500);
  await sample("tras cierre+reapertura");

  // --- VERDAD: recargo la pagina ------------------------------------------
  await page.reload({ waitUntil: "domcontentloaded" });
  await sleep(6000);
  await drawer();
  await sleep(2000);
  const after = await findInput();
  log("VERDAD tras RELOAD:", JSON.stringify(after));

  log("---- requests de esta corrida ----");
  for (const n of net) log(n.k, n.s || "", n.u.slice(0, 90), (n.b || "").slice(0, 220));

  // limpieza: dejo el item en 0
  await page.evaluate(async () => {
    for (const el of document.querySelectorAll("article[data-id=cart-product-card]")) {
      const inp = el.querySelector("input[type=number]");
      if (inp) { const d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value"); d.set.call(inp, "0"); inp.dispatchEvent(new Event("input", { bubbles: true })); inp.dispatchEvent(new Event("change", { bubbles: true })); break; }
    }
  });
  await sleep(3000);
} catch (e) {
  console.log("ERR:", e.message);
} finally {
  try { await ctx.close(); } catch (e) {}
}
