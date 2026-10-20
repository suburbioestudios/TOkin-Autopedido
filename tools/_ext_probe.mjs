import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";

const EXT = "C:\\Users\\Perfect Pixel\\Desktop\\TresD\\Extnsion Tokin\\tokinext\\extension";
const profile = path.join(os.tmpdir(), "tokin-ext-probe-" + Date.now());
const args = [
  "--disable-extensions-except=" + EXT,
  "--load-extension=" + EXT,
  "--no-first-run",
  "--no-default-browser-check",
];

async function tryLaunch(label, extra) {
  console.log("\n===== " + label + " =====");
  try {
    const ctx = await chromium.launchPersistentContext(profile + "-" + label, {
      headless: false,
      viewport: null,
      args,
      ...extra,
    });
    await new Promise((r) => setTimeout(r, 6000));
    console.log("pages:", ctx.pages().map((p) => p.url()));
    console.log("serviceWorkers:", ctx.serviceWorkers().map((w) => w.url()));
    console.log("backgroundPages:", ctx.backgroundPages().map((p) => p.url()));
    await ctx.close();
  } catch (e) {
    console.log("ERR:", e.message);
  }
}

await tryLaunch("default", {});
await tryLaunch("ignore-disable-ext", { ignoreDefaultArgs: ["--disable-extensions"] });
await tryLaunch("disable-feature", {
  args: [...args, "--disable-features=DisableLoadExtensionCommandLineSwitch"],
  ignoreDefaultArgs: ["--disable-extensions"],
});
try { fs.rmSync(profile, { recursive: true, force: true }); } catch (e) {}
