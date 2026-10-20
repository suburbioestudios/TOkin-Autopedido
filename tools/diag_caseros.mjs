// tools/diag_caseros.mjs — Diagnóstico en vivo contra Tokin Tienda
// Usuario: serhiy.cioccolato@gmail.com / Tokin123
// Archivo: caseros_ultimos_2_bloques.xlsx

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());
const EXT = path.resolve(ROOT, "extension");
const XLSX_PATH = path.resolve(ROOT, "caseros_ultimos_2_bloques.xlsx");
const STORE = "https://tokintienda.com.ar/store";
const LOGIN = STORE + "/login";

const EMAIL = "serhiy.cioccolato@gmail.com";
const PASS = "Tokin123";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);
const log = (...args) => console.log(`[diag ${now()}]`, ...args);

// DRY_GUARD: bloquea cualquier click o submit a "Realizar pedido"
const DRY_GUARD_FN = function () {
  if (window.__TOKIN_DRY_GUARD__) return;
  window.__TOKIN_DRY_GUARD__ = true;
  window.__TOKIN_DRY_BLOCKED__ = 0;

  const block = (e) => {
    const t = e.target;
    const btn = t && t.closest && (t.closest('[data-id="place-order-button"]') || (t.innerText && /realizar\s*pedido/i.test(t.innerText)));
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.__TOKIN_DRY_BLOCKED__++;
    console.log("[GUARD] Click sobre «Realizar Pedido» INTERCEPTADO Y BLOQUEADO (Modo Diagnóstico)");
  };
  window.addEventListener("click", block, true);
  window.addEventListener("submit", (e) => {
    const f = e.target;
    const btn = f && f.querySelector ? f.querySelector('[data-id="place-order-button"]') : null;
    if (!btn) return;
    window.__TOKIN_DRY_BLOCKED__++;
    e.preventDefault();
    e.stopImmediatePropagation();
    console.log("[GUARD] Submit sobre «Realizar Pedido» INTERCEPTADO Y BLOQUEADO (Modo Diagnóstico)");
  }, true);
};

function scriptFor(fn) {
  return "(" + fn.toString() + ")();";
}

async function login(page) {
  log("Iniciando sesión con:", EMAIL);
  await page.goto(STORE, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(4000);

  // Verificar si ya está logueado y con qué usuario
  const bodyText = await page.evaluate(() => document.body.innerText || "");
  const currentEmail = await page.evaluate(() => {
    const m = document.body.innerText.match(/[\w.-]+@[\w.-]+\.\w+/);
    return m ? m[0] : null;
  });
  log("Texto en tienda:", bodyText.slice(0, 100).replace(/\s+/g, " "), "| Email detectado en DOM:", currentEmail);

  if (!(await page.locator("input[type=password]").count())) {
    await page.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 90000 });
    await sleep(4000);
  }

  const passMode = page.locator('button:has-text("mail y contraseña"), [data-id=login-with-password]');
  if (await passMode.count()) {
    log("Seleccionando modo login con contraseña...");
    await passMode.first().click().catch(() => {});
    await sleep(2000);
  }

  const emailIn = page.locator("input[type=email], input[name*=email i], input[placeholder*=mail i]").first();
  if (await emailIn.count()) {
    log("Escribiendo email:", EMAIL);
    await emailIn.fill("");
    await emailIn.type(EMAIL, { delay: 35 });
    await sleep(300);

    const emailNext = page.locator("[data-id=email-next-buton]").first();
    for (let t = 0; t < 30; t++) {
      if (!(await emailNext.isDisabled().catch(() => true))) break;
      await sleep(300);
    }
    await emailNext.click({ timeout: 8000 }).catch(() => emailNext.evaluate((el) => el.click()));
    await sleep(3000);

    const passIn = page.locator("input[type=password]").first();
    if (await passIn.count()) {
      log("Escribiendo contraseña...");
      await passIn.fill("");
      await passIn.type(PASS, { delay: 35 });
      await sleep(300);
      const submit = page.locator("[data-id=password-next-button]").first();
      if (await submit.count()) {
        for (let t = 0; t < 30; t++) {
          if (!(await submit.isDisabled().catch(() => true))) break;
          await sleep(300);
        }
        await submit.click({ timeout: 8000 }).catch(() => submit.evaluate((el) => el.click()));
      } else {
        await passIn.press("Enter");
      }
      await sleep(7000);
    }
  }

  const isLogged = async () =>
    page.evaluate(() => /salir|cerrar sesion|mi cuenta|mis pedidos|usuario/i.test(document.body.innerText || ""));

  let ok = await isLogged();
  for (let attempt = 1; attempt <= 4 && !ok; attempt++) {
    log(`Login no confirmado, reintento ${attempt}/4...`);
    await sleep(5000);
    ok = await isLogged();
  }

  if (!ok) {
    throw new Error("No se pudo iniciar sesión en Tokin con " + EMAIL);
  }
  log("✅ Login exitoso en:", page.url());
}

async function inspectCart(page) {
  log("Inspeccionando estado actual del carrito...");
  await page.goto(STORE + "/checkout/cart", { waitUntil: "domcontentloaded", timeout: 60000 });
  await sleep(4000);

  const cartItems = await page.evaluate(() => {
    const cards = Array.from(document.querySelectorAll("article[data-id=cart-product-card]"));
    return cards.map((c) => {
      const title = c.innerText.slice(0, 60).replace(/\s+/g, " ");
      const inp = c.querySelector("input[type=number]");
      const qty = inp ? inp.value : "?";
      return { title, qty };
    });
  });

  log(`Carrito actual contiene ${cartItems.length} artículos:`, cartItems);
  return cartItems;
}

(async () => {
  log("=== INICIANDO DIAGNÓSTICO EN VIVO CONTRA EL STORE ===");
  log("Usuario:", EMAIL);
  log("Documento:", XLSX_PATH);

  if (!fs.existsSync(XLSX_PATH)) {
    throw new Error("No existe el archivo " + XLSX_PATH);
  }

  // Usar perfil dedicado para el diagnóstico
  const profileDir = path.join(os.tmpdir(), "tokin-diag-caseros-profile");
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}

  log("Lanzando Chromium con extensión Tokin...");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1366, height: 868 },
    locale: "es-AR",
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = new URL(worker.url()).host;
  log("Extensión cargada con ID:", extId);

  const page = context.pages()[0] || (await context.newPage());
  await page.addInitScript(scriptFor(DRY_GUARD_FN));

  // Escuchar logs de consola del content script y la tienda
  const storeLogs = [];
  page.on("console", (m) => {
    const text = m.text();
    storeLogs.push({ time: now(), text });
    if (text.includes("[Tokin]") || text.includes("[GUARD]") || text.includes("error") || text.includes("unit") || text.includes("qty")) {
      console.log(`   [store] ${text.slice(0, 160)}`);
    }
  });

  // Escuchar llamadas de red updateCart
  page.on("request", (req) => {
    const url = req.url();
    if (url.includes("updateCart") || url.includes("addItems") || url.includes("graphql")) {
      const post = req.postData() || "";
      if (post.includes("updateCart") || post.includes("addItems")) {
        log(`[NET REQ] ${url.slice(0, 60)} -> ${post.slice(0, 140)}`);
      }
    }
  });

  try {
    // 1. Iniciar sesión
    await login(page);

    // 2. Inspeccionar carrito existente
    const initialCart = await inspectCart(page);

    // 3. Abrir popup de la extensión para parsear caseros_ultimos_2_bloques.xlsx
    log("Abriendo popup de la extensión...");
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
    await sleep(2000);

    log("Cargando archivo caseros_ultimos_2_bloques.xlsx en el popup...");
    await popup.setInputFiles("#file-input", XLSX_PATH);
    log("Archivo enviado al offscreen parser. Esperando estado...");

    const getState = () =>
      popup.evaluate(() =>
        new Promise((res) => {
          chrome.runtime.sendMessage({ target: "offscreen", type: "GET_STATE" }, (r) => res(r || {}));
        })
      );

    const t0 = Date.now();
    let state = null;
    while (Date.now() - t0 < 60000) {
      await sleep(2000);
      const r = await getState().catch(() => null);
      if (r && r.ok && r.state) {
        state = r.state;
        log("Estado del offscreen:", state.status, (state.progress && state.progress.message) || "");
        if (state.status === "parsed" || state.status === "error") break;
      }
    }

    if (!state || state.status !== "parsed") {
      log("Error o timeout en parseo:", state);
      throw new Error("El documento no se parseó correctamente: " + (state && state.error));
    }

    const items = (state.line_items || []).filter((it) => (it.producto || it.sku || "").trim());
    log(`✅ Documento parseado: ${items.length} líneas detectadas.`);

    // 4. Iniciar la carga del primer bloque hacia la página de la tienda
    await page.bringToFront();
    await page.goto(STORE + "/search?q=mogul", { waitUntil: "domcontentloaded", timeout: 60000 });
    await sleep(3000);

    // Disparar carga del bloque 1 (19 items)
    const block1Items = items.slice(0, 19);
    log(`Inyectando cart-req con los primeros ${block1Items.length} ítems...`);

    const resultsPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Timeout de 15 minutos esperando cart-res")), 15 * 60 * 1000);
      const onRes = (payload) => {
        clearTimeout(timeout);
        resolve(payload);
      };
      page.exposeFunction("__tokDiagRes", onRes).catch(() => {});
    });

    await page.evaluate(() => {
      window.addEventListener("message", (e) => {
        const d = e.data || {};
        if (d.__tok === "cart-res") {
          try { window.__tokDiagRes(d.payload); } catch (_) {}
        }
      });
    });

    await page.evaluate((bItems) => {
      window.postMessage({
        __tok: "cart-req",
        payload: {
          items: bItems,
          filename: "caseros_ultimos_2_bloques.xlsx",
          batchIdx: [0],
          orderTotal: bItems.length,
          lastBatch: false,
        }
      }, "*");
    }, block1Items);

    log("cart-req emitido. Monitoreando ejecución...");

    // Monitorear progreso cada 10 segundos
    const tStart = Date.now();
    let resReceived = null;
    resultsPromise.then((r) => { resReceived = r; }).catch((e) => { resReceived = { error: e.message }; });

    while (!resReceived && Date.now() - tStart < 12 * 60 * 1000) {
      await sleep(10000);
      const curUrl = page.url();
      const statusText = await page.evaluate(() => {
        const toast = document.querySelector("#tokin-toast, [id*=tokin]");
        return toast ? toast.innerText : "";
      }).catch(() => "");
      log(`[monitoreo] URL: ${curUrl.slice(0, 50)} | Toast: "${statusText.slice(0, 80)}"`);
    }

    log("Resultado recibido:", resReceived);

    // Guardar reporte final de diagnóstico
    const reportPath = path.join(ROOT, "tools", "_diag_caseros_report.json");
    fs.writeFileSync(reportPath, JSON.stringify({
      user: EMAIL,
      itemsTotal: items.length,
      block1Items: block1Items.length,
      resReceived,
      storeLogs: storeLogs.slice(-200),
    }, null, 2), "utf8");
    log("Reporte guardado en:", reportPath);

  } catch (err) {
    log("❌ ERROR en diagnóstico:", err.message);
  } finally {
    log("Diagnóstico finalizado.");
  }
})();
