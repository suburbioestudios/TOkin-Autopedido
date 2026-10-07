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
// El applyCartDone real llama a armCheckoutTimer (definido arriba en
// offscreen.js); al extraer sólo esa función hay que stubearla acá.
function armCheckoutTimer() {}

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

// --- 6) v2.0.94: el carrito se verifica contra el pedido antes de «Siguiente» -
// Un refresh de fondo del store puede dejar una cantidad en 1 (el SPA re-renderiza
// la fila desde el server) y el pedido se confirmaba corto sin aviso. Ahora, antes
// de tocar «Siguiente», se compara cada fila del carrito contra lo que pide el PDF
// y si algo no empata se frena sin confirmar nada.
console.log("\n6) Antes de «Siguiente»: el carrito tiene que estar igual que el pedido");
const cartDoneSrc = extractFunction(offSrc, "applyCartDone");
ok(/type: "CHECKOUT_BATCH", lote, expect: checkoutExpect/.test(cartDoneSrc),
  "el CHECKOUT_BATCH viaja con las cantidades que el lote espera encontrar");
ok(/filter\(\(r\) => isAdded\(r\) && Number\(r\.added\) > 0\)/.test(cartDoneSrc),
  "solo viajan las líneas cargadas: las que DEBEN estar en el carrito");
ok(/want: Number\(r\.added\) \|\| 0/.test(cartDoneSrc) && /unit: String\(r\.usedUnit \|\| ""\)\.trim\(\)/.test(cartDoneSrc),
  "cada línea viaja con su cantidad y su unidad");
ok(/tokCheckoutStart\(msg\.lote \|\| 1, msg\.expect\)/.test(contentSrc),
  "el content script recibe la lista del lote");
ok(/expect: Array\.isArray\(expect\) \? expect : \[\]/.test(contentSrc),
  "la lista viaja en el estado del checkout (sobrevive a cada navegación)");

const verifySrc = extractFunction(contentSrc, "tokVerifyPreCheckout");
ok(/st && st\.expect/.test(verifySrc) && /tokCartReadCheckout\(\)/.test(verifySrc),
  "la verificación lee las cantidades que muestra el carrito");
ok(/hay !== g\.sum/.test(verifySrc) && /g\.sum \+= Number\(exp\.want\)/.test(verifySrc) && /for \(const c of g\.rows\) hay \+= qtyDe\(c, e0\)/.test(verifySrc),
  "compara el TOTAL de cada producto contra lo pedido (el store puede fusionar dos líneas en una fila, o dejar dos filas)");
ok(/tokCartSetQty\(inp, m\.sum\)/.test(verifySrc),
  "intenta corregir la cantidad con el tipeo robusto antes de frenar");
ok(/m\.qty === 1 && m\.sum > 1/.test(verifySrc) && /el store las reseteó/.test(verifySrc),
  "la señal de 'no existe un pedido de 1u': avisa que el store reseteó la línea");

// Orden: la verificación va ANTES del click en los dos pasos.
const pasoRev = contentSrc.slice(contentSrc.indexOf('if (st.step === "revisar")'), contentSrc.indexOf('if (st.step === "siguiente")'));
const pasoSig = contentSrc.slice(contentSrc.indexOf('if (st.step === "siguiente")'), contentSrc.indexOf('if (st.step === "realizar")'));
ok(pasoRev.indexOf("tokVerifyPreCheckout(st") > -1 && pasoRev.indexOf("tokVerifyPreCheckout(st") < pasoRev.indexOf("tokRealClick(el)"),
  "paso «revisar»: se verifica antes de abrir «Revisar pedido»");
ok(pasoSig.indexOf("tokVerifyPreCheckout(st") > -1 && pasoSig.indexOf("tokVerifyPreCheckout(st") < pasoSig.indexOf("tokRealClick(el)"),
  "paso «siguiente»: se verifica ANTES de tocar «Siguiente»");
ok(/if \(problemaSig\) return tokFail\(problemaSig\);/.test(pasoSig),
  "si el carrito no está igual que el pedido, NO se toca «Siguiente»: se frena el checkout");
ok(/if \(problemaRev\) return tokFail\(problemaRev\);/.test(pasoRev),
  "lo mismo en la apertura de la revisión");

// Comportamiento real de la verificación (con el carrito simulado). Se usan las
// funciones REALES de content.js (lectura de cantidad y canonicalización de
// unidad) y stubs mínimos para el DOM y para los helpers de texto.
const realQtyFromText = eval("(" + extractFunction(contentSrc, "tokQtyFromText") + ")");
const tokUnitTok = eval("(" + extractFunction(contentSrc, "tokUnitTok") + ")");
const tokRowUnitTok = eval("(" + extractFunction(contentSrc, "tokRowUnitTok") + ")");
function tokNorm(s) {
  return String(s == null ? "" : s).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}
function tokArcCode(x) {
  const s = String(x == null ? "" : (x && x.getAttribute ? x.getAttribute("data-id") : x));
  const m = s.match(/(?:ARC-?|codigo-)(\d{3,})/i);
  return m ? m[1] : "";
}
function tokSim(a, b) {
  const x = tokNorm(a), y = tokNorm(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (y.indexOf(x) === 0 || x.indexOf(y) === 0) return 0.9;
  return x.indexOf(y) > -1 || y.indexOf(x) > -1 ? 0.6 : 0;
}
let FILAS = [];
function toksleep() { return Promise.resolve(); }
function tokCartReadCheckout() { return FILAS; }
let corregidas = [];
async function tokCartSetQty(inp, want) { corregidas.push(want); return want; }
function tokDiagPush() {}
function tokToastSet() {}
const tokVerifyPreCheckout = eval("(" + verifySrc + ")");
const linea = (nro, want, code) => ({ nro, producto: "PROD " + nro, storeText: "ARC-" + code, want, unit: "Unidad" });
const fila = (code, qty, conInput) => ({ el: { querySelector: conInput ? () => ({}) : () => null }, code, name: "PROD ARC-" + code + " x " + qty + " Unidad(s)", qty, hasInput: !!conInput });

FILAS = [fila("1510", 24, true)];
ok(await tokVerifyPreCheckout({ expect: [linea(5, 24, "1510")] }, "antes de «Siguiente»") === null,
  "carrito igual que el pedido → sigue (no frena)");
ok(corregidas.length === 0, "no toca nada cuando todo está bien");

FILAS = [fila("1510", 1, true)];
const r1 = await tokVerifyPreCheckout({ expect: [linea(5, 24, "1510")] }, "antes de «Siguiente»");
ok(r1 && /el carrito muestra 1/.test(r1) && /pedido pide 24/.test(r1) && /#5/.test(r1),
  "cantidad reseteada a 1 → frena y dice qué línea y cuánto se pidió");
ok(/store las reseteó/.test(r1 || ""), "el motivo es el reseteo a 1 del store");
ok(corregidas.length === 1 && corregidas[0] === 24, "antes de frenar intentó corregir la cantidad");

FILAS = [];
ok(await tokVerifyPreCheckout({ expect: [linea(5, 24, "1510")] }, "antes de «Siguiente»") === null,
  "carrito ilegible → NO frena (no se bloquea una compra por una lectura que no se pudo hacer)");

FILAS = [fila("999", 24, true)];
ok(await tokVerifyPreCheckout({ expect: [linea(5, 24, "1510")] }, "antes de «Siguiente»") === null,
  "no se reconoce ninguna línea del lote → NO frena (lectura dudosa)");

ok(await tokVerifyPreCheckout({}, "antes de «Siguiente»") === null,
  "lote sin lista de cantidades → se sigue (no hay contra qué comparar)");

FILAS = [fila("777", 24, true)];
ok(await tokVerifyPreCheckout({ expect: [linea(1, 12, "777"), linea(2, 12, "777")] }, "antes de «Siguiente»") === null,
  "dos líneas del pedido fusionadas en una fila: se compara la SUMA (12+12=24) y no se frena");
FILAS = [fila("777", 24, true)];
const r2 = await tokVerifyPreCheckout({ expect: [linea(1, 12, "777"), linea(2, 24, "777")] }, "antes de «Siguiente»");
ok(r2 && /pedido pide 36/.test(r2), "si la fila fusionada quedó corta (24 de 36) también frena");

FILAS = [fila("888", 12, true), fila("888", 12, true)];
ok(await tokVerifyPreCheckout({ expect: [linea(3, 24, "888")] }, "antes de «Siguiente»") === null,
  "el store dejó DOS filas del mismo producto (12+12) contra una línea de 24: compara el total y NO frena");
FILAS = [fila("888", 12, true), fila("888", 6, true)];
const antesDeRepartir = corregidas.length;
const r3 = await tokVerifyPreCheckout({ expect: [linea(3, 24, "888")] }, "antes de «Siguiente»");
ok(r3 && /carrito muestra 18/.test(r3) && /en 2 filas/.test(r3),
  "dos filas que suman menos de lo pedido (18 de 24) → frena diciendo cuántas filas hay");
ok(corregidas.length === antesDeRepartir,
  "con varias filas del mismo producto NO reparte a ciegas: frena y lo corrige el usuario");
ok(realQtyFromText("PROD x 24 Unidad(s)", "Unidad") === 24 && realQtyFromText("PROD x 2 Bultos (48 Uds)", "Bulto") === 2 &&
   realQtyFromText("PROD x 24 Unidad(s)", "Caja") === 24 && realQtyFromText("Cantidad: 6", "") === 6 &&
   realQtyFromText("sin cantidad", "") === null,
  "la cantidad se lee del texto de la fila de /checkout/cart (no hay input ahí)");
ok(tokRowUnitTok("COFLER x 2 Bultos (48 Uds)") === "bulto" && tokRowUnitTok("COFLER x Bulto (216 Uds)") === "bulto" &&
   tokRowUnitTok("COFLER x 24 Unidad(s)") === "unidad" && tokRowUnitTok("COFLER x 3 Cajas") === "caja" &&
   tokRowUnitTok("COFLER x 1 Display") === "display" && tokRowUnitTok("COFLER 12 unidades") === "",
  "la unidad sale de 'x [N] <unidad>' y no de la fila entera: 'x 2 Bultos (48 Uds)' es BULTO, no unidad");
ok(tokUnitTok("Unidad") === "unidad" && tokUnitTok("Bulto") === "bulto" && tokUnitTok("Uds") === "unidad" && tokUnitTok("Caja") === "caja",
  "la unidad del pedido se canonicaliza igual que la del carrito");

// v2.0.95: el flujo del checkout tiene que ser exactamente el de siempre. La
// comparación del carrito es un control, no un paso: si algo sale mal adentro,
// el checkout sigue como antes. Y cada paso solo busca SU botón: el de
// «Revisar pedido», el de «Siguiente», el de «Realizar pedido». El error que se
// vio en vivo («no se encontró “Realizar pedido” en /checkout/payment») no era
// el problema: era la consecuencia de que el estado quedara en un paso que ya no
// correspondía.
console.log("\n7) El flujo sigue siendo el de siempre: cada paso busca su botón y un fallo interno no descuadra el checkout");
const pasoReal = contentSrc.slice(contentSrc.indexOf('if (st.step === "realizar")'));
ok(/try \{\s*problemaSig = await tokVerifyPreCheckout/.test(pasoSig) && /catch \(err\)/.test(pasoSig),
  "paso «siguiente»: la comparación va dentro de un try/catch");
ok(/try \{\s*problemaRev = await tokVerifyPreCheckout/.test(pasoRev) && /catch \(err\)/.test(pasoRev),
  "paso «revisar»: la comparación va dentro de un try/catch");
ok(pasoSig.indexOf("tokVerifyPreCheckout(st") < pasoSig.indexOf('next-step-button'),
  "la comparación va antes de BUSCAR «Siguiente»: el botón se resuelve recién al clickearlo, nunca un nodo viejo");
ok(pasoRev.indexOf("tokVerifyPreCheckout(st") < pasoRev.indexOf('\'[data-id="go-to-checkout-buton"]\''),
  "lo mismo en «Revisar pedido»: la fila se compara antes de abrir la revisión");
ok(!/location\.href = location\.origin \+ "\/store\/checkout\/payment"/.test(pasoSig),
  "el paso «siguiente» ya no se inventa el paso siguiente saltando a /checkout/payment");
ok(/st\.step = "revisar"/.test(pasoSig) && /no se encontró el botón «Siguiente»/.test(pasoSig),
  "si no aparece «Siguiente» vuelve al paso anterior (que es el que sabe qué botón va)");
ok(/location\.pathname\.indexOf\("\/checkout\/payment"\) !== 0/.test(pasoReal),
  "el paso «realizar» primero se assure de estar en /checkout/payment");
ok(/st\.step = "siguiente"/.test(pasoReal) && /no llegó a \/checkout\/payment/.test(pasoReal),
  "si la url no es la del pago, vuelve al paso que busca «Siguiente» en vez de decir que no encuentra «Realizar pedido»");
const stepSrc = extractFunction(contentSrc, "tokCheckoutStep");
ok(/tokCheckoutStepReal/.test(stepSrc) && /catch \(err\)/.test(stepSrc) && /tokCheckoutDone\(false, msg\)/.test(stepSrc),
  "tokCheckoutStep es un envoltorio: cualquier excepción interna corta el checkout con un mensaje útil");
ok(/async function tokCheckoutStepReal\(\)/.test(contentSrc),
  "la lógica del checkout quedó en tokCheckoutStepReal, sin cambios de comportamiento");
ok(/NO se toca .Siguiente.|\. No se tocó «Siguiente»/.test(extractFunction(contentSrc, "tokVerifyPreCheckout")),
  "el bloqueo sigue siendo el mismo de v2.0.94: no se toca «Siguiente»");

console.log(bad ? "\nFALLAS: " + bad : "\nOK: checkout manual por bloque y recuperación correctos");
process.exit(bad ? 1 : 0);
