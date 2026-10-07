// diag_flujo.mjs — Tokin AutoPedido: harness de diagnóstico de flujo
//
// Detecta DOS clases de bugs reportados por el cliente:
//   1. Productos que entran al carrito SIN estar en el PDF (EXTRA).
//   2. Cantidades que quedan distintas a las del PDF (WRONG_QTY).
//
// Cómo funciona:
//   1. Lanza Chromium con la extensión real (modo unpacked).
//   2. Login automático con cuenta de prueba.
//   3. Parsea el PDF raíz por el popup de la extensión.
//   4. Carga los primeros N lotes (default 2 = ≤38 líneas) por cart-req.
//   5. Guard activo: NUNCA confirma el pedido (bloquea place-order-button).
//   6. Lee el carrito en /checkout/cart después de un settle de 1,5 s
//      para leer el valor server-synced del input (no el valor óptimo del DOM).
//   7. Compara carrito vs PDF → tabla con ✅ OK / ⚠️ WRONG_QTY / ❌ EXTRA / 🔍 FALTANTE.
//   8. Escribe tools/_diag_flujo_report.json.
//
// Flags:
//   --lotes N        primeros N lotes de 19 líneas cada uno (default 2)
//   --pdf <ruta>     PDF de pedido (default: ../PEDIDO ARCOR BERAZATEGUI 06 OCT.pdf)
//   --clear-cart     vacía el carrito antes de empezar
//   --no-close       no cierra el browser al terminar (para inspección manual)
//   --headless       sin ventana
//   --profile <dir>  perfil de Chrome a usar
//
// Cuenta de prueba: druettaf@gmail.com / Tresd650

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());
const EXT  = path.resolve(ROOT, "extension");
const PDF_DEFAULT = path.resolve(ROOT, "..", "PEDIDO ARCOR BERAZATEGUI 06 OCT.pdf");
const STORE = "https://tokintienda.com.ar/store";
const LOGIN = STORE + "/login";

const EMAIL = "druettaf@gmail.com";
const PASS  = "Tresd650";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const OPTS = {
  lotes:    Number(val("--lotes", 2))  || 2,
  pdf:      val("--pdf", PDF_DEFAULT),
  clearCart: has("--clear-cart"),
  noClose:  has("--no-close"),
  headless: has("--headless"),
  profile:  val("--profile", path.join(os.tmpdir(), "tokin-diag-profile")),
};

const LINES_PER_LOTE = 19;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log   = (...a) => console.log("[diag]", ...a);
const now   = () => new Date().toISOString().slice(11, 19);

// ═══════════════════════════════════════════════════════════════ guard seco
// Bloquea cualquier click sobre "Realizar Pedido" — NUNCA confirma el pedido.
const DRY_GUARD = function () {
  if (window.__TOKIN_DRY_GUARD__) return;
  window.__TOKIN_DRY_GUARD__ = true;
  window.__TOKIN_DRY_BLOCKED__ = 0;
  const block = (e) => {
    const btn = e.target && e.target.closest && e.target.closest('[data-id="place-order-button"]');
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.__TOKIN_DRY_BLOCKED__++;
    console.log("[diag] GUARD: click sobre Realizar Pedido BLOQUEADO (diagnóstico, no se envía)");
  };
  window.addEventListener("click",  block, true);
  window.addEventListener("submit", (e) => {
    const btn = e.target && e.target.querySelector ? e.target.querySelector('[data-id="place-order-button"]') : null;
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.__TOKIN_DRY_BLOCKED__++;
    console.log("[diag] GUARD: submit BLOQUEADO (diagnóstico, no se envía)");
  }, true);
};

function scriptFor(fn) { return "(" + fn.toString() + ")();"; }

// ═══════════════════════════════════════════════════════════════ login
async function login(page) {
  log("login:", EMAIL);
  await page.goto(STORE, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(5000);

  if (!(await page.locator("input[type=password]").count())) {
    await page.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 90000 });
    await sleep(4000);
  }

  const passMode = page.locator('button:has-text("mail y contraseña"), [data-id=login-with-password]');
  if (await passMode.count()) {
    await passMode.first().click().catch(() => {});
    await sleep(3000);
  }

  const emailIn = page.locator("input[type=email], input[name*=email i], input[placeholder*=mail i]").first();
  if (!(await emailIn.count())) throw new Error("No encontré el campo de email del login.");
  await emailIn.fill("");
  await emailIn.type(EMAIL, { delay: 40 });
  await sleep(400);

  const emailNext = page.locator("[data-id=email-next-buton]").first();
  for (let t = 0; t < 40; t++) {
    if (!(await emailNext.isDisabled().catch(() => true))) break;
    await sleep(400);
  }
  await emailNext.click({ timeout: 8000 }).catch(() => emailNext.evaluate((el) => el.click()));
  await sleep(3000);

  const passIn = page.locator("input[type=password]").first();
  if (!(await passIn.count())) throw new Error("No apareció el campo de contraseña.");
  await passIn.fill("");
  await passIn.type(PASS, { delay: 40 });
  await sleep(400);

  const submit = page.locator("[data-id=password-next-button]").first();
  if (await submit.count()) {
    for (let t = 0; t < 40; t++) {
      if (!(await submit.isDisabled().catch(() => true))) break;
      await sleep(400);
    }
    await submit.click({ timeout: 8000 }).catch(() => submit.evaluate((el) => el.click()));
  } else {
    await passIn.press("Enter");
  }
  await sleep(7000);

  const logged = async () =>
    page.evaluate(() => /salir|cerrar sesion|mi cuenta|mis pedidos|usuario/i.test(document.body.innerText || ""));
  let okNow = await logged();

  for (let intento = 1; intento <= 4 && !okNow; intento++) {
    log("login NO confirmado (intento " + intento + "/4); espero y reintento.");
    await sleep(10000 * intento);
    const pass = page.locator("input[type=password]");
    if (await pass.count()) {
      await pass.first().fill("");
      await pass.first().type(PASS, { delay: 60 });
      const again = page.locator("[data-id=password-next-button]").first();
      if (await again.count()) {
        for (let t = 0; t < 40; t++) {
          if (!(await again.isDisabled().catch(() => true))) break;
          await sleep(400);
        }
        await again.click({ timeout: 8000 }).catch(() => again.evaluate((el) => el.click()));
      } else {
        await pass.first().press("Enter");
      }
    } else {
      await page.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
      await sleep(4000);
      const em = page.locator("input[type=email], input[name*=email i], input[placeholder*=mail i]").first();
      if (await em.count()) {
        await em.fill("");
        await em.type(EMAIL, { delay: 60 });
        const nx = page.locator("[data-id=email-next-buton]").first();
        if (await nx.count()) {
          for (let t = 0; t < 40; t++) {
            if (!(await nx.isDisabled().catch(() => true))) break;
            await sleep(400);
          }
          await nx.click({ timeout: 8000 }).catch(() => nx.evaluate((el) => el.click()));
        }
        await sleep(4000);
        const pw = page.locator("input[type=password]").first();
        if (await pw.count()) {
          await pw.fill("");
          await pw.type(PASS, { delay: 60 });
          const sub = page.locator("[data-id=password-next-button]").first();
          if (await sub.count()) {
            for (let t = 0; t < 40; t++) {
              if (!(await sub.isDisabled().catch(() => true))) break;
              await sleep(400);
            }
            await sub.click({ timeout: 8000 }).catch(() => sub.evaluate((el) => el.click()));
          }
        }
      }
    }
    await sleep(10000);
    okNow = await logged();
  }

  if (!okNow) throw new Error("No se pudo iniciar sesión (4 intentos). La corrida no sirve.");
  log("login OK ->", page.url());
}

// ═══════════════════════════════════════════════════════════════ vaciar carrito
async function clearCart(page) {
  log("vaciando el carrito del store…");
  await page.goto(STORE + "/checkout/cart", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(6000);
  for (let round = 1; round <= 60; round++) {
    const rm = page.locator('[data-id="minicart-remove-button"]');
    const n  = await rm.count();
    if (!n) break;
    log("quitando " + n + " filas… (ronda " + round + ")");
    for (let i = 0; i < n; i++) {
      await page.locator('[data-id="minicart-remove-button"]').first().click({ timeout: 8000 }).catch(() => {});
      await sleep(2200);
      const conf = page.locator('[data-id="yes"], button:has-text("Confirmar"), button:has-text("Eliminar")').first();
      if (await conf.count()) { await conf.click({ timeout: 5000 }).catch(() => {}); await sleep(1800); }
    }
    await sleep(3000);
    if (!(await page.locator('[data-id="minicart-remove-button"]').count())) break;
  }
  const quedan = await page.locator('[data-id="minicart-remove-button"]').count();
  log("carrito:", quedan ? quedan + " filas SIN quitar (revisar)" : "vacío ✔");
}

// ═══════════════════════════════════════════════════════════════ parseo PDF
async function parseWithExtension(context, extId) {
  const popup = await context.newPage();
  await popup.goto("chrome-extension://" + extId + "/popup/popup.html", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1500);
  log("popup abierto; enviando PDF:", OPTS.pdf);
  await popup.setInputFiles("#file-input", OPTS.pdf);

  const getState = () =>
    popup.evaluate(() =>
      new Promise((res) => {
        chrome.runtime.sendMessage({ target: "offscreen", type: "GET_STATE" }, (r) => res(r || {}));
      })
    );

  const t0 = Date.now();
  let last  = "";
  let state = null;
  while (Date.now() - t0 < 9 * 60 * 1000) {
    await sleep(2500);
    const r = await getState().catch(() => null);
    if (!r || !r.ok || !r.state) continue;
    state = r.state;
    const line = state.status + " | " + ((state.progress && (state.progress.message || state.progress.stage)) || "");
    if (line !== last) { last = line; log("parse:", line); }
    if (state.status === "parsed" || state.status === "error" || state.status === "canceled") break;
  }
  if (!state) throw new Error("El offscreen no respondió GET_STATE.");
  if (state.status !== "parsed") throw new Error("El parseo no terminó: status=" + state.status + " err=" + (state.error || ""));

  const items = (state.line_items || []).filter((it) => (it.producto || it.sku || "").trim());
  log("parse OK:", items.length, "líneas reconocidas.");
  await popup.close().catch(() => {});
  return items;
}

// ═══════════════════════════════════════════════════════════════ selección por lotes
async function runSelectionLotes(page, items, lotes) {
  const limit = lotes * LINES_PER_LOTE;
  const use   = items.slice(0, limit);
  log("cargando lote 1 de " + lotes + " (primeras " + use.length + " líneas de " + items.length + " total)…");

  const collected = [];
  await page.exposeFunction("__tokDiagRes", (payload) => {
    collected.push(payload);
    if (payload && payload.job) {
      process.stdout.write("\r[" + now() + "] línea " + (payload.job.index || 0) + "/" + (payload.job.total || use.length) + "   ");
    }
  }).catch(() => {});

  const collector = () => {
    window.addEventListener("message", (e) => {
      const d = e.data || {};
      if (d.__tok === "cart-res") {
        try { window.__tokDiagRes(d.payload); } catch (_) {}
      }
    });
  };
  await page.addInitScript(collector);
  await page.evaluate(collector);

  // Guard en la pestaña antes de disparar la carga
  await page.addInitScript(scriptFor(DRY_GUARD));
  await page.evaluate(scriptFor(DRY_GUARD)).catch(() => {});

  await page.bringToFront();
  await page.evaluate(({ items, filename }) => {
    window.postMessage(
      { __tok: "cart-req", payload: { items, filename, orderTotal: items.length, lastBatch: true } },
      "*"
    );
  }, { items: use, filename: path.basename(OPTS.pdf) });

  // Esperar al resultado final
  const t0   = Date.now();
  const want  = use.length;
  const TIMEOUT_MS = 90 * 60 * 1000; // 90 min máx

  let ultimaFirma   = "";
  let ultimoCambio  = Date.now();
  let ultimoPrint   = 0;

  while (Date.now() - t0 < TIMEOUT_MS) {
    await sleep(3000);

    // ¿Ya bloqueó el guard? (extensión llegó a "Realizar Pedido")
    const bloqueados = await page.evaluate(() => window.__TOKIN_DRY_BLOCKED__ || 0).catch(() => 0);
    if (bloqueados > 0) {
      log("\nguard activado: la extensión llegó hasta Realizar Pedido y fue bloqueada.");
      break;
    }

    // ¿Tiene resultado final?
    const done = collected.find((p) => p && Array.isArray(p.results) && p.results.length >= want)
      || collected.find((p) => p && p.done === true);
    if (done) {
      if (done.canceled) throw new Error("La extensión ABORTÓ el pedido (canceled=true).");
      process.stdout.write("\n");
      log("selección terminada: " + (done.results || []).length + " resultados.");
      return { results: done.results || [], usedItems: use };
    }

    // Heartbeat
    const info = await page.evaluate(() => {
      const badge = document.querySelector('[data-id="navbar-minicart-button"]');
      const cuenta = badge ? String(badge.innerText || badge.textContent || "").replace(/\s+/g, " ").trim().slice(0, 20) : "?";
      return { url: location.pathname + location.search.slice(0, 44), cuenta };
    }).catch(() => null);

    const firma = (info ? info.url + "|" + info.cuenta : "?");
    if (firma !== ultimaFirma) { ultimaFirma = firma; ultimoCambio = Date.now(); }

    if (Date.now() - ultimoPrint > 12000) {
      ultimoPrint = Date.now();
      process.stdout.write("\r[" + now() + "] carrito=" + (info ? info.cuenta : "?") + " · " + (info ? info.url : "?") + "   ");
    }

    // Sin movimiento 8 min → volcado y salida
    if (Date.now() - ultimoCambio > 8 * 60 * 1000) {
      process.stdout.write("\n");
      log("=== SIN MOVIMIENTO 8 MINUTOS ===");
      const dia = await page.evaluate(() => {
        try { return JSON.parse(sessionStorage.getItem("tokinDiagLog") || "[]"); } catch (e) { return []; }
      }).catch(() => []);
      log("diagnóstico (últimas 20 entradas):");
      (dia || []).slice(-20).forEach((m) => {
        const txt = typeof m === "string" ? m : String((m && (m.msg || m.text)) || "");
        if (txt) log("  [diag]", txt.slice(0, 180));
      });
      break;
    }
  }
  process.stdout.write("\n");
  return { results: collected.flatMap((p) => p.results || []), usedItems: use };
}

// ═══════════════════════════════════════════════════════════════ leer carrito real
// Lee las filas de /checkout/cart DESPUÉS de un settle de 1,5 s para capturar
// el valor server-synced del input (no el valor optimista del DOM).
// Según AGENTS.md: "el debounce completo + respuesta" tarda ~1000 ms + RTT.
// Se espera 1,5 s adicional al llegar a la página para que el store re-renderice.
async function readCartPage(page) {
  log("leyendo carrito en /checkout/cart (settle 1500 ms post-navigate)…");
  await page.goto(STORE + "/checkout/cart", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(6000); // espera inicial de la SPA

  // Settle extra: esperar a que los inputs de cantidad estén visibles y estables
  const inp = page.locator('[data-id="quantity-selector-input"]');
  for (let t = 0; t < 20; t++) {
    if ((await inp.count()) > 0) break;
    await sleep(500);
  }
  await sleep(1500); // settle post-render del server

  const rows = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('article[data-id="cart-product-card"]').forEach((el) => {
      // Código ARC del ítem (ej: "1013357-BU-0")
      const codeEl = el.querySelector('[data-id^="unit-size-ARC-"]');
      const rawCode = codeEl ? String(codeEl.getAttribute("data-id")).replace(/^unit-size-ARC-/, "") : "";

      // Extraer SKU numérico del código (ej: de "1013357-BU-0" el ARC es 1013357, y el SKU del PDF es 13357)
      // La tienda antepone '10' a códigos de 5 cifras o '100' a códigos de 4 cifras.
      let sku = "";
      const mArc = rawCode.match(/^10*(\d{4,6})/);
      if (mArc) {
        sku = mArc[1];
      } else {
        const mDig = rawCode.match(/(\d{4,6})/);
        sku = mDig ? mDig[1] : "";
      }

      // Unidad de venta detectada del código (UN, BU, DI…)
      const unitMatch = rawCode.match(/-([A-Z]{2})-/);
      const unit = unitMatch ? unitMatch[1] : "";

      // Nombre del producto
      const nameEl = el.querySelector('[data-id*="product-name"], h3, h2, .product-name, [class*="name"]');
      const name   = nameEl
        ? String(nameEl.innerText || nameEl.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120)
        : String((el.innerText || el.textContent || "")).replace(/\s+/g, " ").trim().slice(0, 120);

      // Cantidad: se lee del input server-synced
      const qInput = el.querySelector('[data-id="quantity-selector-input"], input[type=number]');
      const qty    = qInput ? (Number(qInput.value) || 0) : 0;

      out.push({ rawCode, sku, unit, name, qty });
    });
    return out;
  });

  log("filas leídas del carrito:", rows.length);
  rows.forEach((r, i) => {
    log(`  [${i + 1}] sku=${r.sku.padEnd(6)} unit=${r.unit.padEnd(3)} qty=${String(r.qty).padEnd(4)} | ${r.name.slice(0, 70)}`);
  });
  return rows;
}

// ═══════════════════════════════════════════════════════════════ comparador
// Cruza las filas del carrito con los ítems del PDF.
function compareCartVsPdf(cartRows, pdfItems) {
  const results = [];

  const pdfBySku = new Map();
  for (const it of pdfItems) {
    const s = String(it.sku || "").replace(/\D/g, "");
    if (s) pdfBySku.set(s, it);
  }

  const matchedSkus = new Set();

  for (const row of cartRows) {
    let cleanSku = String(parseInt(row.sku, 10));
    let pdfIt = pdfBySku.get(cleanSku);
    if (!pdfIt && row.rawCode) {
      // Búsqueda flexible por si el SKU tiene distinto padding
      for (const [sKey, item] of pdfBySku.entries()) {
        if (row.rawCode.includes(sKey)) {
          cleanSku = sKey;
          pdfIt = item;
          break;
        }
      }
    }

    if (!pdfIt) {
      results.push({
        tipo: "EXTRA",
        sku:  row.sku,
        unit: row.unit,
        cartQty: row.qty,
        pdfQty:  null,
        pdfUnidad: null,
        name: row.name,
        rawCode: row.rawCode,
      });
      continue;
    }

    matchedSkus.add(cleanSku);
    const pdfQty   = Number(pdfIt.cantidad) || 0;
    const cartQty  = row.qty;
    const pdfUnit  = String(pdfIt.unidad || pdfIt.categoria || "").toUpperCase().slice(0, 3);

    // Detección de factor de conversión (Display a Unidades)
    // Ej: PDF pide 1 Display y cart tiene 12 UN porque cada Display trae 12 Uds
    const mPack = String(row.name).match(/\(\s*(\d+)\s*(?:Uds|Unidades|uds)\b/i);
    const packFactor = mPack ? parseInt(mPack[1], 10) : 0;
    const isConvEquivalent = (packFactor > 1 && cartQty === (pdfQty * packFactor));

    if (cartQty === pdfQty || isConvEquivalent) {
      results.push({
        tipo: "OK",
        sku: cleanSku,
        unit: row.unit,
        cartQty,
        pdfQty,
        pdfUnidad: pdfUnit,
        name: row.name,
        rawCode: row.rawCode,
        note: isConvEquivalent ? `(convertido: ${pdfQty} ${pdfUnit} = ${cartQty} UN)` : ""
      });
    } else {
      results.push({
        tipo: "WRONG_QTY",
        sku: cleanSku,
        unit: row.unit,
        cartQty,
        pdfQty,
        pdfUnidad: pdfUnit,
        name: row.name,
        rawCode: row.rawCode,
        delta: cartQty - pdfQty,
      });
    }
  }

  // Ítems del PDF que no aparecen en el carrito dentro del scope
  for (const [sku, it] of pdfBySku) {
    if (!matchedSkus.has(sku)) {
      results.push({
        tipo: "FALTANTE",
        sku,
        unit: String(it.unidad || it.categoria || "").toUpperCase().slice(0, 3),
        cartQty: 0,
        pdfQty: Number(it.cantidad) || 0,
        pdfUnidad: String(it.unidad || it.categoria || "").toUpperCase().slice(0, 3),
        name: it.producto || "",
        rawCode: "",
      });
    }
  }

  return results;
}

// ═══════════════════════════════════════════════════════════════ reporte consola
function printReport(comparacion, usedItems) {
  const ICON = { OK: "✅", WRONG_QTY: "⚠️ ", EXTRA: "❌", FALTANTE: "🔍" };
  const totales = { OK: 0, WRONG_QTY: 0, EXTRA: 0, FALTANTE: 0 };

  console.log("\n" + "═".repeat(100));
  console.log("DIAGNÓSTICO CARRITO vs PDF — scope: primeros " + usedItems.length + " ítems del PDF");
  console.log("═".repeat(100));
  console.log(
    "TIPO       SKU    UNIT  CART_QTY  PDF_QTY  DELTA  NOMBRE".padEnd(100)
  );
  console.log("─".repeat(100));

  for (const r of comparacion) {
    totales[r.tipo] = (totales[r.tipo] || 0) + 1;
    const icon  = ICON[r.tipo] || "?";
    const delta = r.delta !== undefined ? (r.delta > 0 ? "+" + r.delta : String(r.delta)) : "-";
    const line = [
      (icon + " " + r.tipo).padEnd(12),
      String(r.sku || "").padEnd(6),
      String(r.unit || "").padEnd(5),
      String(r.cartQty !== null ? r.cartQty : "-").padEnd(9),
      String(r.pdfQty  !== null ? r.pdfQty  : "-").padEnd(8),
      delta.padEnd(6),
      (r.name || "").slice(0, 55),
    ].join(" ");
    console.log(line);

    // Detalle adicional para WRONG_QTY
    if (r.tipo === "WRONG_QTY") {
      console.log(
        "             └─ " +
        `cart tiene ${r.cartQty} ${r.unit || ""}, PDF pide ${r.pdfQty} ${r.pdfUnidad || ""}` +
        (r.delta > 0 ? " → SOBRA " + r.delta : " → FALTAN " + Math.abs(r.delta))
      );
    }
    // Detalle para EXTRA
    if (r.tipo === "EXTRA") {
      console.log("             └─ rawCode=" + r.rawCode + " — NO está en el PDF scope");
    }
  }

  console.log("─".repeat(100));
  console.log(
    `RESUMEN: ✅ OK=${totales.OK}  ⚠️  WRONG_QTY=${totales.WRONG_QTY}  ❌ EXTRA=${totales.EXTRA}  🔍 FALTANTE=${totales.FALTANTE}`
  );
  console.log("═".repeat(100) + "\n");

  return totales;
}

// ═══════════════════════════════════════════════════════════════ main
(async () => {
  if (!fs.existsSync(OPTS.pdf)) {
    throw new Error("No encontré el PDF en: " + OPTS.pdf + "\nUsá --pdf <ruta> para especificarlo.");
  }

  log("PDF:", OPTS.pdf);
  log("Lotes a cargar:", OPTS.lotes, "(", OPTS.lotes * LINES_PER_LOTE, "líneas máx)");
  log("Extensión desde:", EXT);

  // Limpiar el perfil de corridas anteriores
  try { fs.rmSync(OPTS.profile, { recursive: true, force: true }); } catch (e) {}

  const context = await chromium.launchPersistentContext(OPTS.profile, {
    headless: OPTS.headless,
    viewport: null,
    locale: "es-AR",
    acceptDownloads: true,
    args: [
      "--disable-extensions-except=" + EXT,
      "--load-extension=" + EXT,
      "--no-first-run",
      "--no-default-browser-check",
      "--start-maximized",
    ],
  });

  let worker = context.serviceWorkers()[0];
  if (!worker) worker = await context.waitForEvent("serviceworker", { timeout: 20000 });
  const extId = new URL(worker.url()).host;
  log("extension id:", extId);

  const page = context.pages()[0] || (await context.newPage());

  // Escuchar mensajes de la extensión (filtrando los del guard)
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("[Tokin]") || t.includes("[diag]")) {
      console.log("  [ext " + now() + "]", t.replace(/\s+/g, " ").slice(0, 170));
    }
  });

  const report = {
    generatedAt: new Date().toISOString(),
    pdf: path.basename(OPTS.pdf),
    lotes: OPTS.lotes,
    scope: OPTS.lotes * LINES_PER_LOTE,
    pdfItems: [],
    cartRows: [],
    comparacion: [],
    totales: {},
    selectionResults: [],
  };

  try {
    await login(page);

    if (OPTS.clearCart) {
      await clearCart(page);
    }

    // Guard activo desde el inicio
    await page.addInitScript(scriptFor(DRY_GUARD));
    await page.evaluate(scriptFor(DRY_GUARD)).catch(() => {});

    // 1. Parsear el PDF
    const allItems = await parseWithExtension(context, extId);
    report.pdfItems = allItems;

    console.log("\n=== LÍNEAS DEL PDF RECONOCIDAS ===");
    const scope = allItems.slice(0, OPTS.lotes * LINES_PER_LOTE);
    scope.forEach((it, i) => {
      console.log(
        "#" + String(i + 1).padEnd(3) +
        " sku=" + String(it.sku || "").padEnd(7) +
        " cant=" + String(it.cantidad || "").padEnd(5) +
        " unid=" + String(it.unidad || it.categoria || "").padEnd(8) +
        " " + String(it.producto || "").slice(0, 60)
      );
    });
    console.log("(scope: primeras " + scope.length + " de " + allItems.length + " líneas)\n");

    // 2. Cargar el scope por cart-req y esperar al guard o resultado
    const { results: selResults, usedItems } = await runSelectionLotes(page, allItems, OPTS.lotes);
    report.selectionResults = selResults;
    report.usedItems = usedItems;

    // 3. Leer el carrito post-settle
    const cartRows = await readCartPage(page);
    report.cartRows = cartRows;

    // 4. Comparar
    const comparacion = compareCartVsPdf(cartRows, usedItems);
    report.comparacion = comparacion;
    report.totales = printReport(comparacion, usedItems);

    // Detalle de selección para los WRONG_QTY y EXTRA
    const problemas = comparacion.filter((r) => r.tipo !== "OK");
    if (problemas.length > 0) {
      console.log("─── Resultado de selección para los ítems problemáticos ───");
      for (const prob of problemas) {
        const sr = selResults.find((r) => String(r.sku || "").replace(/\D/g, "") === String(prob.sku || "").replace(/\D/g, ""));
        if (sr) {
          console.log(
            "  sku=" + prob.sku.padEnd(7) +
            " [" + prob.tipo + "] mensaje extensión: " + String(sr.message || "").slice(0, 100)
          );
        }
      }
      console.log("");
    }

    // 5. Guardar reporte JSON
    const outPath = path.join(ROOT, "tools", "_diag_flujo_report.json");
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
    log("reporte escrito en:", outPath);
    log("LISTO. El pedido NO se envió (guard activo).");

  } catch (e) {
    console.error("[diag] ERROR:", e && e.message ? e.message : e);
  } finally {
    if (!OPTS.noClose) {
      await sleep(3000);
      await context.close().catch(() => {});
    } else {
      log("--no-close: el browser queda abierto. Cerralo manualmente cuando termines.");
    }
  }

  process.exit(0);
})();
