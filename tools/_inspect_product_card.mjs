import { chromium } from "playwright";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const STORE = "https://tokintienda.com.ar/store";
const LOGIN = STORE + "/login";
const EMAIL = "serhiy.cioccolato@gmail.com";
const PASS  = "Tokin123";

(async () => {
  const profileDir = path.join(os.tmpdir(), "tokin-inspect-card-profile");
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}

  console.log("Iniciando Chromium...");
  const context = await chromium.launchPersistentContext(profileDir, {
    headless: false,
    viewport: { width: 1280, height: 800 },
    locale: "es-AR",
    args: ["--no-first-run", "--no-default-browser-check"]
  });

  const page = context.pages()[0] || (await context.newPage());

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

  console.log("URL post login:", page.url());

  // Buscar el producto 14677 (Mogul Bananitas, primer item de Bloque 5)
  console.log("Buscando producto 14677...");
  await safeGoto(STORE + "/search?q=14677");
  await page.waitForTimeout(5000);

  // Inspeccionar el DOM de los artículos
  const cardData = await page.evaluate(() => {
    const articles = Array.from(document.querySelectorAll("article"));
    return articles.map((a, i) => {
      const btns = Array.from(a.querySelectorAll("button")).map((b) => ({
        tag: b.tagName,
        text: b.innerText.replace(/\s+/g, " ").trim(),
        dataId: b.getAttribute("data-id"),
        className: b.className,
        disabled: b.disabled,
      }));
      const inputs = Array.from(a.querySelectorAll("input")).map((inp) => ({
        type: inp.type,
        dataId: inp.getAttribute("data-id"),
        value: inp.value,
        className: inp.className,
      }));
      return {
        index: i,
        dataId: a.getAttribute("data-id"),
        className: a.className,
        textSnippet: a.innerText.slice(0, 200).replace(/\s+/g, " "),
        buttons: btns,
        inputs: inputs,
      };
    });
  });

  console.log("Resultados de artículos encontrados:", JSON.stringify(cardData, null, 2));

  fs.writeFileSync("tools/_card_data.json", JSON.stringify(cardData, null, 2), "utf8");
  console.log("Guardado en tools/_card_data.json");
  await context.close();
})();
