import { chromium } from "playwright";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const STORE = "https://tokintienda.com.ar/store";
const LOGIN = STORE + "/login";
const EMAIL = "druettaf@gmail.com";
const PASS  = "Tresd650";

(async () => {
  const profileDir = path.join(os.tmpdir(), "tokin-inspect-profile");
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}

  console.log("Iniciando Chromium headful...");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    locale: "es-AR",
    args: ["--no-first-run", "--no-default-browser-check"]
  });

  const page = context.pages()[0] || (await context.newPage());

  console.log("Navegando a", STORE);
  await page.goto(STORE, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);

  console.log("Navegando a", LOGIN);
  await page.goto(LOGIN, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(4000);

  const passMode = page.locator('button:has-text("mail y contraseña"), [data-id=login-with-password]');
  if (await passMode.count()) {
    await passMode.first().click().catch(() => {});
    await page.waitForTimeout(2000);
  }

  const emailIn = page.locator("input[type=email], input[name*=email i], input[placeholder*=mail i]").first();
  if (await emailIn.count()) {
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

  console.log("Logueado. URL actual:", page.url());

  // Ir a /checkout/cart para ver si hay items
  console.log("Navegando a /store/checkout/cart...");
  await page.goto(STORE + "/checkout/cart", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(5000);

  let nextBtn = page.locator('[data-id="next-step-button"], button:has-text("Siguiente")').first();
  if (await nextBtn.count() === 0) {
    console.log("Carrito vacío o sin next-step-button. Agregando producto de prueba...");
    await page.goto(STORE + "/search?q=alfajor", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);
    const addBtn = page.locator('[data-id="add-to-cart-button"], button:has-text("Agregar")').first();
    if (await addBtn.count()) {
      await addBtn.click().catch(() => {});
      await page.waitForTimeout(4000);
    }
    await page.goto(STORE + "/checkout/cart", { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(5000);
    nextBtn = page.locator('[data-id="next-step-button"], button:has-text("Siguiente")').first();
  }

  console.log("URL en cart:", page.url());
  console.log("next-step-button count:", await nextBtn.count());
  if (await nextBtn.count()) {
    console.log("next-step-button text:", await nextBtn.innerText());
    console.log("next-step-button disabled:", await nextBtn.isDisabled());
    console.log("Esperando a que esté habilitado...");
    for (let i = 0; i < 30; i++) {
      if (!await nextBtn.isDisabled()) break;
      await page.waitForTimeout(500);
    }
    console.log("Haciendo click en next-step-button...");
    await nextBtn.click();
    await page.waitForTimeout(6000);
  }

  console.log("URL tras click:", page.url());

  // Esperar hasta 20s para que cargue la página
  for (let i = 0; i < 20; i++) {
    const pCount = await page.locator('[data-id="place-order-button"]').count();
    if (pCount > 0) {
      console.log(`place-order-button apareció a los ${i}s!`);
      break;
    }
    await page.waitForTimeout(1000);
  }

  const currentUrl = page.url();
  console.log("URL final:", currentUrl);

  const bodyText = await page.evaluate(() => document.body.innerText.replace(/\n+/g, "\n").slice(0, 1500));
  console.log("\n--- TEXTO EN LA PÁGINA ---");
  console.log(bodyText);

  const buttons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll("button, a, [role=button], input[type=submit]")).map(b => ({
      tag: b.tagName,
      id: b.id,
      dataId: b.getAttribute("data-id"),
      text: (b.innerText || b.value || "").replace(/\s+/g, " ").trim().slice(0, 50),
      disabled: b.disabled || b.getAttribute("aria-disabled") === "true",
      className: b.className
    })).filter(b => b.text || b.dataId);
  });
  console.log("\n--- TODOS LOS BOTONES EN LA PÁGINA ---");
  console.log(JSON.stringify(buttons, null, 2));

  const placeBtn = page.locator('[data-id="place-order-button"]');
  console.log("\nplace-order-button count:", await placeBtn.count());
  if (await placeBtn.count()) {
    console.log("place-order-button text:", await placeBtn.first().innerText());
    console.log("place-order-button disabled:", await placeBtn.first().isDisabled());
  }

  // Screenshot para confirmar
  await page.screenshot({ path: "tools/_checkout_payment_screenshot.png" });
  console.log("Screenshot guardado en tools/_checkout_payment_screenshot.png");

  await context.close();
  console.log("Fin de inspección.");
})();
