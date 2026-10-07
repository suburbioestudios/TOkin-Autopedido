// Harness "en seco" (dry-run) de Tokin AutoPedido.
//
// Objetivo: correr la lógica REAL de la extensión (mismo parser, mismo
// tokProcessCard del content script) contra la tienda REAL, usando el login del
// usuario de prueba y el PDF de pedido real, SIN enviar el pedido.
//
// Cómo:
//   1. Levanta Chrome con la extensión cargada (unpacked).
//   2. Loguea en tokintienda.com.ar/store con el usuario de prueba.
//   3. Abre el popup de la extensión, le entrega el PDF y espera a que el
//      parser de la extensión (offscreen/agent.js) lo reconozca.
//   4. Toma las líneas reconocidas y las inyecta en la pestaña del store por el
//      canal interno del content script (window.postMessage {__tok:'cart-req'}),
//      que SOLO selecciona y carga al carrito: NUNCA dispara checkout.
//   5. Recorre el checkout a mano (Revisar Pedido -> Siguiente) y se detiene
//      antes de "Realizar Pedido", con un guard que bloquea cualquier click
//      programático sobre ese botón.
//
// Flags:
//   --parse-only      Solo reconoce el PDF y lista las líneas. No toca el store.
//   --blocks N        Usa solo los primeros N lotes (19 líneas por lote).
//   --limit N         Usa solo las primeras N líneas para la selección.
//   --checkout-only   No parsea ni selecciona: solo login + checkout seco del
//                     carrito que ya esté cargado en la cuenta.
//   --full            MODO REAL: la extensión hace el flujo COMPLETO (carga el
//                     lote y su propio checkout Revisar pedido → Siguiente →
//                     Realizar pedido). El guard frena el click final, así que
//                     no se manda ningún pedido. Imprime el paso a paso, las
//                     filas del carrito y los mensajes del diagnóstico.
//   --clear-cart      Vacía el carrito del store antes de empezar (el server).
//   --watch N         Minutos máximos de vigilancia en --full (default 40).
//   --stall N         Minutos sin movimiento antes de volcar el estado y
//                     terminar (default 4).
//   --no-checkout     No recorre el checkout (solo selección + reporte).
//   --headless        Corre sin ventana (la extensión puede no cargar).
//   --profile <dir>   Perfil de Chrome a usar (default: temp/tokin-dry-profile).
//
// Salida: tabla por línea en consola + tools/_dry_run_report.json

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const ROOT = path.resolve(process.cwd());
const EXT = path.resolve(ROOT, "extension");
const PDF = path.resolve(ROOT, "..", "PEDIDO ARCOR LA PLATA 13 NOV 250926.pdf");
const STORE = "https://tokintienda.com.ar/store";
const LOGIN = STORE + "/login";
const CART_URL = STORE + "/cart";

const EMAIL = "druettaf@gmail.com";
const PASS = "Tresd650";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(f);
const val = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const OPTS = {
  parseOnly: has("--parse-only"),
  checkoutOnly: has("--checkout-only"),
  vaciar: has("--vaciar"),
  leerCarrito: has("--leer-carrito"),
  lotes: Number((process.argv.find((a) => a.startsWith("--lotes=")) || "").split("=")[1]) || 1,
  noCheckout: has("--no-checkout"),
  headless: has("--headless"),
  fullFlow: has("--full"),
  clearCart: has("--clear-cart"),
  watchMinutes: Number(val("--watch", 40)) || 40,
  stallMinutes: Number(val("--stall", 4)) || 4,
  lineStallMinutes: Number(val("--line-stall", 3)) || 3,
  limit: Number(val("--limit", 0)) || 0,
  blocks: Number(val("--blocks", 0)) || 0,
  pdf: val("--pdf", PDF),
  profile: val("--profile", path.join(os.tmpdir(), "tokin-dry-profile")),
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log("[dry]", ...a);
const now = () => new Date().toISOString().slice(11, 19);

function requirePdf() {
  if (!fs.existsSync(OPTS.pdf)) {
    throw new Error("No encontré el PDF real del pedido en: " + OPTS.pdf);
  }
}

// ---------------------------------------------------------------- guard seco
// Se instala en cada documento de la pestaña del store. Bloquea en fase de
// captura cualquier click sobre "Realizar Pedido" (el de la extensión usa
// MouseEvent/el.click(), que también dispara listeners del mundo de la página).
const DRY_GUARD = function () {
  if (window.__TOKIN_DRY_GUARD__) return;
  window.__TOKIN_DRY_GUARD__ = true;
  window.__TOKIN_DRY_BLOCKED__ = 0;
  const block = (e) => {
    const t = e.target;
    const btn = t && t.closest && t.closest('[data-id="place-order-button"]');
    if (!btn) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    window.__TOKIN_DRY_BLOCKED__++;
    console.log("[dry] CLICK BLOQUEADO sobre Realizar Pedido (pedido de prueba, no se envía)");
  };
  window.addEventListener("click", block, true);
  window.addEventListener("submit", (e) => {
    // v2.0.96: antes se bloqueaba TODO submit y eso frenaba los formularios del
    // propio store. Sólo se frena el que realmente confirma el pedido.
    const f = e.target;
    const btn = f && f.querySelector ? f.querySelector('[data-id="place-order-button"]') : null;
    if (!btn) return;
    window.__TOKIN_DRY_BLOCKED__++;
    e.preventDefault();
    e.stopImmediatePropagation();
    console.log("[dry] SUBMIT BLOQUEADO (pedido de prueba, no se envía)");
  }, true);
};

function scriptFor(fn) {
  return "(" + fn.toString() + ")();";
}

// ---------------------------------------------------------------- login
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
  // v2.0.96: hasta 4 intentos. Con muchas corridas seguidas la tienda tarda o
  // rechaza el login unos segundos; un solo reintento dejaba tirada la corrida
  // entera y no se distinguía "caída de la tienda" de "mi flujo está roto".
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
      // v2.0.96: goto tolerante a carreras. Con la tienda lenta, el login a
      // veces se resuelve sola y redirige a /home en medio del goto: antes eso
      // tiraba la corrida entera con "Navigation ... interrupted".
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
  if (!okNow) throw new Error("No se pudo iniciar sesión con la cuenta de prueba en 4 intentos; la corrida no sirve.");
  log("login OK ->", page.url());
}

// ---------------------------------------------------------------- parseo
async function parseWithExtension(context, extId) {
  const popup = await context.newPage();
  await popup.goto("chrome-extension://" + extId + "/popup/popup.html", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1500);
  log("popup abierto; enviando PDF a la extensión…");
  await popup.setInputFiles("#file-input", OPTS.pdf);

  const getState = () => popup.evaluate(() =>
    new Promise((res) => {
      chrome.runtime.sendMessage({ target: "offscreen", type: "GET_STATE" }, (r) => res(r || {}));
    })
  );

  const t0 = Date.now();
  let last = "";
  let state = null;
  while (Date.now() - t0 < 9 * 60 * 1000) {
    await sleep(2500);
    const r = await getState().catch(() => null);
    if (!r || !r.ok || !r.state) continue;
    state = r.state;
    const line = state.status + " | " + ((state.progress && (state.progress.message || state.progress.stage)) || "");
    if (line !== last) {
      last = line;
      log("parse:", line);
    }
    if (state.status === "parsed" || state.status === "error" || state.status === "canceled") break;
  }
  if (!state) throw new Error("El offscreen no respondió GET_STATE.");
  if (state.status !== "parsed") throw new Error("El parseo no terminó bien: status=" + state.status + " err=" + (state.error || ""));

  const items = (state.line_items || []).filter((it) => (it.producto || it.sku || "").trim());
  log("parse OK: " + items.length + " líneas reconocidas.");
  await popup.close().catch(() => {});
  return items;
}

// ---------------------------------------------------------------- selección
async function runSelection(page, items, filename) {
  // Recolector de cart-res que sobrevive navegaciones del content script.
  const collected = [];
  await page.exposeFunction("__tokDryRes", (payload) => {
    collected.push(payload);
    if (payload && payload.job) {
      console.log("[" + now() + "] selección: " + (payload.job.index || 0) + "/" + (payload.job.total || items.length));
    }
  }).catch(() => {});
  const collector = () => {
    window.addEventListener("message", (e) => {
      const d = e.data || {};
      if (d.__tok === "cart-res") {
        try { window.__tokDryRes(d.payload); } catch (_) {}
      }
    });
  };
  await page.addInitScript(collector);
  await page.evaluate(collector);

  log("lanzando selección de " + items.length + " líneas por el canal del content script (cart-req)…");
  await page.bringToFront();
  await page.evaluate(({ items, filename }) => {
    window.postMessage(
      { __tok: "cart-req", payload: { items, filename, orderTotal: items.length, lastBatch: true } },
      "*"
    );
  }, { items, filename });

  // Esperar el resumen final (payload con results) o error.
  const t0 = Date.now();
  const want = items.length;
  let final = null;
  // v2.0.96: 145 líneas ≈ 75 min. Con 30 min el harness abortaba a la mitad y
  // el pedido quedaba a medias en el carrito.
  // v2.0.96: heartbeat. Antes este modo no imprimía nada mientras cargaba y
  // un cuelgue se veía como "el log se quedó mudo" sin poder distinguir si
  // avanzaba o estaba clavado. Ahora: índice de la línea + URL + última nota
  // del diagnóstico del content script, y si no se mueve N minutos, volcado.
  let ultimoIdx = -1;
  let ultimoCambio = Date.now();
  let ultimoPrint = 0;
  let ultimaFirma = "";
  while (Date.now() - t0 < 150 * 60 * 1000) {
    await sleep(3000);
    const err = collected.find((p) => p && p.ok === false && !p.job);
    if (err) throw new Error("La selección falló: " + (err.message || JSON.stringify(p0(err))));
    const done = collected.find((p) => p && Array.isArray(p.results) && p.results.length >= want)
      || collected.find((p) => p && p.done === true);
    if (done) {
      // v2.0.96: un ABORTO no es un final. La extensión manda done:true con
      // canceled:true cuando descarta el job; antes el harness lo contaba como
      // "terminó bien" y el pedido truncado pasaba por completo.
      if (done.canceled) throw new Error("La extensión ABORTÓ el pedido (canceled=true) en la línea " + ((done.results || []).length + 1) + " de " + want + ".");
      final = done;
      break;
    }
    const info = await page
      .evaluate(() => {
        // Señales que existen de verdad en el store: el contador del carrito y
        // la URL de búsqueda. El probe por postMessage no es confiable (el
        // content script cambia de documento en cada búsqueda) y con él solo no
        // se podía distinguir "clavado" de "avanzando".
        const badge = document.querySelector('[data-id="navbar-minicart-button"]');
        const cuenta = badge ? String(badge.innerText || badge.textContent || "").replace(/\s+/g, " ").trim().slice(0, 20) : "?";
        let diag = [];
        try { diag = JSON.parse(sessionStorage.getItem("tokinDiagLog") || "[]"); } catch (e) {}
        const ultimo = Array.isArray(diag) && diag.length ? String((diag[diag.length - 1] && (diag[diag.length - 1].msg || diag[diag.length - 1])) || "").slice(0, 110) : "";
        return { url: location.pathname + location.search.slice(0, 44), cuenta: cuenta, ultimo: ultimo };
      })
      .catch(() => null);
    const job = await page.evaluate(() => new Promise((res) => {
      const on = (e) => {
        const d = e.data || {};
        if (d.__tok === "cart-res" && d.payload && d.payload.job !== undefined) {
          window.removeEventListener("message", on);
          res(d.payload.job);
        }
      };
      window.addEventListener("message", on);
      window.postMessage({ __tok: "cart-req", payload: { probe: "cartJob" } }, "*");
      setTimeout(() => { window.removeEventListener("message", on); res(null); }, 5000);
    })).catch(() => null);
    const idx = job ? job.index || 0 : -1;
    const firma = (idx >= 0 ? "i" + idx : "c" + (info ? info.cuenta : "")) + "|" + (info ? info.url : "");
    if (firma !== ultimaFirma) { ultimaFirma = firma; ultimoCambio = Date.now(); }
    if (Date.now() - ultimoPrint > 10000) {
      ultimoPrint = Date.now();
      console.log(
        "[" + now() + "] " + (idx >= 0 ? idx + "/" + (job.total || want) : "línea ?") +
        " · carrito=" + (info ? info.cuenta : "?") +
        " · " + (info ? info.url : "?") +
        (info && info.ultimo ? "\n        " + info.ultimo : "")
      );
    }
    if (Date.now() - ultimoCambio > 6 * 60 * 1000) {
      console.log("\n=== SIN AVANZAR 6 MINUTOS en la línea " + (ultimoIdx + 1) + " ===");
      console.log("url:", info && info.url);
      console.log("trabajo:", JSON.stringify(job && { phase: job.phase, index: job.index, total: job.total, qIdx: job.qIdx, query: job.query, busquedas: job.busquedas }));
      const dia = await page.evaluate(() => { try { return JSON.parse(sessionStorage.getItem("tokinDiagLog") || "[]"); } catch (e) { return []; } }).catch(() => []);
      console.log("diagnóstico (últimos 20):", JSON.stringify((dia || []).slice(-20)).slice(0, 2500));
      throw new Error("La carga se quedó clavada en la línea " + (ultimoIdx + 1) + ".");
    }
  }
  if (!final) throw new Error("Timeout esperando el resultado de la selección.");
  return final.results || final.allResults || [];
}

// ---------------------------------------------------------------- checkout seco
async function dryCheckout(page) {
  log("checkout SECO: Revisar Pedido -> Siguiente -> (freno antes de Realizar Pedido)");
  // Guard seco: se reinstala en cada documento de esta pestaña.
  await page.addInitScript(scriptFor(DRY_GUARD));
  await page.evaluate(scriptFor(DRY_GUARD)).catch(() => {});

  // Camino real: store -> drawer del carrito -> "Revisar Pedido". Navegar
  // directo a /checkout/cart deja el paso siguiente sin estado y no avanza.
  await page.goto(STORE, { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(6000);
  const cartBtn = page.locator("[data-id=navbar-minicart-button]:visible").first();
  if (await cartBtn.count()) { await cartBtn.click().catch(() => {}); await sleep(2000); }
  const revisar = page.locator('[data-id="go-to-checkout-buton"]').first();
  if (await revisar.count()) {
    await revisar.scrollIntoViewIfNeeded().catch(() => {});
    await revisar.click({ timeout: 8000 }).catch(() => revisar.evaluate((el) => el.click()));
    await sleep(6000);
  } else {
    log("no encontré 'Revisar Pedido'; voy directo a /checkout/cart.");
    await page.goto(STORE + "/checkout/cart", { waitUntil: "domcontentloaded", timeout: 90000 });
    await sleep(5000);
  }
  log("URL:", page.url());

  const next = page.locator('button[data-id="next-step-button"]');
  if (!(await next.count())) {
    log("no apareció next-step-button; me quedo en /checkout/cart.");
    return { reachedPayment: false, url: page.url() };
  }
  let nextDisabled = true;
  for (let t = 0; t < 60; t++) {
    nextDisabled = await next.isDisabled().catch(() => true);
    if (!nextDisabled) break;
    await sleep(500);
  }
  log("next-step-button habilitado:", !nextDisabled);
  if (nextDisabled) return { reachedPayment: false, url: page.url(), nextDisabled: true };
  await next.scrollIntoViewIfNeeded().catch(() => {});
  await next.click({ timeout: 8000 }).catch(() => next.evaluate((el) => el.click()));
  for (let t = 0; t < 40; t++) {
    if (/\/checkout\/payment/.test(page.url())) break;
    await sleep(500);
  }
  await sleep(2000);
  log("URL:", page.url());

  const place = page.locator('button[data-id="place-order-button"]');
  const reached = (await place.count()) > 0;
  if (reached) {
    const blocked = await page.evaluate(() => window.__TOKIN_DRY_BLOCKED__ || 0);
    log("place-order-button presenta. NO se clickea. clicks bloqueados hasta ahora: " + blocked);
    // Intento deliberadamente bloquearlo para verificar que el guard responde.
    await page.evaluate(() => {
      const b = document.querySelector('[data-id="place-order-button"]');
      if (b) b.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await sleep(1500);
    const blocked2 = await page.evaluate(() => window.__TOKIN_DRY_BLOCKED__ || 0);
    log("verificación del guard: clicks bloqueados = " + blocked2 + (blocked2 > blocked ? " (OK)" : " (REVISAR)"));
  } else {
    log("ADVERTENCIA: no apareció place-order-button en /checkout/payment.");
  }
  return { reachedPayment: reached };
}

// ---------------------------------------------------------------- observador
// Corre por detrás del flujo REAL de la extensión (el mismo que usa el usuario
// cuando toca «Enviar a carrito») y anota en cada salto: la URL, el paso del
// estado del checkout, lo que muestra el carrito y los mensajes del
// diagnóstico. Sirve para ver DÓNDE se cuelga y si alguna vez se resetea una
// cantidad, sin tocar nada.
const CART_SNAPSHOT = function () {
  // Lectura del carrito tal como la ve la página: name/text de cada fila.
  const out = [];
  const push = (el, code, qty, hasInput) => {
    const name = String((el.innerText || el.textContent || "")).replace(/\s+/g, " ").trim();
    if (!name || name.length > 300) return;
    out.push({ code: code || "", name: name.slice(0, 120), qty: qty || 0, hasInput: !!hasInput });
  };
  document.querySelectorAll('[data-id="cart-product-card"]').forEach((el) => {
    const codeEl = el.querySelector('[data-id^="unit-size-ARC-"]');
    const code = codeEl ? String(codeEl.getAttribute("data-id")).replace(/^unit-size-ARC-/, "") : "";
    const inp = el.querySelector('input[type=number]');
    push(el, code, inp ? Number(inp.value) || 0 : 0, !!inp);
  });
  if (!out.length) {
    // /checkout/payment no tiene cards: se lee el texto del resumen.
    const t = String((document.body && document.body.innerText) || "");
    out.push({ code: "", name: "(resumen del checkout) " + t.replace(/\s+/g, " ").trim().slice(0, 900), qty: 0, hasInput: false });
  }
  return out;
};

// ---------------------------------------------------------------- modo real
// Recorre el flujo REAL de la extensión de punta a punta: la extensión carga el
// lote, dispara su propio checkout (Revisar pedido → Siguiente → Realizar
// pedido) y el guard de arriba le IMPIDE confirmar. Así se puede ver en qué
// punto se cuelga y si el carrito pierde cantidades, sin mandar ningún pedido.
// Lee el carrito REAL del store (solo DOM, no toca nada). Sirve para dos cosas:
//   1) ver qué quedó cargado de corridas anteriores;
//   2) comprobar si la página del carrito muestra las CANTIDADES por producto,
//      que es lo que necesita la verificación de la confirmación.
async function readStoreCart(page, log) {
  let primera = null;
  for (const url of [STORE + "/checkout/cart", CART_URL, STORE + "/checkout/payment"]) {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90000 });
    await sleep(6000);
    const info = await page.evaluate(() => {
      const txt = (e) => (e.innerText || e.textContent || "").replace(/\s+/g, " ").trim();
      const out = { url: location.pathname, title: document.title, rows: [], botones: [], inputs: [] };
      // Anclaje real: cada fila del carrito tiene su botón de quitar.
      const removes = Array.from(document.querySelectorAll('[data-id="minicart-remove-button"]'));
      for (const r of removes) {
        let n = r;
        for (let up = 0; up < 6 && n.parentElement; up++) {
          n = n.parentElement;
          const t = txt(n);
          if (t.length > 12 && t.length < 500 && /\d/.test(t)) break;
        }
        const box = n;
        const inputs = Array.from(box.querySelectorAll("input, select")).map((i) => ({
          tag: i.tagName, id: i.getAttribute("data-id") || "", name: i.name || "",
          value: i.value, min: i.min, max: i.max,
        }));
        const t = txt(box);
        out.rows.push({
          code: (t.match(/ARC-?\d{3,}/i) || [])[0] || "",
          inputs: inputs,
          texto: t.slice(0, 200),
        });
      }
      for (const i of document.querySelectorAll("input, select")) {
        const id = i.getAttribute("data-id") || i.name || "";
        if (!/qty|quantity|cant|stepper|cart/i.test(id + " " + (i.className || ""))) continue;
        out.inputs.push({ tag: i.tagName, id, value: i.value });
      }
      for (const b of document.querySelectorAll("button, a")) {
        const t = txt(b);
        const id = b.getAttribute("data-id") || b.className || "";
        if (!t && !id) continue;
        if (!/vaciar|eliminar|quitar|remove|clear|delete/i.test(t + " " + id)) continue;
        out.botones.push({ texto: t.slice(0, 40), dataId: id.slice(0, 60), tag: b.tagName });
      }
      return out;
    });
    log("--- " + url);
    log("filas detectadas:", info.rows.length);
    info.rows.slice(0, 25).forEach((r) => log("   " + (r.code || "------").padEnd(12) + " inputs=" + JSON.stringify(r.inputs).slice(0, 110) + " " + r.texto.slice(0, 80)));
    if (info.inputs.length) log("controles de cantidad:", JSON.stringify(info.inputs).slice(0, 500));
    // ¿La página muestra el resumen del pedido con cantidades? Sin esto la
    // verificación del paso final no tiene contra qué comparar.
    const sumario = await page.evaluate(() => {
      const t = (document.body.innerText || "").replace(/[ \t]+/g, " ");
      const lineas = t.split("\n").map((s) => s.trim()).filter(Boolean);
      const conCant = lineas.filter((s) => /^\s*\d+\s*x\s+\S/i.test(s) || /\b(unidad|bulto|caja|paquete)s?\b.*\b\d+\b/i.test(s));
      return { total: lineas.length, conCant: conCant.slice(0, 20), muestra: lineas.slice(0, 45) };
    });
    log("líneas de texto en la página:", sumario.total, "| con cantidad explícita:", sumario.conCant.length);
    sumario.muestra.slice(0, 25).forEach((l) => log("      | " + l.slice(0, 110)));
    if (info.botones.length) {
      log("botones de vaciar/quitar:");
      info.botones.slice(0, 6).forEach((b) => log("   <" + b.tag + "> " + b.texto + "  data-id=" + b.dataId));
    }
    // Se recorren LAS TRES páginas: hace falta saber si la del PAGO final muestra
    // las cantidades por producto (si no, la verificación final no tiene contra
    // qué comparar y no puede garantizar que el pedido esté completo).
    if (info.rows.length && !primera) primera = info;
  }
  return primera;
}

async function clearStoreCart(page, log) {
  log("vaciando el carrito del store…");
  // v2.0.96: el store NO tiene botón de "vaciar carrito": hay que quitar cada
  // fila con su botón Eliminar. Se repite hasta que no quede ninguna.
  await page.goto(STORE + "/checkout/cart", { waitUntil: "domcontentloaded", timeout: 90000 });
  await sleep(6000);
  for (let round = 1; round <= 60; round++) {
    const rm = page.locator('[data-id="minicart-remove-button"]');
    const n = await rm.count();
    if (!n) break;
    log("quitando " + n + " filas… (ronda " + round + ")");
    for (let i = 0; i < n; i++) {
      const b = page.locator('[data-id="minicart-remove-button"]').first();
      await b.click({ timeout: 8000 }).catch(() => {});
      await sleep(2200);
      const conf = page.locator('[data-id="yes"], button:has-text("Confirmar"), button:has-text("Eliminar")').first();
      if (await conf.count()) { await conf.click({ timeout: 5000 }).catch(() => {}); await sleep(1800); }
    }
    await sleep(3000);
    if (!(await page.locator('[data-id="minicart-remove-button"]').count())) break;
  }
  const quedan = await page.locator('[data-id="minicart-remove-button"]').count();
  log("carrito:", quedan ? quedan + " filas SIN quitar (revisar)" : "vacío ✔");
  return quedan === 0;
}

async function fullFlowRun(page, context, extId, opts) {
  log("MODO REAL: la extensión hace el checkout sola; el guard frena antes de confirmar.");
  const popup = await context.newPage();
  await popup.goto("chrome-extension://" + extId + "/popup/popup.html", { waitUntil: "domcontentloaded", timeout: 30000 });
  await sleep(1500);

  const ext = (fn, arg) => popup.evaluate(fn, arg);

  const readState = () => ext(() => new Promise((res) => {
    chrome.runtime.sendMessage({ target: "offscreen", type: "GET_STATE" }, (r) => res(r || {}));
  })).catch(() => null);

  const readCheckout = () => ext(() => new Promise((res) => {
    chrome.storage.local.get(["tokinCheckout"], (d) => res((d && d.tokinCheckout) || null));
  })).catch(() => null);

  const readDiag = () => page.evaluate(() => {
    try { return JSON.parse(sessionStorage.getItem("tokinDiagLog") || "[]"); } catch (e) { return []; }
  }).catch(() => []);

  // El trabajo de carga vive en storage.local (lo puede leer el popup).
  const readJob = () => ext(() => new Promise((res) => {
    chrome.storage.local.get(["tokinCartJob"], (d) => res((d && d.tokinCartJob) || null));
  })).catch(() => null);

  // Vaciar el carrito del server antes de empezar: si quedó cargado de una
  // corrida anterior, el lote se apila encima y los conteos no coinciden.
  if (opts.clearCart) await clearStoreCart(page, log);

  // Lanzar el pedido: el PDF entra por el popup y se toca el botón real.
  await page.bringToFront();
  await popup.setInputFiles("#file-input", OPTS.pdf);
  log("PDF entregado; esperando el parseo…");
  const tParse = Date.now();
  let state = null;
  while (Date.now() - tParse < 9 * 60 * 1000) {
    await sleep(2500);
    const r = await readState();
    if (!r || !r.ok || !r.state) continue;
    state = r.state;
    if (state.status === "parsed" || state.status === "error" || state.status === "canceled") break;
  }
  if (!state || state.status !== "parsed") {
    throw new Error("el parseo no terminó: status=" + (state && state.status) + " err=" + ((state && state.error) || ""));
  }
  log("parse OK:", (state.line_items || []).length, "líneas. Tocando «Enviar a carrito»…");

  // El botón real del popup (según la extensión): el que dispara la carga.
  const startBtn = popup.locator('#btn-cart, [data-id="btn-cart"], button:has-text("Enviar al carrito")').first();
  if (!(await startBtn.count())) throw new Error("no encontré el botón de envío del popup");
  await startBtn.click({ timeout: 10000 }).catch(() => startBtn.evaluate((el) => el.click()));

  // Vigilancia: una línea por cada cambio de (status | paso | url | últimas
  // líneas del diagnóstico) y un volcado si nada se mueve.
  const t0 = Date.now();
  const limite = (opts.watchMinutes || 40) * 60 * 1000;
  let ultimo = "";
  let ultimoCambio = Date.now();
  let pasosVistos = [];
  const snapshots = [];
  let ultimoIdx = -1;
  let ultimoQIdx = -1;
  let idxDesde = Date.now();
  let ultimoDiag = 0;
  while (Date.now() - t0 < limite) {
    await sleep(2500);
    const [r, ck, dia, job, cart] = await Promise.all([readState(), readCheckout(), readDiag(), readJob(), page.evaluate(scriptFor(CART_SNAPSHOT)).catch(() => [])]);
    const stt = r && r.ok && r.state ? r.state : null;
    const url = page.url();
    const prog = (stt && stt.progress) || "";
    // El índice del trabajo de carga es la señal clave: si vuelve atrás o el
    // qIdx se reinicia para la misma línea, el job se está reiniciando solo.
    if (job && typeof job.index === "number") {
      if (job.index !== ultimoIdx) {
        if (job.index < ultimoIdx && ultimoIdx >= 0) {
          console.log("   ⚠ REINICIO: el índice del trabajo bajó de " + (ultimoIdx + 1) + " a " + (job.index + 1) + " (la tarea se relanzó y va a repetir líneas)");
        }
        ultimoIdx = job.index;
        idxDesde = Date.now();
        ultimoQIdx = -1;
      }
      if (job.qIdx !== ultimoQIdx) {
        if (job.qIdx < ultimoQIdx && ultimoQIdx >= 0) {
          console.log("   ⚠ qIdx de la línea " + (job.index + 1) + " bajó de " + ultimoQIdx + " a " + job.qIdx + " (se está reintentando desde el principio: la línea " + (job.index + 1) + " no avanza)");
        }
        ultimoQIdx = job.qIdx;
      }
      if (Date.now() - idxDesde > (opts.lineStallMinutes || 3) * 60 * 1000) {
        console.log("   ⚠ LÍNEA " + (job.index + 1) + "/" + (job.total || "?") + " hace " + Math.round((Date.now() - idxDesde) / 1000) + "s que no avanza (fase=" + job.phase + ", qIdx=" + job.qIdx + ")");
      }
    }
    const linea = [stt ? stt.status : "?", "paso=" + (ck && ck.step ? ck.step : "-"), "lote=" + (ck && ck.lote != null ? ck.lote : "-"),
      "linea=" + (job ? (job.index + 1) + "/" + (job.total || "?") + " q" + job.qIdx : "-"),
      "expect=" + (ck && Array.isArray(ck.expect) ? ck.expect.length : 0), url.replace(/^https?:\/\/[^/]+/, ""), prog.slice(0, 60)].join(" | ");
    if (linea !== ultimo) {
      ultimo = linea;
      ultimoCambio = Date.now();
      console.log("[" + now() + "] " + linea);
    }
    if (ck && ck.step && pasosVistos.indexOf(ck.step) === -1) {
      pasosVistos.push(ck.step);
      const filas = cart.filter((c) => c.name && c.name.indexOf("(resumen") !== 0);
      console.log("   ↳ paso " + ck.step + " · " + (ck.expect || []).length + " líneas esperadas · " + filas.length + " filas en el carrito" +
        (filas.length ? " · " + filas.slice(0, 4).map((f) => (f.code || f.name.slice(0, 26)) + "×" + f.qty).join(", ") : ""));
      snapshots.push({ at: new Date().toISOString(), step: ck.step, url, filas: filas.slice(0, 40) });
    }
    // rastro del diagnóstico: lo nuevo que escribió la extensión (match/checkout).
    if (Array.isArray(dia)) {
      for (let i = ultimoDiag; i < dia.length; i++) {
        const m = dia[i];
        const txt = typeof m === "string" ? m : String((m && (m.msg || m.text)) || "");
        if (txt) console.log("   [diag] " + txt.slice(0, 170));
      }
      if (dia.length < ultimoDiag) ultimoDiag = 0;
      ultimoDiag = dia.length;
    }
    const bloqueados = await page.evaluate(() => window.__TOKIN_DRY_BLOCKED__ || 0).catch(() => 0);
    if (bloqueados > 0) {
      if (bloqueados < (opts.lotes || 1)) {
        // v2.0.96: con --lotes N se sigue observando después del bloqueo. El
        // store nunca recibió el click, así que la extensión agota el intento,
        // el lote queda "degradado" y dispara el siguiente lote: eso permite
        // ver EN VIVO la cadena de varios lotes (que antes se colgaba en el 5º
        // o 6º) sin confirmar ningún pedido.
        log("guard: bloqueado " + bloqueados + "/" + (opts.lotes || 1) + ". Sigo mirando el siguiente lote.");
        snapshots.push({ at: new Date().toISOString(), step: "BLOQUEADO POR GUARD", url, filas: [] });
        ultimoCambio = Date.now();
        await sleep(8000);
        continue;
      }
      log("guard: se intentó confirmar " + bloqueados + " vez/veces y se bloqueó. El pedido NO se envió (así se termina el recorrido en seco).");
      snapshots.push({ at: new Date().toISOString(), step: "BLOQUEADO POR GUARD", url, filas: [] });
      break;
    }
    if (stt && (stt.status === "error" || stt.status === "done" || stt.status === "canceled")) {
      log("estado final:", stt.status, "·", prog);
      break;
    }
    if (Date.now() - ultimoCambio > (opts.stallMinutes || 4) * 60 * 1000) {
      console.log("\n=== SIN MOVIMIENTO " + (opts.stallMinutes || 4) + " MINUTOS: volcado del estado ===");
      console.log("url:", url);
      console.log("checkout:", JSON.stringify({ step: ck && ck.step, lote: ck && ck.lote, retries: ck && ck.retries, started: ck && ck.started, expect: (ck && ck.expect || []).length }));
      console.log("estado:", JSON.stringify({ status: stt && stt.status, progress: prog, checkoutLote: stt && stt.checkoutLote, batchIdx: stt && stt.cartApi && stt.cartApi.batchIdx, nextOrig: stt && stt.cartApi && stt.cartApi.nextOrig }));
      console.log("trabajo:", JSON.stringify(job && { phase: job.phase, index: job.index, total: job.total, qIdx: job.qIdx, query: job.query, item: job.items && job.items[job.index] && job.items[job.index].producto }));
      console.log("carrito:", JSON.stringify(cart.slice(0, 12)));
      console.log("diagnóstico (últimos 25):", JSON.stringify((dia || []).slice(-25)).slice(0, 3000));
      snapshots.push({ at: new Date().toISOString(), step: "COLGADO", url, checkout: ck, estado: stt, filas: cart.slice(0, 40) });
      break;
    }
  }
  // v2.0.96: el estado se lee ANTES de cerrar el popup (si se lee después, el
// popup ya no existe y el reporte nunca traía el estado final).
  const r = await readState().catch(() => null);
  await popup.close().catch(() => {});
  return { snapshots, state: r && r.ok ? r.state : null };
}

// ---------------------------------------------------------------- main
(async () => {
  requirePdf();
  try { fs.rmSync(OPTS.profile, { recursive: true, force: true }); } catch (e) {}

  log("Chrome + extensión desde:", EXT);
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
  page.on("console", (m) => {
    const t = m.text();
    if (t.includes("[dry]") || t.includes("[Tokin]")) console.log("   [page]", t.slice(0, 160));
  });

  let report = { generatedAt: new Date().toISOString(), items: 0, results: [], summary: null, checkout: null };
  try {
    await login(page);
    if (!OPTS.parseOnly && !OPTS.vaciar && !OPTS.leerCarrito) {
      // v2.0.96: el guard se instala para TODOS los modos que pueden llegar al
      // checkout (--full y también la carga completa por bloques). Al mandar
      // todos los bloques, el offscreen dispara el CHECKOUT_BATCH al terminar y
      // la extensión llega sola a «Realizar pedido»: sin guard, un dry-run
      // puede placear el pedido de verdad.
      await page.addInitScript(scriptFor(DRY_GUARD));
      await page.evaluate(scriptFor(DRY_GUARD)).catch(() => {});
      // v2.0.96: la consola del extension también en este modo. Antes sólo se
      // escuchaba en --full, así que en la carga completa no se veía ni un
      // "[Tokin]" y no había forma de ver qué estaba haciendo la extensión.
      page.on("console", (m) => {
        const t = m.text();
        if (t.includes("[Tokin]") || t.includes("[dry]")) console.log("   [" + now() + "]", t.replace(/\s+/g, " ").slice(0, 165));
      });
    }
    if (OPTS.vaciar) {
      // Sólo resets del carrito (lo que quedó de corridas anteriores).
      await clearStoreCart(page, log);
      log("--vaciar: fin.");
    } else if (OPTS.leerCarrito) {
      report.carritoReal = await readStoreCart(page, log);
      log("--leer-carrito: fin.");
    } else if (OPTS.fullFlow) {
      // Guard antes de que la extensión empiece a tocar el checkout.
      await page.addInitScript(scriptFor(DRY_GUARD));
      await page.evaluate(scriptFor(DRY_GUARD)).catch(() => {});
      page.on("console", (m) => {
        const t = m.text();
        if (t.includes("[Tokin]")) console.log("   [ext]", t.slice(0, 180));
      });
      report.full = await fullFlowRun(page, context, extId, OPTS);
      const c = await page.evaluate(() => window.__TOKIN_DRY_BLOCKED__ || 0).catch(() => 0);
      log("clicks sobre «Realizar pedido» bloqueados por el guard:", c, "(0 = no se intentó confirmar).");
    } else if (OPTS.checkoutOnly) {
      report.checkout = await dryCheckout(page);
    } else {
      const items = await parseWithExtension(context, extId);
      report.items = items.length;
      console.log("\n=== LÍNEAS RECONOCIDAS ===");
      for (const it of items) {
        console.log(
          "#" + String(it.nro || "").padEnd(4) +
          " sku=" + String(it.sku || "").padEnd(8) +
          " cant=" + String(it.cantidad || "").padEnd(5) +
          " unid=" + String(it.unidad || it.categoria || "").padEnd(10) +
          " " + String(it.producto || "").slice(0, 60)
        );
      }
      if (OPTS.parseOnly) {
        log("--parse-only: fin.");
      } else {
        const effLimit = OPTS.limit || (OPTS.blocks ? OPTS.blocks * 19 : 0);
        const use = effLimit ? items.slice(0, effLimit) : items;
        if (OPTS.blocks) log("--blocks " + OPTS.blocks + " (19/lote): uso " + use.length + " líneas.");
        else if (OPTS.limit) log("--limit " + OPTS.limit + ": uso " + use.length + " líneas.");
        const results = await runSelection(page, use, "PEDIDO ARCOR LA PLATA 13 NOV 250926.pdf");
        // Los resultados "no se encontró" no traen nro/sku: los completamos con
        // la línea de entrada homóloga para que el reporte quede legible.
        results.forEach((r, k) => {
          const it = use[k];
          if (!it) return;
          if (r.nro == null) r.nro = it.nro;
          if (!r.sku) r.sku = it.sku;
          if (!r.producto) r.producto = it.producto;
        });
        report.results = results;
        console.log("\n=== DECISIONES DE SELECCIÓN ===");
        for (const r of results) {
          const mark = r.ok && /^agregado/.test(r.message || "") ? "OK " :
            /sin stock/i.test(r.message || "") ? "SS " :
            /revisión manual/i.test(r.message || "") ? "MAN" : "ERR";
          console.log(
            mark + " #" + String(r.nro || "").padEnd(4) +
            " " + String(r.producto || "").slice(0, 42).padEnd(43) +
            " -> " + String(r.message || "")
          );
        }
        const ok = results.filter((r) => r.ok && /^agregado/.test(r.message || "")).length;
        log("resumen: " + ok + "/" + results.length + " agregadas.");
        if (!OPTS.noCheckout) report.checkout = await dryCheckout(page);
      }
    }
    const out = path.join(ROOT, "tools", "_dry_run_report.json");
    fs.writeFileSync(out, JSON.stringify(report, null, 2));
    log("reporte escrito en: " + out);
    log("LISTO. El pedido NO se envió.");
  } catch (e) {
    console.error("[dry] ERROR:", e && e.message ? e.message : e);
  } finally {
    await sleep(3000);
    await context.close().catch(() => {});
  }
  process.exit(0);
})();
