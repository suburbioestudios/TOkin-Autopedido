import { chromium } from "playwright";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const STORE = "https://tokintienda.com.ar/store";
const LOGIN = STORE + "/login";
const EMAIL = "serhiy.cioccolato@gmail.com";
const PASS  = "Tokin123";

(async () => {
  const profileDir = path.join(os.tmpdir(), "tokin-click-probe-profile");
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}

  console.log("Iniciando Chromium...");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    locale: "es-AR",
    args: ["--no-first-run", "--no-default-browser-check"]
  });

  const page = context.pages()[0] || (await context.newPage());

  page.on("request", r => {
    const u = r.url();
    if (u.includes("updateCart") || u.includes("addItems") || u.includes("graphql") || u.includes("cart")) {
      const p = (r.postData() || "").slice(0, 120);
      console.log(`[REQ] ${u.slice(0, 60)} -> ${p}`);
    }
  });

  page.on("response", r => {
    const u = r.url();
    if (u.includes("updateCart") || u.includes("addItems") || u.includes("cart")) {
      console.log(`[RES ${r.status()}] ${u.slice(0, 60)}`);
    }
  });

  async function safeGoto(url) {
    for (let i = 0; i < 3; i++) {
      try {
        console.log(`Navegando a ${url} (intento ${i + 1})...`);
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
        return;
      } catch (e) {
        console.log(`Reintentando navegación por: ${e.message}`);
        await page.waitForTimeout(3000);
      }
    }
  }

  await safeGoto(LOGIN);
  await page.waitForTimeout(3000);

  const passMode = page.locator('button:has-text("mail y contraseña"), [data-id=login-with-password]');
  if (await passMode.count()) {
    await passMode.first().click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  const emailIn = page.locator("input[type=email], input[name*=email i], input[placeholder*=mail i]").first();
  if (await emailIn.count()) {
    console.log("Logueando con", EMAIL);
    await emailIn.fill("");
    await emailIn.type(EMAIL, { delay: 40 });
    const emailNext = page.locator("[data-id=email-next-buton]").first();
    await emailNext.click().catch(() => {});
    await page.waitForTimeout(3000);

    const passIn = page.locator("input[type=password]").first();
    if (await passIn.count()) {
      await passIn.fill("");
      await passIn.type(PASS, { delay: 40 });
      const submit = page.locator("[data-id=password-next-button]").first();
      await submit.click().catch(() => {});
      await page.waitForTimeout(7000);
    }
  }

  // Buscar el producto 14677
  await safeGoto(STORE + "/search?q=14677");
  await page.waitForTimeout(4000);

  // Ver estado antes del click
  const getCardInfo = () => page.evaluate(() => {
    const a = document.querySelector("article");
    if (!a) return null;
    const btns = Array.from(a.querySelectorAll("button")).map(b => ({
      text: b.innerText.replace(/\s+/g, " ").trim(),
      dataId: b.getAttribute("data-id"),
    }));
    const inps = Array.from(a.querySelectorAll("input")).map(i => ({
      type: i.type,
      dataId: i.getAttribute("data-id"),
      val: i.value,
    }));
    return { btns, inps, text: a.innerText.replace(/\s+/g, " ").slice(0, 150) };
  });

  console.log("Card inicial:", await getCardInfo());

  // Click en "x Display"
  console.log("Haciendo click en botón 'x Display'...");
  const dispBtn = page.locator('button[data-id="sku-selector-button"]:has-text("Display")').first();
  if (await dispBtn.count()) {
    await dispBtn.click();
    console.log("Click en 'x Display' realizado. Esperando 1500ms...");
    await page.waitForTimeout(1500);
  }
  console.log("Card post-click unidad:", await getCardInfo());

  // Click en "Agregar"
  console.log("Haciendo click en botón 'Agregar'...");
  const addBtn = page.locator('button[data-id="add-to-cart-button"]').first();
  if (await addBtn.count()) {
    await addBtn.click();
    console.log("Click en 'Agregar' realizado. Monitoreando cambios en la card cada 500ms por 5s...");
    for (let t = 0; t < 10; t++) {
      await page.waitForTimeout(500);
      const info = await getCardInfo();
      console.log(`t=+${(t + 1) * 500}ms Card:`, info);
      if (info && info.inps.length > 0) break;
    }
  }

  // Comprobar si el input apareció en la card o si está en el drawer del carrito
  const cartDrawerInps = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("article[data-id=cart-product-card]")).map(c => ({
      title: c.innerText.slice(0, 50).replace(/\s+/g, " "),
      inp: (c.querySelector("input[type=number]") || {}).value,
      visible: c.offsetParent !== null,
    }));
  });
  console.log("Carrito Drawer (sin abrirlo manualmente):", cartDrawerInps);

  // Ahora abrir el drawer clickeando el botón del minicart
  const minicartBtn = page.locator("[data-id=navbar-minicart-button]").first();
  if (await minicartBtn.count()) {
    console.log("Abriendo drawer del minicart...");
    await minicartBtn.click();
    await page.waitForTimeout(2000);
    const cartDrawerInpsPostOpen = await page.evaluate(() => {
      return Array.from(document.querySelectorAll("article[data-id=cart-product-card]")).map(c => ({
        title: c.innerText.slice(0, 50).replace(/\s+/g, " "),
        inp: (c.querySelector("input[type=number]") || {}).value,
        dataId: (c.querySelector("[data-id^=unit-size-ARC-]") || {}).getAttribute?.("data-id"),
        visible: c.offsetParent !== null,
      }));
    });
    console.log("Carrito Drawer (tras abrir drawer):", cartDrawerInpsPostOpen);
  }

  await context.close();
})();
