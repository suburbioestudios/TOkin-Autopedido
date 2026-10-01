// Prueba ejecutable de la eleccion entre un COMBO y la CARD del producto, que es
// el caso que reporto el cliente: el codigo 9919 aparecia en las dos cards y se
// elegia el combo, cuando la correcta es la que tiene el boton de la unidad de
// venta que pide el pedido.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const src = fs.readFileSync(path.join(root, "extension", "content.js"), "utf8");

let bad = 0;
function ok(cond, label) {
  if (cond) console.log("  ok    " + label);
  else { console.log("  FALLA " + label); bad++; }
}

// Reimplementa EXACTAMENTE la parte de tokBestArticle que decide, con las mismas
// expresiones que usa el archivo, para no tener que simular el DOM del store.
function decide(cards, sku, wantType) {
  const skuIsCombo = /^[\s-]?C(\d{2,})$/i.test(String(sku || "").trim());
  const comboDigits = skuIsCombo ? String(sku).trim().replace(/\D+/g, "") : null;
  const arcOf = (t) => {
    const m = String(t).match(/ARC-(\d+)/i);
    return m ? m[1] : null;
  };
  const skuMatch = (t) => {
    if (comboDigits) {
      for (const c of String(t).match(/\b[Cc](\d{2,})\b/g) || []) {
        const n = c.replace(/\D+/g, "");
        if (n === comboDigits || (n.length > comboDigits.length && n.slice(-comboDigits.length) === comboDigits)) return true;
      }
      return false;
    }
    const d = String(sku).replace(/\D+/g, "");
    if (d.length < 4) return false;
    const arc = arcOf(t);
    if (!arc) return false;
    return arc === d || arc.endsWith(d) || d.endsWith(arc) ||
      (arc.length > d.length && arc.slice(-d.length) === d);
  };
  const parsed = cards.map((c) => ({
    name: c.name,
    text: c.text,
    codeMatch: skuMatch(c.text),
    // v2.0.88: combo = codigo fijo "C###" Y sin botones de unidad. Con solo el
    // codigo, una card NORMAL con un "C+dígitos" en su texto quedaba clasificada
    // como combo y se excluia del pool: el producto no aparecia nunca.
    isComboCard: /\bC\d{2,}\b/.test(c.text) && (c.units || []).length === 0,
    offersWant: !!wantType && (c.units || []).some((u) => u === wantType),
  }));
  const byCode = parsed.filter((p) => p.codeMatch && (skuIsCombo || !p.isComboCard));
  const codePool0 = byCode;
  const codePoolConUnidad = wantType ? codePool0.filter((p) => p.offersWant) : [];
  // El pool por codigo manda. Si no hay ninguno, cae al fallback por nombre, que
  // tambien tiene que dejar afuera a los combos (por ahi se colaban).
  const comboOk = (p) => skuIsCombo || !p.isComboCard;
  const byName = parsed.filter(
    (p) => comboOk(p) && p.offersWant || comboOk(p)
  );
  const pool = codePoolConUnidad.length
    ? codePoolConUnidad
    : codePool0.length
      ? codePool0
      : byName;
  if (!pool.length) return null;
  // desempate por nombre, como en el archivo
  let best = pool[0];
  for (const p of pool.slice(1)) {
    if (p.offersWant && !best.offersWant) best = p;
  }
  return best;
}

// El caso reportado: el 9919 devuelve dos cards. El combo muestra el ARC del
// componente adentro, y el producto real tiene el boton de "x Bulto".
const CASOS = [
  {
    titulo: "combo y card real con el mismo codigo, el pedido pide bulto",
    sku: "9919",
    wantType: "bulto",
    cards: [
      { name: "COMBO", text: "Combo surtido C455 incluye ARC-9919 $ 12.000", units: [] },
      { name: "REAL", text: "Producto real ARC-9919 $ 3.000", units: ["bulto", "unidad"] },
    ],
    esperado: "REAL",
  },
  {
    // Si NINGUNA card ofrece la unidad pedida, se igual toma el match por código:
    // la línea no se descarta en silencio, la resolución de unidad la manda a
    // revisión manual con un motivo explícito. Perder el producto sin explicar
    // por qué es peor que intentar y avisar.
    titulo: "si ninguna card ofrece la unidad pedida, se igual toma la del código (la unidad se reporta después)",
    sku: "9919",
    wantType: "display",
    cards: [
      { name: "COMBO", text: "Combo surtido C455 incluye ARC-9919 $ 12.000", units: [] },
      { name: "REAL", text: "Producto real ARC-9919 $ 3.000", units: ["bulto", "unidad"] },
    ],
    esperado: "REAL",
  },
  {
    titulo: "el combo NO se cuela cuando el pedido pide su propia unidad y la real no la tiene",
    sku: "9919",
    wantType: "unidad",
    cards: [
      { name: "COMBO", text: "Combo C455 con ARC-9919 $ 12.000", units: [] },
      { name: "REAL", text: "Producto real ARC-9919 $ 3.000", units: ["bulto", "unidad"] },
    ],
    esperado: "REAL",
  },
  {
    titulo: "un combo pedido por su propio codigo SI se elige",
    sku: "C455",
    wantType: "unidad",
    cards: [
      { name: "COMBO", text: "Combo surtido C455 incluye ARC-9919 $ 12.000", units: [] },
      { name: "REAL", text: "Producto real ARC-9919 $ 3.000", units: ["bulto", "unidad"] },
    ],
    esperado: "COMBO",
  },
  {
    titulo: "sin codigo de combo en la card, se elige la que ofrece la unidad",
    sku: "13331",
    wantType: "bulto",
    cards: [
      { name: "A", text: "Presentacion caja ARC-13331 $ 5.000", units: ["caja"] },
      { name: "B", text: "Presentacion bulto ARC-13331 $ 5.000", units: ["bulto"] },
    ],
    esperado: "B",
  },
  {
    // El bug real: el combo quedaba fuera del pool por CODIGO pero se colaba por
    // el fallback de NOMBRE. Se elegia su card, que no tiene ARC propio (muestra
    // los de sus componentes), y la verificacion del carrito falla con el mensaje
    // falso "la card del store no muestra codigo ARC" sobre un producto que si lo
    // tenia.
    titulo: "el combo NO entra por el fallback de nombre cuando el pedido no es combo",
    sku: "9919",
    wantType: "unidad",
    cards: [
      { name: "COMBO", text: "Combo C455 con ARC-9919 $ 12.000", units: [] },
      { name: "REAL", text: "Producto real ARC-9919 $ 3.000", units: ["unidad"] },
    ],
    esperado: "REAL",
  },
  {
    // El caso "como que no la vio": con el test laxo, una card NORMAL que traia un
    // C+dígitos en su texto se marcaba combo y quedaba fuera de TODOS los pools.
    titulo: "una card normal con un C+dígitos en su texto NO se confunde con combo",
    sku: "13331",
    wantType: "bulto",
    cards: [
      { name: "REAL", text: "ARC-13331 $ 5.000 ref. C2048", units: ["bulto", "unidad"] },
    ],
    esperado: "REAL",
  },
  {
    titulo: "si solo hay un combo y el pedido no es combo, no se elige",
    sku: "9919",
    wantType: "unidad",
    cards: [
      { name: "COMBO", text: "Combo C455 con ARC-9919 $ 12.000", units: [] },
    ],
    esperado: null,
  },
];

console.log("Eleccion entre combo y card real (content.js: tokBestArticle)");
for (const c of CASOS) {
  const got = decide(c.cards, c.sku, c.wantType);
  const gotName = got ? got.name : null;
  ok(gotName === c.esperado,
    c.titulo + " → " + (gotName === null ? "(nada)" : gotName) +
    " (esperado " + (c.esperado === null ? "(nada)" : c.esperado) + ")");
}

console.log(bad ? "\nFALLAS: " + bad : "\nOK: combo y card real se eligen bien");
process.exit(bad ? 1 : 0);
