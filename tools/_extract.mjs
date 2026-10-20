// Extractor de funciones desde el fuente de agent.js / normalize.js, para poder
// correr el parser real de la extensión fuera del navegador (harness interno).
import fs from "node:fs";

export function extractFunction(from, name) {
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
      }
      // Si no introduce una regex, es division: se deja avanzar un caracter
      // (tratarla como comentario rompia funciones con "w.x0 / width", que se
      // comia el cierre de llaves de la fila y cortaba la extraccion antes).
      prev = "/"; continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return from.slice(start, i + 1); }
    if (!/\s/.test(ch)) prev = ch;
  }
  throw new Error("no pude cerrar " + name);
}

export function extractConst(from, name) {
  const m = from.match(new RegExp("(?:const|let|var)\\s+" + name + "\\s*=\\s*"));
  if (!m) throw new Error("no encontre la constante " + name);
  const start = m.index + m[0].length;
  const fin = from.indexOf(";", start);
  const cuerpo = from.slice(start, fin === -1 ? start + 400 : fin);
  return cuerpo.trim().replace(/,$/, "");
}

// Arma un modulo con las funciones pedidas de agent.js + normalize.js y lo evalua,
// devolviendo un objeto con ellas. `extras` son declaraciones adicionales.
export function cargarFunciones({ agent, normalize, funciones, constantes = [], extras = "" }) {
  const partes = [];
  for (const c of constantes) partes.push("const " + c + " = " + extractConst(agent, c) + ";");
  for (const f of funciones) {
    const fuente = agent.includes("function " + f + "(") ? agent : normalize;
    partes.push(extractFunction(fuente, f));
  }
  const cuerpo = partes.join("\n\n");
  const nombres = funciones.concat(constantes);
  const factory = new Function(
    "medida_categoria", "match_concept", "console",
    extras + "\n" + cuerpo + "\nreturn { " + nombres.map((n) => n + ": typeof " + n + " !== 'undefined' ? " + n + " : undefined").join(", ") + " };",
  );
  return factory;
}

export function leerFuentes(root) {
  const agent = fs.readFileSync(root + "/extension/core/agent.js", "utf8");
  const normalize = fs.readFileSync(root + "/extension/core/normalize.js", "utf8");
  return { agent, normalize };
}
