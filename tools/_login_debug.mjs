import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const profile = path.join(os.tmpdir(), "tokin-home-login");
const ctx = await chromium.launchPersistentContext(profile, { headless: false, viewport: null, args: ["--no-first-run"] });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto("https://tokintienda.com.ar/store/login", { waitUntil: "domcontentloaded", timeout: 90000 }).catch(() => {});
await page.waitForTimeout(10000);
const snap = await page.evaluate(() => {
  const inputs = Array.from(document.querySelectorAll("input")).map((i) => ({ type: i.type, name: i.name, ph: i.placeholder, dat: i.dataset && i.dataset.id }));
  const btns = Array.from(document.querySelectorAll("button")).map((b) => ({ t: (b.innerText || "").trim().slice(0, 60), dat: b.dataset && b.dataset.id })).filter((b) => b.t).slice(0, 30);
  return { url: location.href, title: document.title, inputs, btns };
});
console.log(JSON.stringify(snap, null, 1));
await ctx.close();