import { chromium } from "playwright";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import XLSX from "xlsx";

const STORE = "https://tokintienda.com.ar/store";
const LOGIN = STORE + "/login";
const EMAIL = "serhiy.cioccolato@gmail.com";
const PASS  = "Tokin123";

const wb = XLSX.readFile("caseros_ultimos_2_bloques.xlsx");
const allItems = [];
for (const s of wb.SheetNames) {
  const data = XLSX.utils.sheet_to_json(wb.Sheets[s]);
  data.forEach((r, i) => allItems.push({
    sheet: s,
    row: i + 1,
    codigo: String(r.CODIGO || "").trim(),
    producto: String(r.PRODUCTO || "").trim(),
    cantidad: r.CANTIDAD,
    unidad: String(r.UNIDAD || "").trim(),
  }));
}

(async () => {
  const profileDir = path.join(os.tmpdir(), "tokin-check-all-items");
  try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) {}

  console.log(`Iniciando chequeo de ${allItems.length} ítems en Tokin Store...`);
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
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 40000 });
        return;
      } catch (e) {
        console.log(`Reintento ${i + 1} en ${url}: ${e.message}`);
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
    await emailIn.type(EMAIL, { delay: 35 });
    const emailNext = page.locator("[data-id=email-next-buton]").first();
    await emailNext.click().catch(() => {});
    await page.waitForTimeout(3000);

    const passIn = page.locator("input[type=password]").first();
    if (await passIn.count()) {
      await passIn.fill("");
      await passIn.type(PASS, { delay: 35 });
      const submit = page.locator("[data-id=password-next-button]").first();
      await submit.click().catch(() => {});
      await page.waitForTimeout(6000);
    }
  }

  console.log("Login listo. Verificando ítems...");

  const results = [];
  // Probar los primeros 8 ítems para diagnosticar botones y unidades
  const testSample = allItems.slice(0, 8);

  for (const it of testSample) {
    console.log(`\n--- Probando item [${it.codigo}] ${it.producto} (${it.cantidad} ${it.unidad}) ---`);
    await safeGoto(STORE + "/search?q=" + encodeURIComponent(it.codigo));
    await page.waitForTimeout(4000);

    const info = await page.evaluate((it) => {
      const articles = Array.from(document.querySelectorAll("article"));
      if (!articles.length) return { found: false, error: "sin articulos" };

      // Buscar el artículo que contenga el código o coincida
      let targetArticle = null;
      for (const a of articles) {
        const text = a.innerText || "";
        if (text.includes("ARC-10" + it.codigo) || text.includes(it.codigo) || text.toLowerCase().includes(it.producto.slice(0, 15).toLowerCase())) {
          targetArticle = a;
          break;
        }
      }
      if (!targetArticle) targetArticle = articles[0];

      const rawText = (targetArticle.innerText || "").replace(/\s+/g, " ");
      const btns = Array.from(targetArticle.querySelectorAll("button")).map(b => ({
        text: b.innerText.replace(/\s+/g, " ").trim(),
        dataId: b.getAttribute("data-id"),
        className: b.className,
        disabled: b.disabled,
      }));

      // Probar si tokCardUnits reconocería los botones
      const skuBtns = Array.from(targetArticle.querySelectorAll("[data-id=sku-selector-button]"));
      const allButtons = Array.from(targetArticle.querySelectorAll("button"));

      return {
        found: true,
        textSnippet: rawText.slice(0, 220),
        buttons: btns,
        skuSelectorButtonsCount: skuBtns.length,
        skuSelectorButtons: skuBtns.map(b => b.innerText.replace(/\s+/g, " ").trim()),
        hasAddToCart: btns.some(b => b.dataId === "add-to-cart-button"),
      };
    }, it);

    console.log("Resultado DOM:", JSON.stringify(info, null, 2));
    results.push({ item: it, info });
  }

  fs.writeFileSync("tools/_items_buttons_report.json", JSON.stringify(results, null, 2), "utf8");
  console.log("\nReporte guardado en tools/_items_buttons_report.json");
  await context.close();
})();
