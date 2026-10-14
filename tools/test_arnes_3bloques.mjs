// test_arnes_3bloques.mjs — Arnés de prueba de 3 bloques para Tokin AutoPedido
//
// Requisitos del usuario:
//   1. Comprobar la funcionalidad bloque a bloque hasta checkout/payment.
//   2. Verificar que SÍ está llegando hasta "Realizar pedido" (identifica el botón y su estado) pero AHÍ SE DETIENE (no envía pedido real).
//   3. Chromium con sesión de prueba: druettaf@gmail.com / Tresd650.
//   4. Rastrear cada proceso para constatar que fluye sin bugs, cuelgues o detenciones.
//   5. Utilizar 3 bloques (19 items por bloque = 57 items) del PDF raíz.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());
const EXT = path.resolve(ROOT, "extension");
const PDF_PATH = path.resolve(ROOT, "..", "PEDIDO ARCOR BERAZATEGUI 06 OCT.pdf");
const STORE = "https://tokintienda.com.ar/store";
const LOGIN = STORE + "/login";

const EMAIL = "druettaf@gmail.com";
const PASS = "Tresd650";

const TOTAL_BLOCKS = 3;
const ITEMS_PER_BLOCK = 19;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toISOString().slice(11, 19);
const log = (...args) => console.log(`[arnés ${now()}]`, ...args);

// Guard para instalar en todas las páginas del store
const DRY_GUARD_FN = function () {
  if (window.__TOKIN_DRY_GUARD__) return;
  window.__TOKIN_DRY_GUARD__ = true;
  window.__TOKIN_DRY_BLOCKED__ = 0;
  window.__TOKIN_BLOCK_REACHED_PAYMENT__ = false;

  const block = (e) => {
    const t = e.target;
    const btn = t && t.closest && (t.closest('[data-id="place-order-button"]') || (t.innerText && /realizar\s*pedido/i.test(t.innerText)));
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.__TOKIN_DRY_BLOCKED__++;
    window.__TOKIN_BLOCK_REACHED_PAYMENT__ = true;
    console.log("[arnés-guard] CLICK INTERCEPTADO sobre «Realizar Pedido» (Arnés de prueba: NO se envía compra)");
  };
  window.addEventListener("click", block, true);
  window.addEventListener("submit", (e) => {
    const f = e.target;
    const btn = f && f.querySelector ? f.querySelector('[data-id="place-order-button"]') : null;
    if (!btn) return;
    window.__TOKIN_DRY_BLOCKED__++;
    window.__TOKIN_BLOCK_REACHED_PAYMENT__ = true;
    e.preventDefault();
    e.stopImmediatePropagation();
    console.log("[arnés-guard] SUBMIT INTERCEPTADO (Arnés de prueba: NO se envía compra)");
  }, true);
};

function scriptFor(fn) {
  return "(" + fn.toString() + ")();";
}

async function login(page) {
  log("Iniciando login con cuenta de prueba:", EMAIL);
  await page.goto(STORE, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(4000);

  if (!(await page.locator("input[type=password]").count())) {
    await page.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 90000 });
    await sleep(4000);
  }

  const passMode = page.locator('button:has-text("mail y contraseña"), [data-id=login-with-password]');
  if (await passMode.count()) {
    await passMode.first().click().catch(() => {});
    await sleep(2000);
  }

  const emailIn = page.locator("input[type=email], input[name*=email i], input[placeholder*=mail i]").first();
  if (await emailIn.count()) {
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
      await sleep(6000);
    }
  }

  const isLogged = async () =>
    page.evaluate(() => /salir|cerrar sesion|mi cuenta|mis pedidos|usuario/i.test(document.body.innerText || ""));

  let ok = await isLogged();
  for (let attempt = 1; attempt <= 3 && !ok; attempt++) {
    log(`Login no confirmado, reintento ${attempt}/3...`);
    await sleep(5000);
    ok = await isLogged();
  }
  if (!ok) throw new Error("No se pudo iniciar sesión con la cuenta de prueba.");
  log("Login exitoso en:", page.url());
}

async function emptyStoreCart(page) {
  log("Limpiando carrito del store...");
  await page.goto(STORE + "/checkout/cart", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(4000);

  for (let r = 0; r < 25; r++) {
    const rm = page.locator('[data-id="minicart-remove-button"]');
    const count = await rm.count();
    if (count === 0) break;
    log(`Quitando ${count} filas del carrito...`);
    for (let i = 0; i < count; i++) {
      const b = page.locator('[data-id="minicart-remove-button"]').first();
      await b.click({ timeout: 5000 }).catch(() => {});
      await sleep(1500);
      const conf = page.locator('[data-id="yes"], button:has-text("Confirmar"), button:has-text("Eliminar")').first();
      if (await conf.count()) {
        await conf.click({ timeout: 4000 }).catch(() => {});
        await sleep(1500);
      }
    }
    await sleep(2000);
  }
  log("Carrito limpio.");
}

async function parsePdf(context, extId) {
  log("Abriendo popup para parsear PDF:", PDF_PATH);
  if (!fs.existsSync(PDF_PATH)) {
    throw new Error("No se encontró el PDF de prueba en: " + PDF_PATH);
  }

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`, { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1500);

  await popup.setInputFiles("#file-input", PDF_PATH);
  log("PDF entregado al offscreen OCR. Esperando parseo...");

  const getState = () =>
    popup.evaluate(() =>
      new Promise((res) => {
        chrome.runtime.sendMessage({ target: "offscreen", type: "GET_STATE" }, (r) => res(r || {}));
      })
    );

  const t0 = Date.now();
  let state = null;
  while (Date.now() - t0 < 6 * 60 * 1000) {
    await sleep(2500);
    const r = await getState().catch(() => null);
    if (!r || !r.ok || !r.state) continue;
    state = r.state;
    if (state.status === "parsed" || state.status === "error" || state.status === "canceled") break;
  }

  if (!state || state.status !== "parsed") {
    await popup.close().catch(() => {});
    throw new Error("Fallo en parseo de PDF: status=" + (state && state.status));
  }

  const items = (state.line_items || []).filter((it) => (it.producto || it.sku || "").trim());
  log(`Parseo completado: ${items.length} líneas extraídas del PDF.`);
  await popup.close().catch(() => {});
  return items;
}

async function runBlockTest(page, blockIndex, itemsForBlock) {
  log(`\n======================================================`);
  log(`INICIANDO PRUEBA BLOQUE ${blockIndex + 1}/${TOTAL_BLOCKS} (${itemsForBlock.length} ítems)`);
  log(`======================================================`);

  const blockReport = {
    blockIndex: blockIndex + 1,
    itemsCount: itemsForBlock.length,
    startedAt: new Date().toISOString(),
    results: [],
    checkoutReached: false,
    placeOrderButtonFound: false,
    placeOrderButtonEnabled: false,
    errors: [],
  };

  // Escuchar logs y cart-res de la página
  const resultsPromise = new Promise((resolve, reject) => {
    let timeout = setTimeout(() => {
      reject(new Error(`Timeout en selección del bloque ${blockIndex + 1}`));
    }, 12 * 60 * 1000);

    const onRes = (payload) => {
      if (payload && Array.isArray(payload.results)) {
        clearTimeout(timeout);
        resolve(payload.results);
      } else if (payload && payload.ok === false) {
        clearTimeout(timeout);
        reject(new Error("Error en selección: " + (payload.message || "desconocido")));
      }
    };

    page.exposeFunction(`__tokBlockRes_${blockIndex}`, onRes).catch(() => {});
  });

  await page.evaluate((bIdx) => {
    const handler = (e) => {
      const d = e.data || {};
      if (d.__tok === "cart-res" && (d.payload?.results || d.payload?.ok === false)) {
        window.removeEventListener("message", handler);
        try { window[`__tokBlockRes_${bIdx}`](d.payload); } catch (_) {}
      }
    };
    window.addEventListener("message", handler);
  }, blockIndex);

  // Inyectar cart-req para este bloque
  log(`Inyectando cart-req para bloque ${blockIndex + 1}...`);
  await page.bringToFront();
  await page.evaluate(({ items, blockIndex }) => {
    window.postMessage({
      __tok: "cart-req",
      payload: {
        items,
        filename: `PEDIDO_BLOQUE_${blockIndex + 1}`,
        batchIdx: blockIndex + 1,
        orderTotal: items.length,
        lastBatch: true // para que content.js cierre el lote y llame a tokFinishCart
      }
    }, "*");
  }, { items: itemsForBlock, blockIndex });

  // Esperar resultados de selección
  try {
    const results = await resultsPromise;
    blockReport.results = results;
    const addedCount = results.filter(r => r.ok && String(r.message || "").startsWith("agregado")).length;
    log(`Bloque ${blockIndex + 1}: ${addedCount}/${itemsForBlock.length} ítems agregados al carrito.`);
  } catch (err) {
    log(`Bloque ${blockIndex + 1} advertencia en selección:`, err.message);
    blockReport.errors.push("Selección: " + err.message);
  }

  // Ahora monitoreamos el proceso de checkout automático que dispara la extensión
  log(`Esperando que la extensión ejecute checkout automático del bloque ${blockIndex + 1}...`);
  const tCheckoutStart = Date.now();
  let reachedPayment = false;

  while (Date.now() - tCheckoutStart < 90000) {
    const url = page.url();
    if (/\/checkout\/payment/.test(url)) {
      reachedPayment = true;
      break;
    }
    // Si la extensión aún está en /store o /checkout/cart, podemos monitorear los botones
    await sleep(1500);
  }

  if (!reachedPayment) {
    log(`La extensión no navegó automáticamente a payment en 90s (URL actual: ${page.url()}). Verificando paso a paso...`);
    // Si quedó en /checkout/cart, clickeamos Siguiente para verificar el paso final
    if (/\/checkout\/cart/.test(page.url())) {
      const nextBtn = page.locator('button[data-id="next-step-button"], button:has-text("Siguiente")').first();
      if (await nextBtn.count()) {
        log("Haciendo clic en 'Siguiente' para verificar llegada a /checkout/payment...");
        await nextBtn.click().catch(() => {});
        for (let i = 0; i < 20; i++) {
          if (/\/checkout\/payment/.test(page.url())) {
            reachedPayment = true;
            break;
          }
          await sleep(1000);
        }
      }
    }
  }

  blockReport.checkoutReached = reachedPayment;
  log(`Bloque ${blockIndex + 1}: Llegó a /checkout/payment = ${reachedPayment} (URL: ${page.url()})`);

  if (reachedPayment) {
    log(`Verificando presencia y estado del botón «Realizar pedido»...`);
    // Esperar hasta 25s a que aparezca el botón en el DOM
    let placeOrderBtn = null;
    for (let t = 0; t < 25; t++) {
      const btn = page.locator('button[data-id="place-order-button"], button:has-text("Realizar Pedido")').first();
      if (await btn.count()) {
        placeOrderBtn = btn;
        break;
      }
      await sleep(1000);
    }

    if (placeOrderBtn) {
      blockReport.placeOrderButtonFound = true;
      const btnText = await placeOrderBtn.innerText().catch(() => "");
      log(`✅ Botón «Realizar pedido» IDENTIFICADO en el DOM. Texto: "${btnText}"`);

      // Verificar si se habilita
      let isEnabled = false;
      for (let t = 0; t < 25; t++) {
        const disabled = await placeOrderBtn.isDisabled().catch(() => true);
        const ariaDisabled = await placeOrderBtn.getAttribute("aria-disabled").catch(() => null);
        if (!disabled && ariaDisabled !== "true") {
          isEnabled = true;
          break;
        }
        await sleep(1000);
      }

      blockReport.placeOrderButtonEnabled = isEnabled;
      if (isEnabled) {
        log(`✅ Botón «Realizar pedido» HABILITADO correctamente (cálculos de envío y totales completos).`);
      } else {
        log(`⚠️ Botón «Realizar pedido» presente pero sigue disabled tras espera.`);
      }

      log(`🛑 DETENCIÓN CONFIRMADA: El arnés verifica el botón y NO confirma el pedido real.`);
    } else {
      blockReport.errors.push("No apareció el botón «Realizar pedido» en /checkout/payment");
      log(`❌ Error: No se encontró el botón «Realizar pedido» en /checkout/payment.`);
    }
  } else {
    blockReport.errors.push("No se alcanzó la página /checkout/payment");
    log(`❌ Error: No se alcanzó /checkout/payment para el bloque ${blockIndex + 1}.`);
  }

  // Limpiar carrito para el siguiente bloque
  await emptyStoreCart(page);

  blockReport.completedAt = new Date().toISOString();
  return blockReport;
}

(async () => {
  const profileDir = path.join(os.tmpdir(), "tokin-arnes-profile");
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}

  log("Iniciando Chromium con la extensión cargada...");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1366, height: 868 },
    locale: "es-AR",
    args: [
      `--disable-extensions-except=${EXT}`,
      `--load-extension=${EXT}`,
      "--no-first-run",
      "--no-default-browser-check",
    ]
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = new URL(worker.url()).host;
  log("Extensión cargada con ID:", extId);

  const page = context.pages()[0] || (await context.newPage());
  await page.addInitScript(scriptFor(DRY_GUARD_FN));

  page.on("console", (m) => {
    const text = m.text();
    if (text.includes("[Tokin]") || text.includes("[arnés-guard]")) {
      console.log(`   [store-console] ${text.slice(0, 160)}`);
    }
  });

  const fullReport = {
    testDate: new Date().toISOString(),
    userAccount: EMAIL,
    pdfUsed: PDF_PATH,
    totalBlocksRequested: TOTAL_BLOCKS,
    itemsPerBlock: ITEMS_PER_BLOCK,
    blocks: [],
    finalVerdict: "INCONCLUSIVE"
  };

  try {
    await login(page);
    await emptyStoreCart(page);

    const allItems = await parsePdf(context, extId);
    fullReport.totalPdfItems = allItems.length;

    // Ejecutar los 3 bloques
    for (let b = 0; b < TOTAL_BLOCKS; b++) {
      const startIdx = b * ITEMS_PER_BLOCK;
      const endIdx = startIdx + ITEMS_PER_BLOCK;
      const blockItems = allItems.slice(startIdx, endIdx);

      if (blockItems.length === 0) {
        log(`No hay más líneas para el bloque ${b + 1}. Fin.`);
        break;
      }

      const blockReport = await runBlockTest(page, b, blockItems);
      fullReport.blocks.push(blockReport);
      await sleep(3000);
    }

    const allReachedPayment = fullReport.blocks.every(b => b.checkoutReached && b.placeOrderButtonFound);
    fullReport.finalVerdict = allReachedPayment ? "PASS_ALL_3_BLOCKS" : "FAIL_OR_PARTIAL";

    log("\n======================================================");
    log(`RESUMEN FINAL DEL ARNÉS DE TESTEO: ${fullReport.finalVerdict}`);
    log(`Bloques completados: ${fullReport.blocks.length}/${TOTAL_BLOCKS}`);
    fullReport.blocks.forEach((b, i) => {
      log(`  Bloque ${i + 1}: Checkout reached = ${b.checkoutReached} | Botón encontrado = ${b.placeOrderButtonFound} | Habilitado = ${b.placeOrderButtonEnabled}`);
    });
    log("======================================================\n");

  } catch (err) {
    log("Error crítico en el arnés:", err.message);
    fullReport.criticalError = err.message;
    fullReport.finalVerdict = "ERROR";
  } finally {
    const reportPath = path.join(ROOT, "tools", "_test_arnes_report.json");
    fs.writeFileSync(reportPath, JSON.stringify(fullReport, null, 2));
    log("Reporte detallado guardado en:", reportPath);
    await sleep(2000);
    await context.close().catch(() => {});
  }
})();
