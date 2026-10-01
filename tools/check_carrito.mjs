// Regresiones de v2.0.85 sobre el flujo de carga del carrito. Los tres fallos
// reportados por el cliente:
//
//   1) "reintentaba buscar un sin stock cuando ya pasó". La cola de la tanda de
//      ajustes manuales se armaba mirando SOLO si la línea estaba cargada, así
//      que reencolaba los sin stock CONFIRMADOS (un hecho del store: no hay
//      nada que el cliente pueda cambiar) y las líneas que ya habían pasado por
//      una tanda, cuyo resultado es definitivo. El popup sí las filtraba
//      (esPendienteDeAjuste) pero el offscreen ignoraba ese filtro.
//   2) "alguno que no le acertaba agregarlo". El whitelist de tokCartStart
//      borraba nro, unidadSospechosa y pack_factors, que el offscreen manda a
//      propósito. Con nro perdido, el popup caía al índice de la lista
//      compactada y una corrección manual "-línea 7-" se aplicaba a la línea 3.
//      Sin pack_factors el headed del pedido era invisible y los sin stock no se
//      confirmaban, con lo cual la línea volvía a entrar en cada tanda.
//
// Además se cerraban dos agujeros que reportaban altas sin verificar.
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(process.cwd());
const contentSrc = fs.readFileSync(path.join(root, "extension", "content.js"), "utf8");
const offSrc = fs.readFileSync(path.join(root, "extension", "offscreen", "offscreen.js"), "utf8");
const popSrc = fs.readFileSync(path.join(root, "extension", "popup", "popup.js"), "utf8");
const agentSrc = fs.readFileSync(path.join(root, "extension", "core", "agent.js"), "utf8");

let bad = 0;
function ok(cond, label) {
  if (cond) console.log("  ok    " + label);
  else { console.log("  FALLA " + label); bad++; }
}

// --- Extracción de código real -------------------------------------------
// Escáner que salta strings, comentarios y regex para recién ahí contar llaves.
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
    if (ch === "/") {
      if ("([{,;:=!&|?+-*%<>~^".includes(prev)) {
        i++; let inClass = false;
        while (i < from.length) {
          if (from[i] === "\\") { i += 2; continue; }
          if (from[i] === "[") inClass = true;
          else if (from[i] === "]") inClass = false;
          else if (from[i] === "/" && !inClass) break;
          i++;
        }
      }
      prev = "/"; continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") { depth--; if (depth === 0) return from.slice(start, i + 1); }
    prev = ch;
  }
  throw new Error("llaves sin cerrar en " + name);
}

// Las aserciones negativas NO pueden buscar el código viejo a pelo: los
// comentarios que explican el arreglo lo citan textual (p. ej. el comentario
// del fix cita el indexOf que se acaba de sacar), y darían un falso positivo.
// Este recorte deja solo el código ejecutable, respetando strings y regex.
function stripComments(from) {
  let out = "", i = 0, prev = "";
  while (i < from.length) {
    const ch = from[i];
    if (ch === '"' || ch === "'" || ch === "`") {
      const q = ch; let j = i + 1;
      while (j < from.length) {
        if (from[j] === "\\") { j += 2; continue; }
        if (from[j] === q) break;
        j++;
      }
      out += from.slice(i, j + 1); i = j + 1; prev = q; continue;
    }
    if (ch === "/" && from[i + 1] === "/") { while (i < from.length && from[i] !== "\n") i++; continue; }
    if (ch === "/" && from[i + 1] === "*") { i = from.indexOf("*/", i) + 2; continue; }
    if (ch === "/") {
      if ("([{,;:=!&|?+-*%<>~^".includes(prev)) {
        let j = i + 1, inClass = false;
        while (j < from.length) {
          if (from[j] === "\\") { j += 2; continue; }
          if (from[j] === "[") inClass = true;
          else if (from[j] === "]") inClass = false;
          else if (from[j] === "/" && !inClass) break;
          j++;
        }
        out += from.slice(i, j + 1); i = j + 1; prev = "/"; continue;
      }
    }
    out += ch; prev = ch; i++;
  }
  return out;
}

const contentCode = stripComments(contentSrc);
const procCode = stripComments(extractFunction(contentSrc, "tokProcessCard"));

console.log("\n1) La tanda manual solo reencola lo PENDIENTE DE AJUSTE (offscreen.js)");
const batch = extractFunction(offSrc, "startManualBatch");
ok(/esPendienteDeAjuste/.test(batch), "la cola usa el filtro de pendientes de ajuste");
ok(/confirmado === true/.test(batch), "excluye los SIN STOCK CONFIRMADOS (hecho del store, no hay nada que corregir)");
ok(/manualRound/.test(batch), "excluye las líneas que ya pasaron por una tanda (resultado definitivo)");
ok(!/if \(r && isAdded\(r\)\) continue;/.test(batch),
  "ya NO basta con mirar si la línea está cargada (esa era la causa del reintento)");

// Réplica exacta de la regla del popup, para comprobar que no se drifts.
const popPendiente = extractFunction(popSrc, "esPendienteDeAjuste");
ok(
  /!isCargada/.test(popPendiente) && /esSinStockConfirmado/.test(popPendiente) && /esAjusteDefinitivo/.test(popPendiente),
  "el popup mantiene las tres condiciones (el offscreen las replica)"
);

console.log("\n2) El job del carrito conserva nro, unidadSospechosa y pack_factors (content.js)");
const start = extractFunction(contentSrc, "tokCartStart");
ok(/nro: it\.nro/.test(start), "nro viaja al job: si no, la corrección manual cae en la línea equivocada");
ok(/unidadSospechosa: it\.unidadSospechosa === true/.test(start),
  "unidadSospechosa viaja al job: si no, el bloqueo de '1 unidad' nunca se aplica");
ok(/pack_factors: it\.pack_factors \|\| null/.test(start),
  "pack_factors viaja al job: si no, el headed del pedido es invisible y el sin stock no se confirma");
// El offscreen ya mandaba los tres; el que se perdían era el whitelist del content.
const cartItems = extractFunction(offSrc, "cartItems");
for (const f of ["nro: it.nro", "unidadSospechosa: it.unidadSospechosa === true", "pack_factors: it.pack_factors || null"]) {
  ok(cartItems.includes(f), "el offscreen manda " + f.split(":")[0]);
}

console.log("\n3) La pantalla de cierre reconoce los mensajes de sin stock REALES (content.js)");
ok(!/indexOf\("sin stock"\) === 0/.test(contentCode),
  'ya no se exige que el mensaje EMPIECE con "sin stock" (nunca era así)');
ok(/if \(\/sin stock\/i\.test\(String\(r\.message/.test(contentCode),
  "se busca 'sin stock' en todo el mensaje, para que entre 'revisión manual: sin stock…' y 'encontrado pero sin stock…'");

console.log("\n4) Ningún alta se reporta sin verificar (content.js)");
ok(!/out\.message = "agregado sin cantidad"/.test(contentCode),
  'ya no existe la rama "agregado sin cantidad": marcaba CARGADA una línea sin cantidad resuelta');
ok(!/agregado sin cantidad/.test(procCode), "la rama que reportaba un alta sin verificar ya no está en tokProcessCard");
ok(/if \(out\.ok && wantQty > 0\)/.test(contentCode),
  "el bloque de verificación del carrito sigue corriendo solo con cantidad a verificar (por eso la rama anterior no se podía verificar)");

console.log("\n5) El checkout no puede quedar rebotando entre dos pasos (content.js)");
const waitUrl = extractFunction(contentSrc, "tokWaitCheckUrl");
ok(/st\.retries = \(st\.retries \|\| 0\) \+ 1/.test(waitUrl), "los reintentos de navegación se cuentan");
ok(/st\.retries >= 3/.test(waitUrl), "al tercer intento se corta en vez de seguir rebotando");
ok(/return tokFail\(/.test(waitUrl), "el corte pasa por tokFail (limpia el estado y avisa al offscreen)");
// La recursión a tokCheckoutStep sigue (va al paso anterior para reintentar el
// click), pero ahora está ACOTADA por el contador: eso es lo que evita el
// rebote infinito que clavaba el lote hasta el timeout de 12 minutos.
// El rebote sin contador es el que clavaba el lote los 12 minutos del timeout
// general sin avanzar ni avisar por qué.
ok(!/Date\.now\(\) - started > 12 \* 60 \* 1000[\s\S]{0,160}?timeout general"\);/.test(contentCode),
  'el timeout general dice qué paso quedó trabado, no solo "timeout general"');
ok(/st\.retries = 0/.test(waitUrl), "el contador se olvida cuando el paso sí avanza");

console.log("\n6) Sin factor de autorizacion por mail (v2.0.89)");
// v2.0.89: access.js se borro entero. Ya no queda ningun camino que consulte una
// lista de emails, ni aunque fuera de uso, y el manifest ya no pide permisos a
// GitHub: la extension es 100% local de verdad.
ok(!fs.existsSync(path.join(root, "extension", "core", "access.js")),
  "access.js no existe mas (no queda codigo muerto con el fetch a GitHub)");
const popupCode = stripComments(popSrc);
ok(!/access\.js/.test(popupCode), "popup.js no importa nada de access.js");
ok(!/isAllowed/.test(popupCode), "popup.js no usa isAllowed");
ok(!/ui\.allowed/.test(popupCode), "no queda el estado ui.allowed, que nunca se leia");
ok(!/getAllowedUsers|allowed_users|checkCachedAccess|grantAccess|revokeAccess/.test(popupCode),
  "ninguna referencia a la lista de usuarios en el popup");
// Tampoco puede quedar el permiso de host, que era lo unico que hacia falta para
// el fetch: si vuelve a aparecer, alguien metio el control por lista de nuevo.
const manifestSrc = stripComments(fs.readFileSync(path.join(root, "extension", "manifest.json"), "utf8"));
ok(!/githubusercontent|api\.github|github\.com/.test(manifestSrc),
  "el manifest ya no pide permisos de host a GitHub");
ok(/tokintienda\.com\.ar/.test(manifestSrc), "el unico host que queda es el store");
// El unico requisito para abrir es la sesion del store.
ok(/if \(!pong\.session\.email\)/.test(popupCode),
  "el requisito que queda es la sesion del store");

console.log("\n7) Los carteles de reconexion y de ruptura (popup.js)");
// "Informacion refrescada. La herramienta quedo activa." era el aviso de que se
// habia refrescado la lista; con la lista eliminada no corresponde.
ok(!/Informaci[oó]n refrescada/.test(popupCode),
  'el cartel "Informacion refrescada. La herramienta quedo activa." ya no existe');
ok(/Restaurando Informaci[oó]n activa\./.test(popupCode),
  'existe el cartel "Restaurando Informacion activa." para cuando se recupera una ruptura');
// Y solo se dispara en la ruptura (job vivo recuperado), no en la reanudacion
// silenciosa por senal.
const restore = extractFunction(popupCode, "maybeRestoreRunningTask");
ok(/if \(ok\) setStatus\("Restaurando Informaci[oó]n activa\."/.test(stripComments(restore)),
  "el cartel se emite dentro de maybeRestoreRunningTask, es decir solo al recuperar un job vivo");
ok(!/Restaurando Informaci[oó]n activa\./.test(stripComments(extractFunction(popupCode, "syncFromJob"))),
  "syncFromJob no lo emite: la reanudacion silenciosa no muestra cartel");
// btn-close-settings aparece ANTES que btn-refresh-list en el archivo, asi que
// el slice tiene que arrancar en el refresh y correr hacia adelante.
const refreshBtn = popupCode.slice(
  popupCode.indexOf('btn-refresh-list'),
  popupCode.indexOf('btn-refresh-list') + 1600
);
// El cliente lo pidio explicito: este boton SI recarga la pestana del store. Lo
// que se elimino fue la descarga de la lista de emails, no el reload.
ok(/chrome\.tabs\.reload/.test(refreshBtn),
  "el boton de refrescar recarga la pestana del store (pedido explicito)");
ok(!/getAllowedUsers/.test(refreshBtn), "pero ya no descarga la lista de emails para eso");
ok(/pingTab\(storeTab\.id\)/.test(refreshBtn), "espera a que el content script vuelva a responder tras el reload");

console.log("\n7b) El nombre que va al buscador se limpia (content.js)");
const N = new Function([
  extractFunction(contentSrc, "tokNorm"),
  extractFunction(contentSrc, "tokExpandAbrev"),
  extractFunction(contentSrc, "tokCleanName"),
  "const TOK_STOP = new Set([]);",
  "return { tokNorm, tokExpandAbrev, tokCleanName };",
].join("\n\n"))();

// "alf." abreviado: el store lo escribe "alfajor" completo.
ok(N.tokCleanName("AGUILA ALF. DORADO x50 G") === "aguila alfajor dorado 50g",
  'tokCleanName expande "ALF." a "alfajor"');
ok(N.tokCleanName("ALFAJOR DORADO x50 G") === "alfajor dorado 50g",
  "un nombre ya escrito completo no se toca");
ok(N.tokCleanName("ALFAJ DORADO") === "alfajor dorado", "tambien expande la forma «alfaj»");
ok(N.tokCleanName("ALFAJORA DORADO") === "alfajora dorado",
  "no parte palabras que arrancan con alf pero no son abreviaturas");

// Palabras duplicadas: el PDF del cliente las trae repetidas.
ok(N.tokCleanName("AGUILA ALF. DORADO x50 G DORADO") === "aguila alfajor dorado 50g",
  "la palabra repetida al final del nombre se elimina");
ok(N.tokCleanName("GOMITAS FRUTALES x25 G FRUTALES") === "gomitas frutales 25g",
  "la repeticion separada por el gramaje tambien se elimina");
ok(N.tokCleanName("GALLETAS x12 G") === "galletas 12g", "no rompe los nombres simples");
ok(N.tokCleanName("GOMITAS T") === "gomitas", "sigue sacando letras sueltas del OCR");
ok(N.tokCleanName("TOFI x40 G") === "tofi 40g", "sigue colapsando el pack a su gramaje");

console.log("\n8) El match de gramaje: 75g del pedido contra 75.5G del store");
const M = new Function([
  extractFunction(contentSrc, "tokGramEq"),
  extractFunction(contentSrc, "tokGrams"),
  extractFunction(contentSrc, "tokGramsExact"),
  "return { tokGramEq, tokGrams, tokGramsExact };",
].join("\n\n"))();

// La tolerancia elegida: misma parte entera.
ok(M.tokGramEq(75, 75.5), "75 contra 75.5 se acepta (el caso que reportaste)");
ok(M.tokGramEq(75, 74.9), "75 contra 74.9 se acepta (ruido de OCR en el borde)");
ok(M.tokGramEq(1000, 999.5), "1000 contra 999.5 se acepta");
ok(!M.tokGramEq(75, 76), "75 contra 76 se rechaza: es otro producto");
ok(!M.tokGramEq(50, 69), "50 contra 69 se rechaza");

ok(M.tokGramsExact("Galletitas 75 g", "Alfajor Aguila Dorado x 75.5gr ARC-123").ok,
  "tokGramsExact acepta un pedido de 75 g contra una card que dice 75.5gr");
ok(!M.tokGramsExact("AGUILA ALF. DORADO x50 G", "Alfajor Aguila Minitorta Clásica x 69gr").ok,
  "sigue rechazando sabor y gramaje distintos (Minitorta 69gr) como debe");
ok(!M.tokGramsExact("Galletitas 50 g", "Alfajor Aguila Dorado x 75.5gr").ok,
  "50 g contra 75.5 g NO se acepta: ahi si son dos productos distintos");

// Kilos: antes "1 kg" valia 1 y nunca matcheaba "1000 g".
ok(JSON.stringify(M.tokGrams("Caja x 1 kg")) === "[1000]", "tokGrams convierte 1 kg a 1000 g");
ok(JSON.stringify(M.tokGrams("Pack 2 x 2,5kg")) === "[2500]", "tokGrams lee 2,5kg como 2500 g");
ok(M.tokGramsExact("Caja x 1 kg", "Producto 1000 g").ok, "1 kg del pedido reconcilia contra 1000 g del store");
ok(M.tokGramsExact("Caja x 2kg", "Caja 4x2kg").ok, "un pack 4x2kg (8000 g) cubre un pedido de 2 kg");
ok(M.tokGramsExact("Galletas 40 g", "Galletas 18x40g").ok, "pack 18x40g contra pedido 40 g");
ok(!M.tokGramsExact("Galletas 40 g", "Galletas x 720g").ok,
  'un total suelto tipo "x 720g" NO se resuelve: la card no declara de quantas unidades es');
ok(!M.tokGramsExact("Galletas 40 g", "Galletas 3x2kg").ok, "un pack de 6 kg NO reconcilia contra 40 g");

console.log("\n9) El codigo ARC manda: la card por codigo no se puede vetar por texto");
// El cliente reporto que el 13331 es la UNICA card del store y no se elegia.
// El ARC que publica el store es la identidad del producto, asi que si coincide
// con el codigo del pedido la card se carga aunque no publique el nombre o el
// gramaje. Ese es el comportamiento de v2.0.70, que es el que funciona.
ok(/const codePool = codePoolConUnidad\.length \? codePoolConUnidad : codePool0;/.test(contentSrc),
  "el pool por codigo no filtra por texto: manda el ARC, como en v2.0.70");
ok(!/byCode\.filter\(\(p\) => p\.strict/.test(contentSrc),
  "ya no se le exige nombre ni gramaje a la card localizada por codigo");
ok(/for \(const p of codePool\)[\s\S]*tokDiagPush\("warn"/.test(contentSrc),
  "si el texto no coincide se AVISA en el diagnostico, pero no se bloquea la carga");
ok(/parsed\.filter\(\(p\) => comboOk\(p\) && p\.strict && \(p\.shared > 0 \|\| \(p\.isNoStock/.test(contentSrc),
  "el pool por nombre sigue exigiendo el match estricto completo (gramaje incluido)");
ok(/if \(best && !best\.codeMatch && targetCore\.length\)/.test(contentSrc) &&
   /best\.score < 0\.55/.test(contentSrc),
  "sigue el control de v2.0.66: el fallback por nombre exige ARC y score >= 0.55");

console.log("\n9b) Combo y card real comparten codigo: gana la que tiene la unidad pedida");
// Reportado: el 9919 devolvia el combo y la card correcta era la que tenia el
// boton de la unidad de venta que pide el pedido. Los combos no tienen botones de
// unidad con nombre, y ademas un combo SOLO se pide con su propio codigo "C###".
ok(/const skuIsCombo = !!tokComboSku\(sku\);/.test(contentSrc), "se detecta si el pedido es un combo");
ok(/parsed\.filter\(\(p\) => p\.codeMatch && \(skuIsCombo \|\| !p\.isComboCard\)\)/.test(contentSrc),
  "si el pedido NO es combo, una card de combo queda fuera aunque traiga su codigo");
ok(/const comboCode = \(String\(t\)\.match\(\/\\bC\\d\{2,\}\\b\/\) \|\| \[""\]\)\[0\];/.test(contentSrc),
  "una card se marca como combo si declara el codigo fijo C### que muestra el store");
ok(/const isComboCard = !!comboCode && btns\.length === 0;/.test(contentSrc),
  "combo exige codigo C### Y ningun boton de unidad: una card real nunca se toma por combo");
ok(/const comboOk = \(p\) => skuIsCombo \|\| !p\.isComboCard;/.test(contentSrc),
  "si el pedido no es combo, las cards de combo quedan fuera tambien del fallback por nombre");
ok(/parsed\.filter\(\(p\) => comboOk\(p\) && p\.strict/.test(contentSrc),
  "el fallback por nombre aplica el mismo filtro de combo");
ok(/const offersWant = !!wantType && btns\.some/.test(contentSrc),
  "se marca si la card ofrece el boton de la unidad que pide el pedido");
ok(/wantType \? codePool0\.filter\(\(p\) => p\.offersWant\) : \[\]/.test(contentSrc),
  "si alguna card por codigo tiene esa unidad, se quedan solo esas");
ok(/\(p\.offersWant && !best\.offersWant\)/.test(contentSrc),
  "a igualdad de codigo gana la card que ofrece la unidad pedida");

console.log("\n9d) El tope de stock y la sugerencia se hablan en la MISMA unidad");
// Reportado: "tope 800 < pedido 10 Display" seguido de "Cargala a mano: 6 Display",
// un 6 que no se podia reconstruir. La causa: el factor de conversion se dividia
// siempre, incluso con la unidad del store IGUAL a la pedida, y ahi el paréntesis
// con el puente de unidades se perdia.
ok(/const mismaUnidad = tokNorm\(usedUnit\) === tokNorm\(wantUnit\);/.test(contentSrc),
  "se distingue si la unidad del store es la misma que la pedida, comparando NORMALIZADO");
ok(/const factor = mismaUnidad \? 1 : conv;/.test(contentSrc),
  "si la unidad es la misma, el factor es 1: dividir por conv ahi daba 0");
ok(/out\.sugUnit = mismaUnidad \? wantUnit : usedUnit;/.test(contentSrc) &&
   /out\.sugQty = mismaUnidad \? took : alcanza;/.test(contentSrc),
  "la sugerencia se expresa en la unidad que el cliente va a tipear");
ok(!/out\.sugTotal = conv > 0 \? alcanza : 0;/.test(contentSrc),
  "ya no se confunden la cantidad del store con la cantidad en la unidad pedida");

console.log("\n9c) Tesseract: los warnings de region diminuta se frenan en el origen");
ok(/textord_min_linesize/.test(agentSrc), "el OCR configura el minimo de linea del core");
ok(/textord_max_noise_size/.test(agentSrc), "y el maximo de ruido, que es el origen del 1x36");
ok(/try \{[\s\S]*worker\.setParameters[\s\S]*\} catch/.test(agentSrc),
  "va en try/catch: si el core no conoce el parametro, el OCR sigue igual");
ok(/canvas\.width < 3 \|\| canvas\.height < 3/.test(agentSrc),
  "ademas sigue el filtro de canvas diminuto en el unico punto por donde pasan las imagenes");
// v2.0.89: el "2x36 vs min width of 3" sale del segmentador de filas del CORE
// (los strings vecinos en el binario son Descdrop / Voverlap / Segmenting
// baseline of %d blobs / Poly2). No se puede tapar desde JS: se probó todo y
// nada lo frenó. Estos tests no verificar que el warning desaparezca, sino que
// no se haya dejado código muerto de las hipótesis que ya se descartaron.
ok(!/BAND_UPSCALE|bandK/.test(agentSrc),
  "el upscale de banda que se probó y NO funcionaba se sacó (duplicaba memoria sin cambiar el aviso)");
ok(!/let band = src;/.test(agentSrc),
  "la banda vuelve a recortarse directo, sin canvas intermedio ampliado");
ok(/const k = scale \/ refineScale;/.test(agentSrc),
  "el mapeo de bboxes quedó sin el /bandK, que era del upscale retirado");
ok(/if \(!_band_has_ink\(band\)\) return \{\};/.test(agentSrc),
  "el filtro de banda sin tinta sigue sobre la banda real");
ok(/Image too small to scale/.test(agentSrc),
  "queda documentado en el código por qué el aviso no se puede|frenar: no para reintentarlo");

console.log("\n10) El log de rechazos no se repite y la espera bajo (content.js)");
const diag = extractFunction(contentSrc, "tokDiagPush");
ok(/last\.sig === sig/.test(stripComments(diag)), "un rechazo identico y consecutivo se colapsa");
ok(/const quien = d && d\.nro != null \? "n" \+ d\.nro/.test(stripComments(diag)),
  "la firma incluye la linea (nro/idx): sin eso dos lineas distintas con el mismo mensaje se fusionaban");
ok(/const sig = phase \+ "\|" \+ quien \+ "\|"/.test(stripComments(diag)),
  "el nro/idx entra en la firma antes del mensaje");
ok(/last\.rep = \(last\.rep \|\| 1\) \+ 1/.test(stripComments(diag)), "las repeticiones se cuentan");
ok(/\(e\.rep \+ 1\)/.test(contentSrc), "el texto del diagnostico muestra cuantas veces se repitio");
const procItem = extractFunction(contentSrc, "tokProcessCurrentItem");
ok(/tokBestArticle\([\s\S]*?\),\s*8000,/.test(stripComments(procItem)), "la espera por query bajo de 20s a 8s");

console.log(bad ? "\nFALLAS: " + bad : "\nOK: cola manual, autorizacion, carteles, gramaje y log de rechazos, correctos");
process.exit(bad ? 1 : 0);
