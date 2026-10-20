// Reproduce la ELECCIÓN DE ROTACIÓN de agent.js con los textos reales del PDF,
// y compara el score actual (conf + 20*legibility) con el propuesto.
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(process.cwd());
const agentSrc = fs.readFileSync(path.join(ROOT, "extension", "core", "agent.js"), "utf8");
const rot = JSON.parse(fs.readFileSync(path.join(ROOT, "..", "rot-dump.json"), "utf8"));

// Extractor de funciones (el mismo que usan los checks).
function extractFunction(from, name) {
  const start = from.search(new RegExp("(async\\s+)?function\\s+" + name + "\\s*\\("));
  if (start < 0) throw new Error("no encontre la funcion " + name);
  let i = from.indexOf("{", start), depth = 0, prev = "";
  for (; i < from.length; i++) {
    const ch = from[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch; i++;
      while (i < from.length) { if (from[i] === "\\") { i++; continue; } if (from[i] === q) break; i++; }
      prev = q; continue;
    }
    if (ch === "/" && from[i + 1] === "/") { while (i < from.length && from[i] !== "\n") i++; continue; }
    if (ch === "/" && from[i + 1] === "*") { i = from.indexOf("*/", i) + 1; continue; }
    if (ch === "/") {
      if ("([{,;:=!&|?+-*%<>~^".includes(prev)) {
        i++; let inClass = false;
        while (i < from.length) {
          if (from[i] === "\\") { i += 2; continue; }
          if (from[i] === "[") inClass = true; else if (from[i] === "]") inClass = false;
          else if (from[i] === "/" && !inClass) break;
          i++;
        }
      } else { while (i < from.length && from[i] !== "\n") i++; }
      prev = "/"; continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return from.slice(start, i + 1); }
    if (!/\s/.test(ch)) prev = ch;
  }
  throw new Error("no pude cerrar " + name);
}

const _SPANISH_WORDS = new Set([
  "de", "la", "el", "los", "las", "del", "y", "a", "en", "un", "una", "unos", "unas", "con", "por", "para",
  "se", "su", "sus", "al", "que", "o", "es", "no", "si", "me", "te", "le", "lo", "mi", "tu", "sin", "sobre",
  "entre", "hasta", "desde", "hacia", "cada", "todo", "toda", "todos", "todas", "este", "esta", "estos",
  "estas", "ese", "esa", "esos", "esas", "otro", "otra", "otros", "otras", "como", "cuando", "donde",
  "quien", "cual", "pero", "porque", "tambien", "tan", "bien", "muy", "hay",
  "nota", "pedido", "fecha", "hora", "horario", "vendedor", "comprador", "cliente", "proveedor",
  "distribuidora", "direccion", "telefono", "telefonos", "recepcion", "confirmar", "entregar", "entrega",
  "codigo", "cantidad", "cantidades", "precio", "precios", "importe", "descripcion", "producto",
  "productos", "unidad", "unidades", "bulto", "bultos", "display", "displays", "marca", "gramos", "piezas",
  "bonificaciones", "descuentos", "observaciones", "surtido", "total", "subtotal", "reimpresion",
  "sucursal", "autorizada", "autorizado", "nro", "referencia", "lista", "listado", "renglon", "renglones",
  "dulces", "villa", "parque", "ciudad", "caba", "localidad", "provincia", "nombre", "apellido", "correo",
  "envio", "envios", "carton", "cartones", "kiosco", "almacen", "deposito", "congelado", "srl", "empresa",
  "compania", "razon", "social", "dias", "hora", "hs", "uds", "kg", "cm",
]);

const legibilidad = extractFunction(agentSrc, "_legibility");
const medible = new Function("_SPANISH_WORDS", "return " + legibilidad)(_SPANISH_WORDS);

const codigo = (t) => /^\d{4,6}$/.test(t);
const precio = (t) => /^\d{1,3}(\.\d{3})*,\d{2}$/.test(t);
const palabras = (t) => String(t).split(/\s+/).filter(Boolean);

// Evidencia de tabla: un renglón de pedido tiene un código de 4-6 dígitos Y una
// descripción. En la página girada 180° no hay ninguno.
function evidenciaTabla(text) {
  let cod = 0, desc = 0;
  for (const l of String(text).split(/\n/)) {
    const toks = l.split("|").flatMap((x) => x.split(/\s+/)).map((x) => x.replace(/[^0-9A-Za-z.,]/g, ""));
    if (toks.some((t) => codigo(t))) cod++;
    if (toks.filter((t) => /^[A-Za-z]{4,}$/.test(t) && (t.match(/[aeiou]/gi) || []).length >= 2).length >= 2) desc++;
  }
  const precios = (String(text).match(/\d{1,3}\.\d{3},\d{2}/g) || []).length;
  return { filasConCodigo: cod, filasConDesc: desc, precios };
}

console.log("\nrot   conf  legib  score-ACTUAL   cod  desc  precios   score-PROPUESTO");
const filas = [];
for (const s of rot) {
  const leg = medible(s.text);
  const ev = evidenciaTabla(s.text);
  const actual = s.conf + 20 * leg;
  // Propuesta: la confianza y la evidencia de tabla pesan, porque la basura
  // girada 180° tiene palabras "plausibles" (4+ letras, 2+ vocales) y por eso
  // la legibilidad sola no la distingue.
  const prop = 3 * s.conf + 20 * leg + 6 * Math.min(ev.filasConCodigo, 40) + 4 * Math.min(ev.filasConDesc, 40) + Math.min(ev.precios, 40);
  filas.push({ rot: s.rot, conf: Math.round(s.conf), leg, actual, ev, prop });
  console.log(
    String(s.rot).padEnd(5) +
    String(Math.round(s.conf)).padEnd(6) +
    leg.toFixed(3).padEnd(7) +
    actual.toFixed(1).padEnd(14) +
    String(ev.filasConCodigo).padEnd(5) +
    String(ev.filasConDesc).padEnd(6) +
    String(ev.precios).padEnd(9) +
    prop.toFixed(1)
  );
}
const g = (k) => filas.slice().sort((a, b) => b[k] - a[k])[0].rot;
console.log("\nGanador con el score ACTUAL de la extensión:   " + g("actual") + "  (el bueno es 90)");
console.log("Ganador con el score PROPUESTO:               " + g("prop") + "  (el bueno es 90)");
