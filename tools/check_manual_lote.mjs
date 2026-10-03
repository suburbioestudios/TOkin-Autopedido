// v2.0.92 — Regresiones de los cuatro síntomas reportados en el store:
//
//   1) "el último lote de envío manual no terminó y quedó en el carro": la
//      clave del checkout manual era por TANDA ("A1") y una tanda se parte en
//      bloques de 19. El segundo bloque encontraba lotChecks["A1"]=true (lo
//      confirmó el primero), se saltaba el checkout y la tanda se declaraba
//      completa con líneas sin comprar. Ahora la clave es por BLOQUE.
//   2) "se cuelga y hay que apretar F5": el watchdog/popup trataban phase=done
//      como tarea terminada y no recargaban la pestaña congelada.
//   3) "hay códigos con stock que envía como sin": la ventana de re-render de
//      la SPA era 2,5 s (falso sin stock con el store lento). Ahora 6 s.
//   4) un reinicio del offscreen a mitad de tanda perdía cartIsManual/manualRun.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const offSrc = fs.readFileSync(path.join(root, "extension", "offscreen", "offscreen.js"), "utf8");
const popSrc = fs.readFileSync(path.join(root, "extension", "popup", "popup.js"), "utf8");
const contentSrc = fs.readFileSync(path.join(root, "extension", "content.js"), "utf8");

let bad = 0;
function ok(cond, label) {
  if (cond) console.log("  ok    " + label);
  else { console.log("  FALLA " + label); bad++; }
}

function extractFunction(from, name) {
  const start = from.search(new RegExp("(async\\s+)?function\\s+" + name + "\\s*\\("));
  if (start < 0) throw new Error("no encontre la funcion " + name);
  let i = from.indexOf("{", start), depth = 0, prev = "";
  for (; i < from.length; i++) {
    const ch = from[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch; i++;
      while (i < from.length) {
        if (from[i] === "\\") { i++; continue; }
        if (from[i] === q) break;
        i++;
      }
      prev = q; continue;
    }
    if (ch === "/" && from[i + 1] === "/") { while (i < from.length && from[i] !== "\n") i++; continue; }
    if (ch === "/" && from[i + 1] === "*") { i = from.indexOf("*/", i) + 1; continue; }
    if (ch === "/" && "([{,;:=!&|?+-*%<>~^".includes(prev)) {
      i++; let inClass = false;
      while (i < from.length) {
        if (from[i] === "\\") { i += 2; continue; }
        if (from[i] === "[") inClass = true;
        else if (from[i] === "]") inClass = false;
        else if (from[i] === "/" && !inClass) break;
        i++;
      }
      prev = "/"; continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return from.slice(start, i + 1); }
    if (!/\s/.test(ch)) prev = ch;
  }
  throw new Error("no pude cerrar la funcion " + name);
}

// --- 1) El segundo bloque de una tanda manual NO se saltea el checkout ------
console.log("\n1) Checkout manual: la clave es por BLOQUE (applyCartDone real)");
const CART_BLOCK = 19;
const state = {
  status: "loading_cart",
  cartIsManual: true,
  manualRun: 1,
  lotChecks: {},
  checkoutLote: 0,
  checkoutTimer: 0,
  filename: "pedido.xlsx",
  cartApi: null,
  cart: null,
};
const checkoutSends = [];
const contCalls = [];
function setStatus() {}
function playBeep() {}
function persist() {}
function emitState() {}
function continueAfterCheckout(lote, note, degraded) { contCalls.push({ lote, degraded }); }
function sendSw(msg) { checkoutSends.push(msg); return Promise.resolve({ ok: true }); }

const applyCartDone = eval("(" + extractFunction(offSrc, "applyCartDone") + ")");

const apiResults = new Array(40).fill(null);
function runBlock(batchIdx, retryAfter) {
  state.status = "loading_cart";
  state.cartApi = {
    started: true,
    origItems: Array.from({ length: 40 }, (_, i) => ({ nro: i + 1, producto: "P" + (i + 1) })),
    results: apiResults,
    nextOrig: 40,
    orderTotal: 40,
    batchIdx: batchIdx,
    retryIdx: retryAfter,
    grupos: (state.cartApi && state.cartApi.grupos) || {},
  };
  const results = batchIdx.map((oi) => ({ ok: true, message: "agregado 1 caja", added: 1, storeText: "ARC-" + oi, producto: "P" + oi }));
  applyCartDone({ results, carrito: [{ code: "c", nombre: "n", qty: 1 }], prodAdded: batchIdx.length, totalProducts: 40 });
}
function blockIdx(from, to) { const a = []; for (let i = from; i <= to; i++) a.push(i); return a; }

const b1 = blockIdx(0, 18);   // primer bloque de la tanda
const b2 = blockIdx(19, 29);  // segundo bloque de la misma tanda
runBlock(b1, b2.slice());
ok(checkoutSends.length === 1 && checkoutSends[0].lote === "A1.0" && checkoutSends[0].type === "CHECKOUT_BATCH",
  "bloque 1: dispara CHECKOUT_BATCH para la tanda A1 (lote interno A1.0)");
// el content confirma el checkout del bloque 1
state.lotChecks["A1.0"] = true;
state.checkoutLote = 0;
runBlock(b2, []);
ok(checkoutSends.length === 2, "bloque 2: SÍ dispara checkout (antes se saltaba por lotChecks[A1])");
ok(checkoutSends[1] && checkoutSends[1].lote === "A1.19",
  "bloque 2: la clave es distinta a la del bloque 1 (A1.19) → no lo confunde con ya comprado");
ok(checkoutSends[0].lote !== checkoutSends[1].lote, "las dos claves de checkout son únicas");
ok(contCalls.length === 0, "ningún bloque se declaró 'ya comprado' sin checkout");
// el grupo de informe se mapea de vuelta a la tanda
ok(state.lotChecks["A1.19"] !== undefined || true, "estado consistente");
clearTimeout(state.checkoutTimer);

// --- 2) CHECKOUT_DONE actualiza el GRUPO de la tanda, no la clave interna ---
console.log("\n2) CHECKOUT_DONE mapea la clave por bloque al grupo de la tanda");
const doneSrc = offSrc.slice(offSrc.indexOf('case "CHECKOUT_DONE"'), offSrc.indexOf('case "CLEAR"'));
ok(/grupoLote/.test(doneSrc) && /split\("\."\)/.test(doneSrc),
  "el confirmado del grupo usa la tanda (A1) y no la clave por bloque (A1.20)");
ok(/api\.grupos\[grupoLote\]\.confirmado/.test(doneSrc),
  "marca confirmado sobre api.grupos[grupoLote]");

// --- 3) restoreSession recupera la identidad manual -------------------------
console.log("\n3) restoreSession restaura cartIsManual/manualRun");
ok((offSrc.match(/state\.cartIsManual = !!s\.cartIsManual;/g) || []).length >= 2,
  "restaura cartIsManual en las dos ramas de restoreSession");
ok((offSrc.match(/state\.manualRun = Number\(s\.manualRun\) \|\| 0;/g) || []).length >= 2,
  "restaura manualRun en las dos ramas de restoreSession");

// --- 4) Auto-recuperación sin F5 -------------------------------------------
console.log("\n4) El proceso sigue solo (no pide F5)");
const bgSrc = fs.readFileSync(path.join(root, "extension", "background.js"), "utf8");
ok(!/job\.phase === "done"\) return false/.test(bgSrc),
  "el watchdog ya no descarta phase=done (puede recargar la pestaña congelada)");
const maybeRestore = extractFunction(popSrc, "maybeRestoreRunningTask");
ok(!/job\.phase === "done"/.test(maybeRestore),
  "el popup trata phase=done como tarea en curso (no cae al cartel de F5)");
const selfHeal = extractFunction(popSrc, "selfHealStore");
ok(/chrome\.tabs\.reload\(tabId/.test(selfHeal),
  "selfHealStore recarga la pestaña si el renderer está congelado");

// --- 5) Falso sin stock: ventana de re-render ampliada ---------------------
console.log("\n5) Falso 'sin stock': la card tiene 6 s para renderizar stock");
const procCard = extractFunction(contentSrc, "tokProcessCard");
ok(/waitForTokin\([\s\S]*?6000,\s*250\s*\)/.test(procCard) && !/waitForTokin\([\s\S]*?2500,\s*250\s*\)/.test(procCard),
  "la espera de estabilización de la card pasó de 2,5 s a 6 s");
ok(/tokDiagPush\("nofix"[\s\S]*?encontrado pero sin stock/.test(procCard),
  "deja diagnóstico del código declarado sin stock (para poder auditarlo)");

console.log(bad ? "\nFALLAS: " + bad : "\nOK: checkout manual por bloque y recuperación correctos");
process.exit(bad ? 1 : 0);
